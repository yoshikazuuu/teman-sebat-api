// src/routes/auth.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppContext, AppEnv } from "../types";
import { users } from "../db/schema";
// Import functions from the new auth library
import { verifyAppleToken, generateAuthToken } from "../lib/auth";

// Apple Sign-In validation schema
const appleAuthSchema = z.object({
    idToken: z.string().min(1),
    firstName: z.string().optional().nullable(),
    lastName: z.string().optional().nullable(),
    email: z.string().email().optional().nullable(),
});

// Create a router instance
const app = new Hono<AppEnv>();

// Apple Sign In endpoint
app.post(
    "/apple",
    zValidator("json", appleAuthSchema),
    async (c) => {
        const { idToken, firstName, lastName, email } = c.req.valid("json");
        const db = c.get("db");
        const appleBundleId = c.env.APPLE_BUNDLE_ID;
        const jwtSecret = c.env.JWT_SECRET;

        if (!appleBundleId) {
            console.error("APPLE_BUNDLE_ID environment variable is not set.");
            return c.json(
                { success: false, error: "Server configuration error" },
                500,
            );
        }
        if (!jwtSecret) {
            console.error("JWT_SECRET environment variable is not set.");
            return c.json(
                { success: false, error: "Server configuration error" },
                500,
            );
        }

        try {
            // --- Verify the Apple ID Token ---
            const applePayload = await verifyAppleToken(idToken, appleBundleId);

            // Extract the unique Apple User ID ('sub' claim)
            const appleUserId = applePayload.sub;
            if (!appleUserId) {
                throw new Error("Apple token 'sub' claim is missing.");
            }

            // Extract email from token if available and verified
            // Note: The email from the token payload is generally more reliable than the one
            // passed alongside the token, especially if email_verified is true.
            const tokenEmail =
                applePayload.email && applePayload.email_verified
                    ? (applePayload.email as string)
                    : null;

            // Use the email from the token if available, otherwise fallback to the request body email
            const userEmail = tokenEmail ?? email;

            // --- Find or Create User ---
            const existingUser = await db.query.users.findFirst({
                where: eq(users.appleId, appleUserId),
            });

            let userId: number;
            let isNewUser = false;

            if (existingUser) {
                // User exists, update their info if needed (especially if email was missing before)
                userId = existingUser.id;
                const updates: Partial<typeof users.$inferInsert> = {};
                const currentFullName =
                    firstName && lastName ? `${firstName} ${lastName}` : null;

                // Update name only if provided AND different or missing
                if (
                    currentFullName &&
                    currentFullName !== existingUser.fullName
                ) {
                    updates.fullName = currentFullName;
                }
                // Update email only if a new valid email is available and wasn't set before
                if (userEmail && !existingUser.email) {
                    updates.email = userEmail;
                }

                if (Object.keys(updates).length > 0) {
                    await db.update(users).set(updates).where(eq(users.id, userId));
                }
            } else {
                // --- Create New User ---
                isNewUser = true;
                const fullName =
                    firstName && lastName ? `${firstName} ${lastName}` : null;

                // Generate a unique username
                // Prioritize email, then fallback to a random string
                let usernameBase = "";
                if (userEmail) {
                    usernameBase = userEmail.split("@")[0];
                } else if (fullName) {
                    // Create a simple username from the name if email is unavailable
                    usernameBase = fullName.replace(/\s+/g, "_").toLowerCase();
                } else {
                    usernameBase = `user_${Math.random()
                        .toString(36)
                        .substring(2, 10)}`;
                }

                let username = usernameBase;
                let attempt = 0;
                // Ensure username uniqueness
                while (
                    await db.query.users.findFirst({ where: eq(users.username, username) })
                ) {
                    attempt++;
                    username = `${usernameBase}_${attempt}`;
                    if (attempt > 5) {
                        // Fallback to more randomness if simple increment fails
                        username = `${usernameBase}_${Math.random()
                            .toString(36)
                            .substring(2, 6)}`;
                    }
                }

                // Insert the new user
                const result = await db
                    .insert(users)
                    .values({
                        username,
                        appleId: appleUserId, // Store the verified Apple User ID
                        fullName,
                        email: userEmail, // Store the verified email if available
                    })
                    .returning({ id: users.id });

                if (!result || result.length === 0) {
                    throw new Error("Failed to create new user account.");
                }
                userId = result[0].id;
            }

            // --- Generate Application JWT ---
            const appTokenPayload = { id: userId };
            const authToken = await generateAuthToken(appTokenPayload, jwtSecret);

            // --- Response ---
            // This format should be consumable by the Swift app.
            // It provides the necessary session token and user ID.
            return c.json({
                success: true,
                token: authToken, // Your application's session token
                userId: userId,
                isNewUser: isNewUser, // Optionally inform the client if it's a new user
            });
        } catch (error: any) {
            console.error("Apple Sign In Error:", error);
            // Handle specific verification errors (like invalid token) with 401
            if (error.message.includes("Apple token verification failed")) {
                return c.json(
                    { success: false, error: "Invalid Apple token" },
                    401,
                );
            }
            return c.json(
                { success: false, error: "Authentication failed" },
                500,
            );
        }
    },
);

// Export the Hono app instance for this route
export default app;
