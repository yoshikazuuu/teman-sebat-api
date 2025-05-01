// src/lib/apns.ts
import * as jose from "jose";
import type { AppEnv } from "../types"; // Assuming types.ts is in the parent directory

// Define the structure for APNS configuration
interface ApnsConfig {
    keyId: string;
    teamId: string;
    privateKey: string;
    topic: string; // Your app's bundle ID
    environment: "development" | "production";
}

// Define the structure for the notification payload
interface ApnsPayload {
    aps: {
        alert: {
            title: string;
            body: string;
        };
        sound?: string;
        badge?: number;
        // Add other APS keys as needed (e.g., 'content-available', 'mutable-content')
    };
    // Add custom data outside the 'aps' dictionary
    [key: string]: any;
}

// Determine the correct APNS server URL based on environment
const getApnsServer = (environment: "development" | "production"): string => {
    return environment === "development"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
};

/**
 * Generates an APNS authentication token (JWT).
 * These tokens are valid for a maximum of one hour.
 * @param config APNS configuration details.
 * @returns The generated JWT string.
 * @throws {Error} If private key import or signing fails.
 */
const generateApnsAuthToken = async (config: ApnsConfig): Promise<string> => {
    try {
        // Import the private key in PKCS8 format
        // Ensure the APNS_PRIVATE_KEY env var contains the key content,
        // potentially replacing literal '\n' with actual newlines if needed.
        const ecPrivateKey = await jose.importPKCS8(
            config.privateKey.replace(/\\n/g, "\n"), // Handle potential newline literals
            "ES256",
        );

        // Create the JWT
        const jwt = await new jose.SignJWT({})
            .setProtectedHeader({
                alg: "ES256",
                kid: config.keyId, // Your APNS Key ID
            })
            .setIssuedAt()
            .setIssuer(config.teamId) // Your Team ID
            // .setExpirationTime('1h') // Optional: Set expiration (max 1 hour)
            // APNS tokens don't strictly require 'exp', they expire automatically.
            // Let's omit it for simplicity unless needed.
            .sign(ecPrivateKey);

        return jwt;
    } catch (error: any) {
        console.error("Failed to generate APNS auth token:", error);
        throw new Error(`APNS Auth Token generation failed: ${error.message}`);
    }
};

/**
 * Sends a single push notification to APNS.
 * @param config APNS configuration.
 * @param deviceToken The target device token.
 * @param payload The notification payload.
 * @param authToken The pre-generated APNS JWT.
 * @returns Promise resolving on success, rejecting on failure.
 */
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
        "apns-push-type": "alert", // Use 'background' for silent notifications
        "apns-priority": "10", // 5 for power-saving, 10 for immediate
        // 'apns-expiration': '0', // Optional: 0 means discard immediately if undeliverable
        "Content-Type": "application/json",
    };

    console.log(`Sending APNS to ${deviceToken.substring(0, 10)}...`); // Log truncated token

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(payload),
        });

        // Check for non-successful responses
        if (!response.ok) {
            const responseBody = await response.text();
            console.error(
                `APNS request failed for token ${deviceToken.substring(0, 10)}...: ${response.status} ${response.statusText}`,
                responseBody,
            );
            // Throw an error to be caught by Promise.allSettled
            throw new Error(
                `APNS Error ${response.status}: ${responseBody || response.statusText}`,
            );
        }

        console.log(
            `APNS Success for token ${deviceToken.substring(0, 10)}...: ${response.status}`,
        );
        return response; // Return the successful response object
    } catch (error: any) {
        console.error(
            `APNS fetch failed for token ${deviceToken.substring(0, 10)}...:`,
            error,
        );
        // Re-throw the error to be caught by Promise.allSettled
        throw error;
    }
};

/**
 * Sends notifications to multiple devices about a new smoking session.
 * Handles token generation and concurrent sending.
 * @param env The Cloudflare Worker environment bindings.
 * @param deviceTokens List of device tokens (strings).
 * @param initiator User who started the session.
 * @param sessionId The ID of the new smoking session.
 */
export const notifyFriendsOfSession = async (
    env: AppEnv["Bindings"],
    deviceTokens: string[],
    initiator: { username: string; fullName?: string | null },
    sessionId: number,
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
        console.log(config)
        console.error("APNS configuration missing in environment variables.");
        return { successCount: 0, failureCount: deviceTokens.length };
    }

    try {
        // Generate the auth token once for this batch
        const authToken = await generateApnsAuthToken(config);

        // Construct the notification payload
        const initiatorName = initiator.fullName || initiator.username;
        const payload: ApnsPayload = {
            aps: {
                alert: {
                    title: "Smoking Session Started",
                    body: `${initiatorName} has started a smoking session!`,
                },
                sound: "default",
                // You might want to increment the badge count on the client side
                // badge: 1,
            },
            // Custom data for the client app to handle
            sessionId: sessionId,
            initiatorUsername: initiator.username,
        };

        // Send notifications concurrently
        const promises = deviceTokens.map((token) =>
            sendApnsNotification(config, token, payload, authToken),
        );

        // Wait for all promises to settle (either resolve or reject)
        const results = await Promise.allSettled(promises);

        let successCount = 0;
        let failureCount = 0;

        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                successCount++;
            } else {
                failureCount++;
                // Log specific error for the failed token
                console.error(
                    `Failed to send APNS to token index ${index} (${deviceTokens[index].substring(0, 10)}...):`,
                    result.reason,
                );
                // TODO: Handle specific APNS errors like 'BadDeviceToken'
                // You might want to remove invalid tokens from your database here.
                // Example: if (result.reason.message.includes('BadDeviceToken')) { /* remove token */ }
            }
        });

        console.log(
            `APNS Notification Results: ${successCount} succeeded, ${failureCount} failed.`,
        );
        return { successCount, failureCount };
    } catch (error) {
        // Catch errors during token generation or other setup
        console.error("Failed to send APNS notifications:", error);
        return { successCount: 0, failureCount: deviceTokens.length };
    }
};
