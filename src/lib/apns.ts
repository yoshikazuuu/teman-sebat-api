// src/lib/apns.ts
import * as jose from "jose";
import apn from "node-apn";
import type { AppEnv } from "../types";

// --- Interfaces ---
interface ApnsConfig {
    keyId: string;
    teamId: string;
    privateKey: string;
    topic: string;
    environment: "development" | "production";
}

export interface ApnsPayload {
    aps: {
        alert?: {
            title?: string;
            subtitle?: string;
            body?: string;
        } | string; // Alert can be a string or object
        sound?: string;
        badge?: number;
        "content-available"?: number; // For background updates (must be 1 if present)
        "mutable-content"?: number; // For Notification Service Extensions (must be 1 if present)
    };
    // Custom data
    notificationType?: string; // Add a type for client routing
    [key: string]: any;
}

export interface ApnsOptions {
    apnsId?: string; // Unique ID for the notification
    priority?: "5" | "10"; // 5 for power considerations, 10 for immediate delivery
    expiration?: number; // UNIX timestamp, 0 for no storage
    collapseId?: string; // For merging notifications
    pushType?: "alert" | "background" | "voip" | "complication" | "fileprovider" | "mdm" | "liveactivity" | "pushtotalk";
}

// --- Helper functions ---
const getApnsServer = (environment: "development" | "production", usePort2197: boolean = false): { hostname: string; port: number } => {
    const hostname = environment === "development"
        ? "api.sandbox.push.apple.com"
        : "api.push.apple.com";

    const port = usePort2197 ? 2197 : 443;
    return { hostname, port };
};

const generateApnsAuthToken = async (config: ApnsConfig): Promise<string> => {
    try {
        // Ensure newline characters are correctly interpreted
        const ecPrivateKey = await jose.importPKCS8(
            config.privateKey.replace(/\\n/g, "\n"),
            "ES256",
        );

        const jwt = await new jose.SignJWT({})
            .setProtectedHeader({
                alg: "ES256",
                kid: config.keyId,
            })
            .setIssuedAt()
            .setIssuer(config.teamId)
            .setExpirationTime('1h') // Apple recommends setting expiration
            .sign(ecPrivateKey);
        return jwt;
    } catch (error: any) {
        console.error("💥 APNS: JWT token generation failed:", error.message);
        throw new Error(`APNS Auth Token generation failed: ${error.message}`);
    }
};

const createApnProvider = (config: ApnsConfig, usePort2197: boolean = false): apn.Provider => {
    // Properly format the private key with line breaks
    const rawKey = config.privateKey;
    let formattedKey = rawKey;

    // If the key doesn't have proper line breaks, format it
    if (!rawKey.includes('\n') || rawKey.split('\n').length <= 2) {
        // Extract header, body, and footer
        const beginMarker = '-----BEGIN PRIVATE KEY-----';
        const endMarker = '-----END PRIVATE KEY-----';

        const beginIndex = rawKey.indexOf(beginMarker);
        const endIndex = rawKey.indexOf(endMarker);

        if (beginIndex !== -1 && endIndex !== -1) {
            const header = beginMarker;
            const footer = endMarker;
            const keyBody = rawKey.substring(beginIndex + beginMarker.length, endIndex).replace(/\s/g, '');

            // Split the key body into 64-character lines
            const lines = [];
            for (let i = 0; i < keyBody.length; i += 64) {
                lines.push(keyBody.substring(i, i + 64));
            }

            formattedKey = [header, ...lines, footer].join('\n');
        }
    }

    const options: any = {
        token: {
            key: formattedKey,
            keyId: config.keyId,
            teamId: config.teamId
        },
        production: config.environment === "production"
    };

    // Use port 2197 if specified
    if (usePort2197) {
        options.port = 2197;
    }

    return new apn.Provider(options);
};

// Generate a UUID for apns-id if not provided
const generateApnsId = (): string => {
    return crypto.randomUUID();
};

// Determine the correct push type based on payload
const determinePushType = (payload: ApnsPayload, explicitType?: string): string => {
    if (explicitType) return explicitType;

    // Background notifications
    if (payload.aps["content-available"] === 1) {
        return "background";
    }

    // Default to alert for user-facing notifications
    return "alert";
};

// Determine priority based on push type and payload
const determinePriority = (pushType: string, payload: ApnsPayload, explicitPriority?: string): number => {
    if (explicitPriority) return parseInt(explicitPriority);

    switch (pushType) {
        case "background":
            return 5; // Background notifications must use priority 5
        case "alert":
            // Use 10 for immediate delivery, 5 for power considerations
            return payload.aps.alert ? 10 : 5;
        default:
            return 10;
    }
};

// Add retry configuration interface
interface RetryConfig {
    maxRetries: number;
    retryDelayMs: number;
    tryPort2197OnFailure: boolean;
}

const defaultRetryConfig: RetryConfig = {
    maxRetries: 2, // Try port 443, then port 2197, then give up
    retryDelayMs: 1000, // 1 second delay between retries
    tryPort2197OnFailure: true,
};

export const sendApnsNotification = async (
    config: ApnsConfig,
    deviceToken: string,
    payload: ApnsPayload,
    authToken: string, // Not needed for node-apn, kept for API compatibility
    options: ApnsOptions = {},
    retryConfig: RetryConfig = defaultRetryConfig,
    startWithPort2197: boolean = false,
): Promise<Response> => {
    const pushType = determinePushType(payload, options.pushType);
    const priority = determinePriority(pushType, payload, options.priority);
    const apnsId = options.apnsId || generateApnsId();

    // Validate payload size (4KB for regular notifications, 5KB for VoIP)
    const payloadString = JSON.stringify(payload);
    const maxSize = pushType === "voip" ? 5120 : 4096;
    if (new TextEncoder().encode(payloadString).length > maxSize) {
        throw new Error(`Payload size exceeds ${maxSize} bytes limit for ${pushType} notifications`);
    }

    // Validate background notification requirements
    if (pushType === "background") {
        if (priority !== 5) {
            throw new Error("Background notifications must use priority 5");
        }
        if (payload.aps["content-available"] !== 1) {
            throw new Error("Background notifications must have content-available set to 1");
        }
    }

    const shortToken = `${deviceToken.substring(0, 5)}...${deviceToken.substring(deviceToken.length - 5)}`;

    // Retry logic with port fallback
    let lastError: any;
    let usePort2197 = startWithPort2197; // Start with the requested port

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        const portText = usePort2197 ? "2197" : "443";

        console.log(`📱 APNS: Sending to ${shortToken} | Type: ${pushType} | Priority: ${priority} | Port: ${portText} | Attempt: ${attempt + 1}/${retryConfig.maxRetries + 1}`);

        try {
            // Create provider for this attempt
            const provider = createApnProvider(config, usePort2197);

            // Create notification
            const notification = new apn.Notification();
            notification.topic = config.topic;
            notification.id = apnsId;
            notification.priority = priority;
            notification.pushType = pushType;

            // Set expiration if provided
            if (options.expiration !== undefined) {
                notification.expiry = Math.floor(options.expiration);
            }

            // Set collapse ID if provided
            if (options.collapseId) {
                if (options.collapseId.length > 64) {
                    throw new Error("apns-collapse-id must not exceed 64 bytes");
                }
                notification.collapseId = options.collapseId;
            }

            // Set the payload - node-apn has different API
            if (typeof payload.aps.alert === 'object' && payload.aps.alert) {
                notification.alert = {
                    title: payload.aps.alert.title || "",
                    body: payload.aps.alert.body || ""
                };
            } else if (typeof payload.aps.alert === 'string') {
                notification.alert = payload.aps.alert;
            }

            if (payload.aps.sound) {
                notification.sound = payload.aps.sound;
            }
            if (payload.aps.badge !== undefined) {
                notification.badge = payload.aps.badge;
            }
            if (payload.aps["content-available"] !== undefined) {
                notification.contentAvailable = payload.aps["content-available"] === 1;
            }
            if (payload.aps["mutable-content"] !== undefined) {
                notification.mutableContent = payload.aps["mutable-content"] === 1;
            }

            // Add custom data
            Object.keys(payload).forEach(key => {
                if (key !== 'aps') {
                    notification.payload[key] = payload[key];
                }
            });

            // Send notification
            const result = await provider.send(notification, deviceToken);

            // Close the provider
            provider.shutdown();

            // Check if successful
            if (result.sent.length > 0) {
                console.log(`✅ APNS: Success for ${shortToken} | ID: ${apnsId} | Port: ${portText}`);

                // Create a Response-like object for compatibility
                return {
                    ok: true,
                    status: 200,
                    statusText: "OK"
                } as unknown as Response;
            } else if (result.failed.length > 0) {
                const failure = result.failed[0];
                const reason = (failure as any).response?.reason || "Unknown";
                const status = (failure as any).status || "Unknown";

                console.error(`❌ APNS: Failed for ${shortToken} | Status: ${status} | Reason: ${reason} | Port: ${portText}`);

                // Create detailed error for specific APNS error codes
                const error = new Error(`APNS Error ${status}: ${reason}`);
                (error as any).apnsReason = reason;
                (error as any).statusCode = status;
                (error as any).deviceToken = deviceToken;
                (error as any).apnsId = apnsId;
                (error as any).port = portText;

                throw error;
            }

        } catch (error: any) {
            lastError = error;

            // If this is an APNS error (not a network error), don't retry
            if (error.apnsReason) {
                console.error(`🚫 APNS: Service error for ${shortToken} | ${error.message} | Port: ${portText}`);
                throw error;
            }

            // Check if this is a network connectivity error that might benefit from port fallback
            const isNetworkError = error.message?.includes('ECONNREFUSED') ||
                error.message?.includes('ENOTFOUND') ||
                error.message?.includes('ETIMEDOUT') ||
                error.message?.includes('network') ||
                error.message?.includes('connection') ||
                error.code === 'ECONNREFUSED';

            console.warn(`⚠️  APNS: Network error for ${shortToken} | ${error.message} | Port: ${portText}`);

            // If we should try the other port and this is a network error, and we haven't tried both ports yet
            if (retryConfig.tryPort2197OnFailure && isNetworkError && attempt < retryConfig.maxRetries) {
                // Toggle to the other port
                if (!usePort2197) {
                    console.log(`🔄 APNS: Retrying ${shortToken} with port 2197...`);
                    usePort2197 = true;
                } else {
                    console.log(`🔄 APNS: Retrying ${shortToken} with port 443...`);
                    usePort2197 = false;
                }
                // Add a small delay before retry
                if (retryConfig.retryDelayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, retryConfig.retryDelayMs));
                }
                continue;
            }

            // If we're out of retries, throw the last error
            if (attempt >= retryConfig.maxRetries) {
                break;
            }

            // Add delay before retry (if not the last attempt)
            if (retryConfig.retryDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, retryConfig.retryDelayMs));
            }
        }
    }

    // If we get here, all retries failed
    console.error(`💥 APNS: All retries exhausted for ${shortToken} | Final error: ${lastError?.message}`);

    // Wrap the final network error
    const wrappedError = new Error(`APNS Network Error (all retries failed): ${lastError?.message || 'Unknown error'}`);
    (wrappedError as any).originalError = lastError;
    (wrappedError as any).deviceToken = deviceToken;
    (wrappedError as any).apnsId = apnsId;
    (wrappedError as any).retriesAttempted = retryConfig.maxRetries + 1;

    throw wrappedError;
};

// --- Generic Notification Sending Function ---
/**
 * Sends a specific APNS payload to a list of device tokens.
 * Handles token generation and concurrent sending.
 * @param env The Cloudflare Worker environment bindings.
 * @param deviceTokens List of device tokens (strings).
 * @param payload The notification payload to send.
 * @param options Optional APNS settings.
 * @param retryConfig Optional retry configuration for network failures.
 * @returns Promise resolving with success and failure counts, plus invalid tokens.
 */
export const sendPushNotifications = async (
    env: AppEnv["Bindings"],
    deviceTokens: string[],
    payload: ApnsPayload,
    options: ApnsOptions = {},
    retryConfig: RetryConfig = defaultRetryConfig,
): Promise<{
    successCount: number;
    failureCount: number;
    invalidTokens: string[];
    errors: Array<{ token: string; error: string; reason?: string }>;
}> => {
    if (!deviceTokens || deviceTokens.length === 0) {
        console.log("📱 APNS: No device tokens provided for notification");
        return { successCount: 0, failureCount: 0, invalidTokens: [], errors: [] };
    }

    console.log(`📱 APNS: Starting batch send to ${deviceTokens.length} device(s) | Environment: ${env.APNS_ENVIRONMENT}`);

    const config: ApnsConfig = {
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        privateKey: Buffer.from(env.APNS_PRIVATE_KEY_BASE64, 'base64').toString('utf-8'),
        topic: env.APPLE_BUNDLE_ID,
        environment: env.APNS_ENVIRONMENT as "development" | "production",
    };

    // Check if we should use port 2197 by default (can be overridden by retryConfig)
    const forcePort2197 = env.APNS_USE_PORT_2197 === "true" || env.APNS_USE_PORT_2197 === "1";
    if (forcePort2197) {
        console.log("🔧 APNS: Using port 2197 by default (APNS_USE_PORT_2197 environment variable set)");
    }

    // Validate essential config
    if (
        !config.keyId ||
        !config.teamId ||
        !config.privateKey ||
        !config.topic
    ) {
        console.error("❌ APNS: Configuration missing in environment variables", {
            keyId: !!config.keyId,
            teamId: !!config.teamId,
            privateKey: !!config.privateKey,
            topic: !!config.topic,
            environment: config.environment,
        });
        return {
            successCount: 0,
            failureCount: deviceTokens.length,
            invalidTokens: [],
            errors: deviceTokens.map(token => ({
                token,
                error: "APNS configuration missing"
            }))
        };
    }

    try {
        // Generate the auth token once for this batch
        const authToken = await generateApnsAuthToken(config);

        // Send notifications concurrently
        const promises = deviceTokens.map((token) => {
            return sendApnsNotification(config, token, payload, authToken, options, retryConfig, forcePort2197);
        });

        // Wait for all promises to settle
        const results = await Promise.allSettled(promises);

        let successCount = 0;
        let failureCount = 0;
        const invalidTokens: string[] = [];
        const errors: Array<{ token: string; error: string; reason?: string }> = [];

        results.forEach((result, index) => {
            const token = deviceTokens[index];
            const shortToken = `${token.substring(0, 5)}...${token.substring(token.length - 5)}`;

            if (result.status === "fulfilled") {
                successCount++;
            } else {
                failureCount++;
                const error = result.reason;

                // Handle specific APNS error reasons
                if (error?.apnsReason) {
                    const reason = error.apnsReason;

                    // Mark tokens as invalid for specific errors
                    if (['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic'].includes(reason)) {
                        invalidTokens.push(token);
                        console.warn(`🚮 APNS: Marking token ${shortToken} as invalid | Reason: ${reason}`);
                    }

                    errors.push({
                        token,
                        error: error.message,
                        reason: reason
                    });
                } else {
                    errors.push({
                        token,
                        error: error?.message || 'Unknown error'
                    });
                }
            }
        });

        // Summary logging
        if (successCount > 0 && failureCount === 0) {
            console.log(`✅ APNS: Batch complete | ${successCount}/${deviceTokens.length} succeeded`);
        } else if (successCount > 0 && failureCount > 0) {
            console.warn(`⚠️  APNS: Batch partial success | ${successCount}/${deviceTokens.length} succeeded, ${failureCount} failed`);
        } else {
            console.error(`❌ APNS: Batch failed | 0/${deviceTokens.length} succeeded, ${failureCount} failed`);
        }

        if (invalidTokens.length > 0) {
            console.warn(`🗑️  APNS: Found ${invalidTokens.length} invalid token(s) that should be removed from database`);
        }

        return { successCount, failureCount, invalidTokens, errors };
    } catch (error) {
        // Catch errors during token generation or other setup
        console.error("💥 APNS: Batch processing failed during setup:", error);
        return {
            successCount: 0,
            failureCount: deviceTokens.length,
            invalidTokens: [],
            errors: deviceTokens.map(token => ({
                token,
                error: `Batch failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            }))
        };
    }
};

/**
 * Sends notifications to multiple devices about a new smoking session.
 * @param env The Cloudflare Worker environment bindings.
 * @param deviceTokens List of device tokens (strings).
 * @param initiator User who started the session.
 * @param sessionId The ID of the new smoking session.
 */
export const notifyFriendsOfSession = async (
    env: AppEnv["Bindings"],
    deviceTokens: string[],
    initiator: { id: number; username: string; fullName?: string | null },
    sessionId: number,
): Promise<{
    successCount: number;
    failureCount: number;
    invalidTokens: string[];
    errors: Array<{ token: string; error: string; reason?: string }>;
}> => {
    const initiatorName = initiator.fullName || initiator.username;

    console.log(`🎯 APNS: Starting session notification | Session: ${sessionId} | Initiator: ${initiatorName} | Recipients: ${deviceTokens.length}`);

    // Construct the specific payload for a new session
    const payload: ApnsPayload = {
        aps: {
            alert: {
                title: "Nongki Session Started",
                body: `${initiatorName} has started a nongki session!`,
            },
            sound: "default",
            // badge: 1, // Badge handling is complex, often better client-side
        },
        // Custom data
        notificationType: "new_session", // Identify the notification type
        sessionId: sessionId,
        initiatorId: initiator.id,
        initiatorUsername: initiator.username,
    };

    // Use alert push type with immediate priority for user engagement
    const options: ApnsOptions = {
        pushType: "alert",
        priority: "10",
        collapseId: `session_${sessionId}`, // Merge multiple notifications for same session
    };

    // Use the generic sender
    const result = await sendPushNotifications(env, deviceTokens, payload, options);

    console.log(`🎯 APNS: Session notification complete | Session: ${sessionId} | Success: ${result.successCount}/${deviceTokens.length}`);

    return result;
};
