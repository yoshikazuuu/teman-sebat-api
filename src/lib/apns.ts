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
    // ... (implementation unchanged)
    return environment === "development"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
};

const generateApnsAuthToken = async (config: ApnsConfig): Promise<string> => {
    // ... (implementation unchanged)
    try {
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
    // ... (implementation unchanged)
    const server = getApnsServer(config.environment);
    const url = `${server}/3/device/${deviceToken}`;
    const headers = {
        authorization: `bearer ${authToken}`,
        "apns-topic": config.topic,
        "apns-push-type": payload.aps["content-available"] ? "background" : "alert", // Adjust push type
        "apns-priority": "10",
        "Content-Type": "application/json",
    };

    console.log(`Sending APNS to ${deviceToken.substring(0, 10)}...`);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const responseBody = await response.text();
            console.error(
                `APNS request failed for token ${deviceToken.substring(0, 10)}...: ${response.status} ${response.statusText}`,
                responseBody,
            );
            throw new Error(
                `APNS Error ${response.status}: ${responseBody || response.statusText}`,
            );
        }
        console.log(
            `APNS Success for token ${deviceToken.substring(0, 10)}...: ${response.status}`,
        );
        return response;
    } catch (error: any) {
        console.error(
            `APNS fetch failed for token ${deviceToken.substring(0, 10)}...:`,
            error,
        );
        throw error;
    }
};

// --- NEW: Generic Notification Sending Function ---
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
            config,
        );
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

        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                successCount++;
            } else {
                failureCount++;
                console.error(
                    `Failed to send APNS to token index ${index} (${deviceTokens[index].substring(0, 10)}...):`,
                    result.reason,
                );
                // TODO: Handle specific APNS errors like 'BadDeviceToken'
                // if (result.reason.message.includes('BadDeviceToken')) { /* remove token */ }
            }
        });

        console.log(
            `APNS Batch Send Results: ${successCount} succeeded, ${failureCount} failed.`,
        );
        return { successCount, failureCount };
    } catch (error) {
        // Catch errors during token generation or other setup
        console.error("Failed to send APNS notifications batch:", error);
        return { successCount: 0, failureCount: deviceTokens.length };
    }
};

// --- Update notifyFriendsOfSession to use the generic function ---
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
                title: "Smoking Session Started",
                body: `${initiatorName} has started a smoking session!`,
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
