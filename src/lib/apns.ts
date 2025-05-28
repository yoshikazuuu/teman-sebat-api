// src/lib/apns.ts
import * as jose from "jose";
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
const getApnsServer = (environment: "development" | "production", usePort2197: boolean = false): string => {
    const baseServer = environment === "development"
        ? "api.sandbox.push.apple.com"
        : "api.push.apple.com";

    const port = usePort2197 ? "2197" : "443";
    return `https://${baseServer}:${port}`;
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
        console.error("Failed to generate APNS auth token:", error);
        throw new Error(`APNS Auth Token generation failed: ${error.message}`);
    }
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
const determinePriority = (pushType: string, payload: ApnsPayload, explicitPriority?: string): string => {
    if (explicitPriority) return explicitPriority;

    switch (pushType) {
        case "background":
            return "5"; // Background notifications must use priority 5
        case "alert":
            // Use 10 for immediate delivery, 5 for power considerations
            return payload.aps.alert ? "10" : "5";
        default:
            return "10";
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
    authToken: string,
    options: ApnsOptions = {},
    retryConfig: RetryConfig = defaultRetryConfig,
    startWithPort2197: boolean = false,
): Promise<Response> => {
    const pushType = determinePushType(payload, options.pushType);
    const priority = determinePriority(pushType, payload, options.priority);
    const apnsId = options.apnsId || generateApnsId();

    // Build headers according to Apple's specification
    const headers: Record<string, string> = {
        "authorization": `bearer ${authToken}`,
        "apns-topic": config.topic,
        "apns-push-type": pushType,
        "apns-priority": priority,
        "apns-id": apnsId,
        "Content-Type": "application/json",
    };

    // Add optional headers
    if (options.expiration !== undefined) {
        headers["apns-expiration"] = options.expiration.toString();
    }

    if (options.collapseId) {
        if (options.collapseId.length > 64) {
            throw new Error("apns-collapse-id must not exceed 64 bytes");
        }
        headers["apns-collapse-id"] = options.collapseId;
    }

    // Validate payload size (4KB for regular notifications, 5KB for VoIP)
    const payloadString = JSON.stringify(payload);
    const maxSize = pushType === "voip" ? 5120 : 4096;
    if (new TextEncoder().encode(payloadString).length > maxSize) {
        throw new Error(`Payload size exceeds ${maxSize} bytes limit for ${pushType} notifications`);
    }

    // Validate background notification requirements
    if (pushType === "background") {
        if (priority !== "5") {
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
        const server = getApnsServer(config.environment, usePort2197);
        const url = `${server}/3/device/${deviceToken}`;
        const portText = usePort2197 ? "2197" : "443";

        console.log(`Sending APNS to ${shortToken} (type: ${pushType}, priority: ${priority}, id: ${apnsId}, port: ${portText}, attempt: ${attempt + 1})`);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: headers,
                body: payloadString,
            });

            if (!response.ok) {
                const responseBody = await response.text();
                let reason = "Unknown";
                try {
                    const errorData = JSON.parse(responseBody);
                    reason = errorData.reason || reason;
                } catch {
                    // If response body is not JSON, use status text
                    reason = response.statusText;
                }

                console.error(
                    `APNS request failed for token ${shortToken} (port ${portText}): ${response.status} ${response.statusText} - Reason: ${reason}`,
                );

                // Create detailed error for specific APNS error codes
                const error = new Error(`APNS Error ${response.status}: ${reason}`);
                (error as any).apnsReason = reason;
                (error as any).statusCode = response.status;
                (error as any).deviceToken = deviceToken;
                (error as any).apnsId = apnsId;
                (error as any).port = portText;

                throw error;
            }

            console.log(`APNS Success for token ${shortToken}: ${response.status} (id: ${apnsId}, port: ${portText})`);
            return response;
        } catch (error: any) {
            lastError = error;

            // If this is an APNS error (not a network error), don't retry
            if (error.apnsReason) {
                console.error(`APNS error for token ${shortToken} (port ${portText}): ${error.message}`);
                throw error;
            }

            // Check if this is a network connectivity error that might benefit from port fallback
            const isNetworkError = error.message?.includes('Malformed_HTTP_Response') ||
                error.message?.includes('fetch') ||
                error.message?.includes('network') ||
                error.message?.includes('connection') ||
                error.code === 'Malformed_HTTP_Response';

            console.error(`APNS fetch failed for token ${shortToken} (port ${portText}):`, error.message || error);

            // If we should try the other port and this is a network error, and we haven't tried both ports yet
            if (retryConfig.tryPort2197OnFailure && isNetworkError && attempt < retryConfig.maxRetries) {
                // Toggle to the other port
                if (!usePort2197) {
                    console.log(`Retrying with port 2197 for token ${shortToken}...`);
                    usePort2197 = true;
                } else {
                    console.log(`Retrying with port 443 for token ${shortToken}...`);
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
    console.error(`All APNS retry attempts failed for token ${shortToken}`);

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
        console.log("No device tokens provided for notification.");
        return { successCount: 0, failureCount: 0, invalidTokens: [], errors: [] };
    }

    const config: ApnsConfig = {
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        privateKey: env.APNS_PRIVATE_KEY,
        topic: env.APPLE_BUNDLE_ID,
        environment: env.APNS_ENVIRONMENT as "development" | "production",
    };

    // Check if we should use port 2197 by default (can be overridden by retryConfig)
    const forcePort2197 = env.APNS_USE_PORT_2197 === "true" || env.APNS_USE_PORT_2197 === "1";
    if (forcePort2197) {
        console.log("Using APNS port 2197 by default (APNS_USE_PORT_2197 environment variable set)");
    }

    // Validate essential config
    if (
        !config.keyId ||
        !config.teamId ||
        !config.privateKey ||
        !config.topic
    ) {
        console.error(
            "APNS configuration missing in environment variables.",
            {
                keyId: !!config.keyId,
                teamId: !!config.teamId,
                privateKey: !!config.privateKey,
                topic: !!config.topic,
                environment: config.environment,
            },
        );
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
                        console.log(`Marking token ${shortToken} as invalid (reason: ${reason})`);
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

                console.error(
                    `Failed to send APNS to token ${shortToken}:`,
                    error?.message || error,
                );
            }
        });

        console.log(
            `APNS Batch Send Results: ${successCount} succeeded, ${failureCount} failed.`,
        );
        if (failureCount > 0) {
            console.log(`Failed tokens (first 5): ${invalidTokens.slice(0, 5).map(t =>
                `${t.substring(0, 5)}...${t.substring(t.length - 5)}`).join(', ')}`);
        }
        if (invalidTokens.length > 0) {
            console.log(`Invalid tokens found: ${invalidTokens.length} (should be removed from database)`);
        }

        return { successCount, failureCount, invalidTokens, errors };
    } catch (error) {
        // Catch errors during token generation or other setup
        console.error("Failed to send APNS notifications batch:", error);
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
    // Construct the specific payload for a new session
    const initiatorName = initiator.fullName || initiator.username;
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
    return sendPushNotifications(env, deviceTokens, payload, options);
};
