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
import { ApnsPayload, notifyFriendsOfSession, sendPushNotifications } from "../lib/apns";

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
    const env = c.env; // Get environment variables

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
                startTime: new Date(),
            })
            .returning({ id: smokingSessions.id });

        if (!result || result.length === 0) {
            throw new Error("Failed to create smoking session record.");
        }
        const sessionId = result[0].id;

        // --- Notification Logic ---
        let notificationSuccessCount = 0;
        let notificationFailureCount = 0;
        let friendsToNotifyCount = 0;

        // Get all friends
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
            .filter((id) => id !== userId);

        if (friendIds.length > 0) {
            // Get device tokens ONLY for iOS platform initially
            const friendTokens = await db.query.deviceTokens.findMany({
                where: and(
                    inArray(deviceTokens.userId, friendIds),
                    eq(deviceTokens.platform, "ios"), // Filter for iOS tokens
                ),
                columns: {
                    token: true,
                    // platform: true, // We know it's ios here
                },
            });

            const tokensToSend = friendTokens.map((t) => t.token);
            friendsToNotifyCount = tokensToSend.length;

            if (tokensToSend.length > 0) {
                // Get the user's info to include in notification
                const currentUser = await db.query.users.findFirst({
                    where: eq(users.id, userId),
                    columns: {
                        id: true,
                        username: true,
                        fullName: true,
                    },
                });

                if (!currentUser) {
                    // Should not happen if JWT is valid, but good to check
                    console.error(
                        `Could not find user ${userId} for notification details.`,
                    );
                } else {
                    // Send notifications (don't await if you want the API to respond faster)
                    // Awaiting is better for knowing the result, but might delay the response.
                    // Consider moving this to a background task/queue in high-volume scenarios.
                    const notificationResult = await notifyFriendsOfSession(
                        env, // Pass environment variables
                        tokensToSend,
                        currentUser,
                        sessionId,
                    );
                    notificationSuccessCount = notificationResult.successCount;
                    notificationFailureCount = notificationResult.failureCount;
                }
            } else {
                console.log("No iOS device tokens found for friends to notify.");
            }
        } else {
            console.log("User has no friends to notify.");
        }
        // --- End Notification Logic ---

        return c.json({
            success: true,
            sessionId,
            message: "Smoking session started.",
            notifications: {
                attempted: friendsToNotifyCount,
                successful: notificationSuccessCount,
                failed: notificationFailureCount,
            },
        });
    } catch (error: any) {
        console.error("Start Smoking Session Error:", error);
        // Log specific APNS config errors if they occur during setup
        if (error.message.includes("APNS")) {
            // Logged within the apns lib, but maybe add context here
        }
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
        const responderId = c.get("jwtPayload").id; // User sending the response
        const sessionId = parseInt(c.req.param("sessionId"), 10);
        const { responseType } = c.req.valid("json");
        const db = c.get("db");
        const env = c.env; // Get environment variables

        if (isNaN(sessionId)) {
            return c.json({ success: false, error: "Invalid session ID" }, 400);
        }

        try {
            // --- Validation (slightly adjusted) ---
            // Check if session exists, is active, and doesn't belong to the responder
            const session = await db.query.smokingSessions.findFirst({
                where: and(
                    eq(smokingSessions.id, sessionId),
                    isNull(smokingSessions.endTime), // Ensure session is active
                    // ne(smokingSessions.userId, responderId) // Allow responding to own session? No, keep this check.
                ),
                columns: {
                    userId: true, // Need the owner's ID
                },
            });

            if (!session) {
                return c.json(
                    { success: false, error: "Active session not found" },
                    404,
                );
            }

            // Ensure responder is not the owner
            if (session.userId === responderId) {
                return c.json(
                    { success: false, error: "Cannot respond to your own session" },
                    403,
                );
            }

            const ownerId = session.userId;

            // Check if responder is a friend of the session owner
            const friendship = await db.query.friendships.findFirst({
                where: and(
                    or(
                        and(eq(friendships.userId1, responderId), eq(friendships.userId2, ownerId)),
                        and(eq(friendships.userId1, ownerId), eq(friendships.userId2, responderId)),
                    ),
                    eq(friendships.status, "accepted"),
                ),
                columns: { userId1: true },
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

            // --- Store the Response ---
            await db
                .insert(sessionResponses)
                .values({
                    sessionId,
                    responderId: responderId,
                    responseType,
                    timestamp: new Date(),
                })
                .onConflictDoUpdate({
                    target: [sessionResponses.sessionId, sessionResponses.responderId],
                    set: {
                        responseType: responseType,
                        timestamp: new Date(),
                    },
                })
                .run();

            // --- Send Notification to Session Owner ---
            // Fetch owner's device tokens (iOS only for now)
            const ownerTokens = await db.query.deviceTokens.findMany({
                where: and(
                    eq(deviceTokens.userId, ownerId),
                    eq(deviceTokens.platform, "ios"), // Filter for iOS
                ),
                columns: { token: true },
            });

            const tokensToSend = ownerTokens.map((t) => t.token);

            if (tokensToSend.length > 0) {
                // Fetch responder's details for the notification message
                const responder = await db.query.users.findFirst({
                    where: eq(users.id, responderId),
                    columns: { username: true, fullName: true },
                });

                if (responder) {
                    const responderName = responder.fullName || responder.username;
                    let responseText = "";
                    switch (responseType) {
                        case "coming": responseText = "is coming!"; break;
                        case "done": responseText = "is done."; break;
                        case "coming_5": responseText = "is coming in 5 minutes."; break;
                    }

                    // Construct the notification payload
                    const notificationPayload: ApnsPayload = {
                        aps: {
                            alert: {
                                title: "Session Response",
                                body: `${responderName} ${responseText}`,
                            },
                            sound: "default",
                        },
                        notificationType: "session_response", // New type
                        sessionId: sessionId,
                        responderId: responderId,
                        responderUsername: responder.username,
                        responseType: responseType,
                    };

                    // Send the notification (don't block the API response)
                    // Use await if you need the result, otherwise fire-and-forget
                    sendPushNotifications(env, tokensToSend, notificationPayload)
                        .then(result => {
                            console.log(`Response notification sent to owner ${ownerId}: ${result.successCount} success, ${result.failureCount} failed.`);
                        })
                        .catch(err => {
                            console.error(`Error sending response notification to owner ${ownerId}:`, err);
                        });

                } else {
                    console.error(`Could not find responder details for user ID ${responderId}`);
                }
            } else {
                console.log(`Session owner ${ownerId} has no registered iOS device tokens.`);
            }
            // --- End Notification Logic ---

            // Return success to the user who responded
            return c.json({
                success: true,
                message: "Response sent",
                responseType,
            });
        } catch (error: any) {
            console.error("Respond to Session Error:", error);
            // Check for specific errors like constraint violations if needed
            if (error.message?.includes("UNIQUE constraint failed")) {
                // This case should be handled by onConflictDoUpdate, but log if it somehow occurs
                console.error("Unique constraint violation during response upsert:", error);
            }
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
