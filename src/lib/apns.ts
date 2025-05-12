// src/lib/apns.ts
import * as jose from "jose";
import type { AppEnv } from "../types";

// --- Interfaces remain the same ---
interface ApnsConfig {
    keyId: string;
    teamId: string;
    privateKey: string;
    topic: string;
    environment: "development" | "production";
}

export interface ApnsPayload {
    aps: {
        alert: {
            title?: string; // Make title optional
            subtitle?: string;
            body: string;
        };
        sound?: string;
        badge?: number;
        "content-available"?: number; // For background updates
        "mutable-content"?: number; // For Notification Service Extensions
    };
    // Custom data
    notificationType?: string; // Add a type for client routing
    [key: string]: any;
}

// --- Helper functions remain the same ---
const getApnsServer = (environment: "development" | "production"): string => {
    return environment === "development"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
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
            // Consider a shorter expiration if generating frequently, but < 1hr is typical
            // .setExpirationTime('1h')
            .sign(ecPrivateKey);
        return jwt;
    } catch (error: any) {
        console.error("Failed to generate APNS auth token:", error);
        throw new Error(`APNS Auth Token generation failed: ${error.message}`);
    }
};

// --- sendApnsNotification remains the same ---
export const sendApnsNotification = async (
    config: ApnsConfig,
    deviceToken: string,
    payload: ApnsPayload,
    authToken: string,
): Promise<Response> => {
    const server = getApnsServer(config.environment);
    const url = `${server}/3/device/${deviceToken}`;
    const headers = {
        authorization: `bearer ${authToken}`,
        "apns-topic": config.topic,
        "apns-push-type": payload.aps["content-available"] ? "background" : "alert", // Adjust push type
        "apns-priority": "10", // Use 5 for lower priority if needed (e.g., background)
        "Content-Type": "application/json",
    };

    const shortToken = `${deviceToken.substring(0, 5)}...${deviceToken.substring(deviceToken.length - 5)}`;
    console.log(`Sending APNS to ${shortToken}`);
    // console.log(`APNS Payload: ${JSON.stringify(payload)}`); // Uncomment for deep debugging

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const responseBody = await response.text();
            const reason = responseBody ? JSON.parse(responseBody)?.reason : "Unknown";
            console.error(
                `APNS request failed for token ${shortToken}: ${response.status} ${response.statusText} - Reason: ${reason}`,
                // responseBody, // Log full body if needed
            );
            // Propagate a more informative error
            throw new Error(
                `APNS Error ${response.status}: ${reason || response.statusText}`,
            );
        }

        console.log(`APNS Success for token ${shortToken}: ${response.status}`);
        return response;
    } catch (error: any) {
        console.error(`APNS fetch failed for token ${shortToken}:`, error);
        // Re-throw the error so Promise.allSettled catches it correctly
        throw error;
    }
};

// --- Generic Notification Sending Function ---
/**
 * Sends a specific APNS payload to a list of device tokens.
 * Handles token generation and concurrent sending.
 * @param env The Cloudflare Worker environment bindings.
 * @param deviceTokens List of device tokens (strings).
 * @param payload The notification payload to send.
 * @returns Promise resolving with success and failure counts.
 */
export const sendPushNotifications = async (
    env: AppEnv["Bindings"],
    deviceTokens: string[],
    payload: ApnsPayload,
): Promise<{ successCount: number; failureCount: number }> => {
    if (!deviceTokens || deviceTokens.length === 0) {
        console.log("No device tokens provided for notification.");
        return { successCount: 0, failureCount: 0 };
    }

    const config: ApnsConfig = {
        keyId: env.APNS_KEY_ID,
        teamId: env.APNS_TEAM_ID,
        privateKey: env.APNS_PRIVATE_KEY,
        topic: env.APPLE_BUNDLE_ID,
        environment: env.APNS_ENVIRONMENT,
    };

    // Validate essential config
    if (
        !config.keyId ||
        !config.teamId ||
        !config.privateKey ||
        !config.topic
    ) {
        console.error(
            "APNS configuration missing in environment variables.",
            // Avoid logging the private key itself
            {
                keyId: !!config.keyId,
                teamId: !!config.teamId,
                privateKey: !!config.privateKey,
                topic: !!config.topic,
                environment: config.environment,
            },
        );
        // Return failure for all tokens as we cannot proceed
        return { successCount: 0, failureCount: deviceTokens.length };
    }

    try {
        // Generate the auth token once for this batch
        const authToken = await generateApnsAuthToken(config);

        // Send notifications concurrently
        const promises = deviceTokens.map((token) =>
            sendApnsNotification(config, token, payload, authToken),
        );

        // Wait for all promises to settle
        const results = await Promise.allSettled(promises);

        let successCount = 0;
        let failureCount = 0;
        const failedTokens: string[] = [];

        results.forEach((result, index) => {
            const token = deviceTokens[index];
            const shortToken = `${token.substring(0, 5)}...${token.substring(token.length - 5)}`;
            if (result.status === "fulfilled") {
                successCount++;
            } else {
                failureCount++;
                failedTokens.push(token); // Collect failed tokens
                console.error(
                    `Failed to send APNS to token ${shortToken}:`,
                    result.reason,
                );
                // TODO: Handle specific APNS errors like 'BadDeviceToken'
                // Consider adding logic here to queue the token for removal from the DB
                // if (result.reason instanceof Error && result.reason.message.includes('BadDeviceToken')) {
                //   console.log(`Marking token ${shortToken} as invalid.`);
                //   // Add to a list or emit an event to handle DB removal
                // }
            }
        });

        console.log(
            `APNS Batch Send Results: ${successCount} succeeded, ${failureCount} failed.`,
        );
        if (failureCount > 0) {
            console.log("Failed tokens (first 5):", failedTokens.slice(0, 5));
        }
        return { successCount, failureCount };
    } catch (error) {
        // Catch errors during token generation or other setup
        console.error("Failed to send APNS notifications batch:", error);
        return { successCount: 0, failureCount: deviceTokens.length };
    }
};

// --- notifyFriendsOfSession remains the same ---
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
): Promise<{ successCount: number; failureCount: number }> => {
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

    // Use the generic sender
    return sendPushNotifications(env, deviceTokens, payload);
};
