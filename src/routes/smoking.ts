// src/routes/smoking.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, isNull, ne, sql, or, desc, inArray, asc } from "drizzle-orm";
import { AppEnv } from "../types";
import {
    users,
    friendships,
    smokingSessions,
    sessionResponses,
    deviceTokens,
} from "../db/schema";
import { jwtMiddleware } from "../lib/auth";

// Define validation schemas
const responseSchema = z.object({
    responseType: z.enum(["coming", "done", "coming_5"]),
});

// Create a router instance
const app = new Hono<AppEnv>();

// --- Existing GET and POST /start routes remain the same ---
app.post("/start", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        // Check if user already has an active session
        const activeSession = await db.query.smokingSessions.findFirst({
            where: and(
                eq(smokingSessions.userId, userId),
                isNull(smokingSessions.endTime),
            ),
        });

        if (activeSession) {
            return c.json(
                {
                    success: false,
                    error: "You already have an active smoking session",
                    sessionId: activeSession.id,
                },
                400,
            );
        }

        // Create a new smoking session
        const result = await db
            .insert(smokingSessions)
            .values({
                userId,
                // Drizzle handles Date objects correctly for timestamp columns
                startTime: new Date(),
            })
            .returning({ id: smokingSessions.id });

        const sessionId = result[0].id;

        // Get all friends to notify
        const friends = await db.query.friendships.findMany({
            where: and(
                or(eq(friendships.userId1, userId), eq(friendships.userId2, userId)),
                eq(friendships.status, "accepted"),
            ),
            columns: {
                userId1: true,
                userId2: true,
            },
        });

        const friendIds = friends
            .map((f) => (f.userId1 === userId ? f.userId2 : f.userId1))
            .filter((id) => id !== userId); // Ensure not notifying self

        let deviceTokensToNotify: { token: string; platform: string }[] = [];
        if (friendIds.length > 0) {
            const friendTokens = await db.query.deviceTokens.findMany({
                where: inArray(deviceTokens.userId, friendIds),
                columns: {
                    token: true,
                    platform: true,
                },
            });
            deviceTokensToNotify = friendTokens;
        }

        // Get the user's info to include in notification
        const currentUser = await db.query.users.findFirst({
            where: eq(users.id, userId),
            columns: {
                username: true,
                fullName: true,
            },
        });

        // In a production app, you would send push notifications here
        console.log("Notifying friends of smoking session:", {
            sessionId,
            user: currentUser,
            deviceTokensCount: deviceTokensToNotify.length,
            // tokens: deviceTokensToNotify // Avoid logging tokens in production
        });

        // TODO: Implement actual push notification logic (e.g., queueing)

        return c.json({
            success: true,
            sessionId,
            message: "Smoking session started, friends notified",
            friendsNotified: deviceTokensToNotify.length,
        });
    } catch (error) {
        console.error("Start Smoking Session Error:", error);
        return c.json(
            { success: false, error: "Failed to start smoking session" },
            500,
        );
    }
});

app.get("/active", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        // Get accepted friendships
        const friends = await db.query.friendships.findMany({
            where: and(
                or(eq(friendships.userId1, userId), eq(friendships.userId2, userId)),
                eq(friendships.status, "accepted"),
            ),
            columns: {
                userId1: true,
                userId2: true,
            },
        });

        // Extract friend IDs
        const friendIds = friends
            .map((f) => (f.userId1 === userId ? f.userId2 : f.userId1))
            .filter((id) => id !== userId);

        if (friendIds.length === 0) {
            return c.json({ success: true, sessions: [] });
        }

        // Get active sessions from friends
        const activeSessions = await db.query.smokingSessions.findMany({
            where: and(
                inArray(smokingSessions.userId, friendIds),
                isNull(smokingSessions.endTime),
            ),
            with: {
                user: {
                    columns: {
                        id: true,
                        username: true,
                        fullName: true,
                    },
                },
                // Get the current user's response to this session
                responses: {
                    where: eq(sessionResponses.responderId, userId),
                    columns: {
                        responseType: true,
                    },
                    limit: 1, // Only need one (latest if multiple, though unlikely)
                },
            },
            orderBy: desc(smokingSessions.startTime),
        });

        // Format sessions with user response status
        const formattedSessions = activeSessions.map((session) => {
            const userResponse =
                session.responses.length > 0 ? session.responses[0].responseType : null;

            return {
                id: session.id,
                startTime: session.startTime,
                user: {
                    id: session.user.id,
                    username: session.user.username,
                    fullName: session.user.fullName,
                },
                userResponse, // Indicates if the current user has responded
            };
        });

        return c.json({ success: true, sessions: formattedSessions });
    } catch (error) {
        console.error("Get Active Sessions Error:", error);
        return c.json(
            { success: false, error: "Failed to get active sessions" },
            500,
        );
    }
});

// --- POST /end route with fix ---
app.post("/end/:sessionId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const sessionId = parseInt(c.req.param("sessionId"), 10);

    if (isNaN(sessionId)) {
        return c.json({ success: false, error: "Invalid session ID" }, 400);
    }

    const db = c.get("db");

    try {
        // End the session by setting endTime
        const result = await db
            .update(smokingSessions)
            .set({ endTime: new Date() }) // Drizzle handles Date objects
            .where(
                and(
                    eq(smokingSessions.id, sessionId),
                    eq(smokingSessions.userId, userId), // Only the owner can end it
                    isNull(smokingSessions.endTime), // Only end active sessions
                ),
            )
            .run(); // Use run()

        // Check if any row was actually updated
        if (result.meta.changes === 0) {
            return c.json(
                {
                    success: false,
                    error:
                        "Active session not found or you are not the owner",
                },
                404,
            );
        }

        return c.json({ success: true, message: "Smoking session ended" });
    } catch (error) {
        console.error("End Smoking Session Error:", error);
        return c.json(
            { success: false, error: "Failed to end smoking session" },
            500,
        );
    }
});

// --- Other routes remain the same ---
app.post(
    "/respond/:sessionId",
    jwtMiddleware,
    zValidator("json", responseSchema),
    async (c) => {
        const userId = c.get("jwtPayload").id;
        const sessionId = parseInt(c.req.param("sessionId"), 10);
        const { responseType } = c.req.valid("json");

        if (isNaN(sessionId)) {
            return c.json({ success: false, error: "Invalid session ID" }, 400);
        }

        const db = c.get("db");

        try {
            // Check if session exists, is active, and doesn't belong to the responder
            const session = await db.query.smokingSessions.findFirst({
                where: and(
                    eq(smokingSessions.id, sessionId),
                    isNull(smokingSessions.endTime),
                    ne(smokingSessions.userId, userId), // Can't respond to your own session
                ),
                columns: {
                    userId: true, // Need the owner's ID
                },
            });

            if (!session) {
                return c.json(
                    {
                        success: false,
                        error: "Active session not found or cannot respond to own session",
                    },
                    404,
                );
            }

            // Check if user is a friend of the session creator
            const friendship = await db.query.friendships.findFirst({
                where: and(
                    or(
                        and(eq(friendships.userId1, userId), eq(friendships.userId2, session.userId)),
                        and(eq(friendships.userId1, session.userId), eq(friendships.userId2, userId)),
                    ),
                    eq(friendships.status, "accepted"),
                ),
                columns: { userId1: true }, // Just need to know if it exists
            });

            if (!friendship) {
                return c.json(
                    {
                        success: false,
                        error: "You are not friends with the session creator",
                    },
                    403,
                );
            }

            // Upsert the response: Insert or update if exists
            await db
                .insert(sessionResponses)
                .values({
                    sessionId,
                    responderId: userId,
                    responseType,
                    timestamp: new Date(),
                })
                .onConflictDoUpdate({
                    target: [sessionResponses.sessionId, sessionResponses.responderId], // Assuming composite unique constraint or PK
                    set: {
                        responseType: responseType,
                        timestamp: new Date(),
                    },
                })
                .run();

            // Get session owner's device tokens for notification
            const ownerTokens = await db.query.deviceTokens.findMany({
                where: eq(deviceTokens.userId, session.userId),
                columns: { token: true, platform: true }
            });

            // Get responder info
            const responder = await db.query.users.findFirst({
                where: eq(users.id, userId),
                columns: {
                    username: true,
                    fullName: true,
                },
            });

            // In a production app, you would send push notification to session creator
            console.log("Sending response notification:", {
                sessionId,
                responseType,
                responder,
                recipient: {
                    id: session.userId,
                    deviceTokensCount: ownerTokens.length,
                },
            });
            // TODO: Implement actual push notification logic

            return c.json({
                success: true,
                message: "Response sent",
                responseType,
            });
        } catch (error) {
            console.error("Respond to Session Error:", error);
            // Check for specific errors like constraint violations if needed
            return c.json(
                { success: false, error: "Failed to respond to session" },
                500,
            );
        }
    },
);

app.get("/responses/:sessionId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const sessionId = parseInt(c.req.param("sessionId"), 10);

    if (isNaN(sessionId)) {
        return c.json({ success: false, error: "Invalid session ID" }, 400);
    }

    const db = c.get("db");

    try {
        // Check if session belongs to user
        const session = await db.query.smokingSessions.findFirst({
            where: and(
                eq(smokingSessions.id, sessionId),
                eq(smokingSessions.userId, userId),
            ),
            columns: {
                id: true,
                startTime: true,
                endTime: true,
            },
        });

        if (!session) {
            return c.json(
                { success: false, error: "Session not found or not accessible" },
                404,
            );
        }

        // Get all responses for this session
        const responses = await db.query.sessionResponses.findMany({
            where: eq(sessionResponses.sessionId, sessionId),
            with: {
                responder: {
                    columns: {
                        id: true,
                        username: true,
                        fullName: true,
                    },
                },
            },
            orderBy: asc(sessionResponses.timestamp),
        });

        const formattedResponses = responses.map((response) => ({
            id: response.id,
            responseType: response.responseType,
            timestamp: response.timestamp,
            responder: {
                id: response.responder.id,
                username: response.responder.username,
                fullName: response.responder.fullName,
            },
        }));

        return c.json({
            success: true,
            responses: formattedResponses,
            session: {
                id: session.id,
                startTime: session.startTime,
                endTime: session.endTime,
            },
        });
    } catch (error) {
        console.error("Get Session Responses Error:", error);
        return c.json(
            { success: false, error: "Failed to get session responses" },
            500,
        );
    }
});

app.get("/history", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const limit = Math.max(1, parseInt(c.req.query("limit") || "10", 10));
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
    const offset = (page - 1) * limit;

    const db = c.get("db");

    try {
        // Get user's sessions with pagination
        const sessionsQuery = db.query.smokingSessions.findMany({
            where: eq(smokingSessions.userId, userId),
            orderBy: desc(smokingSessions.startTime),
            limit,
            offset,
            with: {
                responses: {
                    with: {
                        responder: {
                            columns: {
                                id: true,
                                username: true,
                                fullName: true,
                            },
                        },
                    },
                    orderBy: asc(sessionResponses.timestamp),
                },
            },
        });

        // Get total count for pagination
        const countQuery = db
            .select({ count: sql<number>`count(*)` })
            .from(smokingSessions)
            .where(eq(smokingSessions.userId, userId));

        // Execute queries concurrently
        const [sessions, countResult] = await Promise.all([
            sessionsQuery,
            countQuery,
        ]);

        // Format sessions with responses
        const formattedSessions = sessions.map((session) => ({
            id: session.id,
            startTime: session.startTime,
            endTime: session.endTime,
            isActive: session.endTime === null,
            responses: session.responses.map((response) => ({
                id: response.id,
                responseType: response.responseType,
                timestamp: response.timestamp,
                responder: {
                    id: response.responder.id,
                    username: response.responder.username,
                    fullName: response.responder.fullName,
                },
            })),
        }));

        const totalCount = countResult[0]?.count ?? 0;
        const totalPages = Math.ceil(totalCount / limit);

        return c.json({
            success: true,
            sessions: formattedSessions,
            pagination: {
                currentPage: page,
                totalPages,
                totalCount,
                limit,
            },
        });
    } catch (error) {
        console.error("Get Session History Error:", error);
        return c.json(
            { success: false, error: "Failed to get session history" },
            500,
        );
    }
});

export default app;
