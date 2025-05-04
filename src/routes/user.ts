// src/routes/user.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { AppEnv } from "../types";
import { users, deviceTokens } from "../db/schema";
import { jwtMiddleware } from "../lib/auth";

// Define validation schemas
const deviceTokenSchema = z.object({
    token: z.string().min(1),
    platform: z.enum(["ios", "android"]),
});

const updateProfileSchema = z.object({
    username: z.string().min(3).optional(),
    fullName: z.string().optional(),
});

// Create a router instance
const app = new Hono<AppEnv>();

// Get current user profile
app.get("/profile", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        const user = await db.query.users.findFirst({
            where: eq(users.id, userId),
            columns: {
                id: true,
                username: true,
                fullName: true,
                email: true,
                createdAt: true,
            },
        });

        if (!user) {
            return c.json({ success: false, error: "User not found" }, 404);
        }

        return c.json({ success: true, user });
    } catch (error) {
        console.error("Get Profile Error:", error);
        return c.json({ success: false, error: "Failed to get profile" }, 500);
    }
});

// Update user profile
app.patch(
    "/profile",
    jwtMiddleware,
    zValidator("json", updateProfileSchema),
    async (c) => {
        const userId = c.get("jwtPayload").id;
        const { username, fullName } = c.req.valid("json");
        const db = c.get("db");

        try {
            // If username is provided, check if it's already taken
            if (username) {
                const existingUser = await db.query.users.findFirst({
                    where: eq(users.username, username),
                });

                if (existingUser && existingUser.id !== userId) {
                    return c.json({ success: false, error: "Username already taken" }, 400);
                }
            }

            // Update user
            await db
                .update(users)
                .set({
                    ...(username && { username }),
                    ...(fullName && { fullName }),
                })
                .where(eq(users.id, userId));

            return c.json({ success: true });
        } catch (error) {
            console.error("Update Profile Error:", error);
            return c.json({ success: false, error: "Failed to update profile" }, 500);
        }
    }
);

// Register device token for push notifications
// src/routes/user.ts - Updated POST /devices
app.post(
    "/devices",
    jwtMiddleware,
    zValidator("json", deviceTokenSchema),
    async (c) => {
        const userId = c.get("jwtPayload").id;
        const { token, platform } = c.req.valid("json");
        const db = c.get("db");

        try {
            // Use ON CONFLICT DO UPDATE for atomic upsert
            await db
                .insert(deviceTokens)
                .values({
                    userId,
                    token,
                    platform,
                    // lastUpdated is handled by default value or update clause
                })
                .onConflictDoUpdate({
                    target: deviceTokens.token, // Conflict on the unique token
                    set: {
                        // Update userId if different, and always update timestamp
                        userId: userId,
                        lastUpdated: new Date(),
                        platform: platform, // Also update platform if it changed
                    },
                })
                .run(); // Use run() for D1 inserts/updates

            return c.json({ success: true, message: "Device registered" });
        } catch (error: any) {
            console.error("Register Device Error:", error);
            // Drizzle might throw specific errors for constraints
            return c.json(
                { success: false, error: "Failed to register device" },
                500,
            );
        }
    },
);


// Delete device token
app.delete(
    "/devices/:token",
    jwtMiddleware,
    async (c) => {
        const userId = c.get("jwtPayload").id;
        const token = c.req.param("token");
        const db = c.get("db");

        try {
            await db
                .delete(deviceTokens)
                .where(
                    sql`${deviceTokens.token} = ${token} AND ${deviceTokens.userId} = ${userId}`
                );

            return c.json({ success: true });
        } catch (error) {
            console.error("Delete Device Error:", error);
            return c.json({ success: false, error: "Failed to delete device" }, 500);
        }
    }
);

export default app;