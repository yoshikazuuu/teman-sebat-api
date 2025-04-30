// src/routes/auth.ts
import { Hono } from "hono";
import { jwt, sign } from "hono/jwt";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { AppContext, AppEnv } from "../types";
import { users } from "../db/schema";
import type { JwtVariables } from 'hono/jwt';

// Export the type that includes JWT variables
export type AppJwtVariables = JwtVariables;

// Apple Sign-In validation schema
const appleAuthSchema = z.object({
    idToken: z.string().min(1),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
});

// Create a JWT middleware that can be exported and reused
export const jwtMiddleware = (c: AppContext, next: any) => {
    const jwtMiddlewareInstance = jwt({
        secret: c.env.JWT_SECRET
    });
    return jwtMiddlewareInstance(c, next);
};

// Create a router instance
const app = new Hono<AppEnv>();

// Apple Sign In endpoint
app.post(
    "/apple",
    zValidator("json", appleAuthSchema),
    async (c) => {
        const { idToken, firstName, lastName, email } = c.req.valid("json");
        const db = c.get("db");

        try {
            // In a real implementation, you would verify the idToken with Apple
            // For this example, we'll assume it's valid

            // Extract user info from the token
            // In reality, you'd decode and verify the JWT from Apple
            const appleUserId = idToken; // This would come from verifying the token

            // Check if user exists
            const existingUser = await db.query.users.findFirst({
                where: eq(users.appleId, appleUserId),
            });

            let userId;

            if (existingUser) {
                // User exists, update their info if needed
                userId = existingUser.id;

                // Update user details if needed
                if (firstName || lastName || (email && !existingUser.email)) {
                    await db
                        .update(users)
                        .set({
                            fullName: firstName && lastName
                                ? `${firstName} ${lastName}`
                                : existingUser.fullName,
                            email: email || existingUser.email,
                        })
                        .where(eq(users.id, userId));
                }
            } else {
                // Create new user
                const fullName = firstName && lastName ? `${firstName} ${lastName}` : null;

                // Generate a unique username based on email or a random string
                let username = "";
                if (email) {
                    username = email.split('@')[0];
                } else {
                    username = `user_${Math.random().toString(36).substring(2, 10)}`;
                }

                // Check if username exists and make it unique if needed
                const existingUsername = await db.query.users.findFirst({
                    where: eq(users.username, username),
                });

                if (existingUsername) {
                    username = `${username}_${Math.floor(Math.random() * 1000)}`;
                }

                // Insert the new user
                const result = await db
                    .insert(users)
                    .values({
                        username,
                        appleId: appleUserId,
                        fullName,
                        email,
                    })
                    .returning({ id: users.id });

                userId = result[0].id;
            }

            // Generate JWT token for the user
            const token = await c.env.JWT_SECRET;
            const payload = {
                id: userId,
                exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // 30 days
            };

            const authToken = await sign(payload, token);

            return c.json({
                success: true,
                token: authToken,
                userId,
            });
        } catch (error) {
            console.error("Apple Sign In Error:", error);
            return c.json({ success: false, error: "Authentication failed" }, 500);
        }
    }
);

export default app;