// src/routes/smoking.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, isNull, ne, sql, or } from "drizzle-orm";
import { AppEnv } from "../types";
import {
    users,
    friendships,
    smokingSessions,
    sessionResponses,
    deviceTokens
} from "../db/schema";
import { jwtMiddleware } from "./auth";

// Define validation schemas
const responseSchema = z.object({
    responseType: z.enum(["coming", "done", "coming_5"]),
});

// Create a router instance
const app = new Hono<AppEnv>();

// Start a smoking session
app.post("/start", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        // Check if user already has an active session
        const activeSession = await db.query.smokingSessions.findFirst({
            where: and(
                eq(smokingSessions.userId, userId),
                isNull(smokingSessions.endTime)
            ),
        });

        if (activeSession) {
            return c.json({
                success: false,
                error: "You already have an active smoking session",
                sessionId: activeSession.id,
            }, 400);
        }

        // Create a new smoking session
        const result = await db
            .insert(smokingSessions)
            .values({
                userId,
                startTime: new Date(),
            })
            .returning({ id: smokingSessions.id });

        const sessionId = result[0].id;

        // Get all friends to notify
        const friends = await db.query.friendships.findMany({
            where: and(
                or(
                    eq(friendships.userId1, userId),
                    eq(friendships.userId2, userId)
                ),
                eq(friendships.status, "accepted")
            ),
            with: {
                user1: {
                    columns: {
                        id: true,
                    },
                    with: {
                        deviceTokens: true,
                    },
                },
                user2: {
                    columns: {
                        id: true,
                    },
                    with: {
                        deviceTokens: true,
                    },
                },
            },
        });

        // Get the user's info to include in notification
        const currentUser = await db.query.users.findFirst({
            where: eq(users.id, userId),
            columns: {
                username: true,
                fullName: true,
            },
        });

        // Collect device tokens to notify
        const deviceTokensToNotify = friends.flatMap(friendship => {
            const friendUser = friendship.userId1 === userId
                ? friendship.user2
                : friendship.user1;

            return friendUser.deviceTokens.map(device => ({
                token: device.token,
                platform: device.platform,
            }));
        });

        // In a production app, you would send push notifications here
        // For this example, we'll just log the details
        console.log("Notifying friends of smoking session:", {
            sessionId,
            user: currentUser,
            deviceTokensCount: deviceTokensToNotify.length,
        });

        // In a real implementation, you would queue the notifications to be sent
        // using a service like Firebase Cloud Messaging or Apple Push Notification Service

        return c.json({
            success: true,
            sessionId,
            message: "Smoking session started, friends notified",
            friendsNotified: deviceTokensToNotify.length,
        });
    } catch (error) {
        console.error("Start Smoking Session Error:", error);
        return c.json({ success: false, error: "Failed to start smoking session" }, 500);
    }
});

// End a smoking session
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
            .set({ endTime: new Date() })
            .where(and(
                eq(smokingSessions.id, sessionId),
                eq(smokingSessions.userId, userId),
                isNull(smokingSessions.endTime)
            ))
            .returning({ updated: sql`count(*)` });

        if (!result[0] || result[0].updated === 0) {
            return c.json({ success: false, error: "Active session not found" }, 404);
        }

        return c.json({ success: true, message: "Smoking session ended" });
    } catch (error) {
        console.error("End Smoking Session Error:", error);
        return c.json({ success: false, error: "Failed to end smoking session" }, 500);
    }
});

// Get active smoking sessions of friends
app.get("/active", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        // Get accepted friendships
        const friends = await db.query.friendships.findMany({
            where: and(
                or(
                    eq(friendships.userId1, userId),
                    eq(friendships.userId2, userId)
                ),
                eq(friendships.status, "accepted")
            ),
            with: {
                user1: {
                    columns: {
                        id: true,
                    },
                },
                user2: {
                    columns: {
                        id: true,
                    },
                },
            },
        });

        // Extract friend IDs
        const friendIds = friends.map(friendship =>
            friendship.userId1 === userId ? friendship.userId2 : friendship.user1.id
        );

        if (friendIds.length === 0) {
            return c.json({ success: true, sessions: [] });
        }

        // Get active sessions from friends
        const activeSessions = await db.query.smokingSessions.findMany({
            where: and(
                sql`${smokingSessions.userId} IN (${friendIds.join(',')})`,
                isNull(smokingSessions.endTime)
            ),
            with: {
                user: {
                    columns: {
                        id: true,
                        username: true,
                        fullName: true,
                    },
                },
                responses: {
                    where: eq(sessionResponses.responderId, userId),
                },
            },
            orderBy: (sessions, { desc }) => [desc(sessions.startTime)],
        });

        // Format sessions with user response status
        const formattedSessions = activeSessions.map(session => {
            const userResponse = session.responses.length > 0
                ? session.responses[0].responseType
                : null;

            return {
                id: session.id,
                startTime: session.startTime,
                user: {
                    id: session.user.id,
                    username: session.user.username,
                    fullName: session.user.fullName,
                },
                userResponse,
            };
        });

        return c.json({ success: true, sessions: formattedSessions });
    } catch (error) {
        console.error("Get Active Sessions Error:", error);
        return c.json({ success: false, error: "Failed to get active sessions" }, 500);
    }
});

// Respond to a smoking session
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
            // Check if session exists and is active
            const session = await db.query.smokingSessions.findFirst({
                where: and(
                    eq(smokingSessions.id, sessionId),
                    isNull(smokingSessions.endTime),
                    ne(smokingSessions.userId, userId) // Can't respond to your own session
                ),
                with: {
                    user: {
                        columns: {
                            id: true,
                            username: true,
                        },
                        with: {
                            deviceTokens: true,
                        },
                    },
                },
            });

            if (!session) {
                return c.json({ success: false, error: "Active session not found or not accessible" }, 404);
            }

            // Check if user is a friend of the session creator
            const friendship = await db.query.friendships.findFirst({
                where: or(
                    and(
                        eq(friendships.userId1, userId),
                        eq(friendships.userId2, session.user.id),
                        eq(friendships.status, "accepted")
                    ),
                    and(
                        eq(friendships.userId1, session.user.id),
                        eq(friendships.userId2, userId),
                        eq(friendships.status, "accepted")
                    )
                ),
            });

            if (!friendship) {
                return c.json({ success: false, error: "You are not friends with the session creator" }, 403);
            }

            // Check if user already responded
            const existingResponse = await db.query.sessionResponses.findFirst({
                where: and(
                    eq(sessionResponses.sessionId, sessionId),
                    eq(sessionResponses.responderId, userId)
                ),
            });

            if (existingResponse) {
                // Update existing response
                await db
                    .update(sessionResponses)
                    .set({
                        responseType,
                        timestamp: new Date(),
                    })
                    .where(eq(sessionResponses.id, existingResponse.id));
            } else {
                // Create new response
                await db
                    .insert(sessionResponses)
                    .values({
                        sessionId,
                        responderId: userId,
                        responseType,
                        timestamp: new Date(),
                    });
            }

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
                    id: session.user.id,
                    username: session.user.username,
                    deviceTokens: session.user.deviceTokens.length,
                },
            });

            return c.json({
                success: true,
                message: "Response sent",
                responseType,
            });
        } catch (error) {
            console.error("Respond to Session Error:", error);
            return c.json({ success: false, error: "Failed to respond to session" }, 500);
        }
    }
);

// Get responses for a specific session (for the session creator)
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
                eq(smokingSessions.userId, userId)
            ),
        });

        if (!session) {
            return c.json({ success: false, error: "Session not found or not accessible" }, 404);
        }

        // Get all responses
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
            orderBy: (responses, { asc }) => [asc(responses.timestamp)],
        });

        const formattedResponses = responses.map(response => ({
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
        return c.json({ success: false, error: "Failed to get session responses" }, 500);
    }
});

// Get user's session history
app.get("/history", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const limit = parseInt(c.req.query("limit") || "10", 10);
    const page = parseInt(c.req.query("page") || "1", 10);

    const db = c.get("db");

    try {
        // Get user's sessions with pagination
        const sessions = await db.query.smokingSessions.findMany({
            where: eq(smokingSessions.userId, userId),
            orderBy: (sessions, { desc }) => [desc(sessions.startTime)],
            limit,
            offset: (page - 1) * limit,
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
                },
            },
        });

        // Format sessions with responses
        const formattedSessions = sessions.map(session => ({
            id: session.id,
            startTime: session.startTime,
            endTime: session.endTime,
            isActive: session.endTime === null,
            responses: session.responses.map(response => ({
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

        // Get total count for pagination
        const countResult = await db
            .select({ count: sql`count(*)` })
            .from(smokingSessions)
            .where(eq(smokingSessions.userId, userId));

        const totalCount = Number(countResult[0].count);
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
        return c.json({ success: false, error: "Failed to get session history" }, 500);
    }
});

export default app;