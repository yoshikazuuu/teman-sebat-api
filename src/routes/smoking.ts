// src/routes/smoking.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, isNull, ne, sql, or, desc, inArray, asc } from "drizzle-orm";
import { AppEnv, AppContext } from "../types"; // Import AppContext
import {
    users,
    friendships,
    smokingSessions,
    sessionResponses,
    deviceTokens,
} from "../db/schema";
import { jwtMiddleware } from "../lib/auth";
import {
    ApnsPayload,
    notifyFriendsOfSession,
    sendPushNotifications, // Keep this import
} from "../lib/apns";

// Define validation schemas
const responseSchema = z.object({
    responseType: z.enum(["coming", "done", "coming_5"]),
});

// Create a router instance
const app = new Hono<AppEnv>();

// --- Helper Function for Fetching Friend Tokens ---
// Extracted for reuse in /start and /end
const getFriendDeviceTokens = async (
    db: AppContext["var"]["db"],
    userId: number,
    platform: "ios" | "android" = "ios", // Default to iOS for now
): Promise<{ tokens: string[]; friendIds: number[] }> => {
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

    if (friendIds.length === 0) {
        return { tokens: [], friendIds: [] };
    }

    const friendTokens = await db.query.deviceTokens.findMany({
        where: and(
            inArray(deviceTokens.userId, friendIds),
            eq(deviceTokens.platform, platform),
        ),
        columns: {
            token: true,
        },
    });

    return { tokens: friendTokens.map((t) => t.token), friendIds };
};

// --- POST /start route ---
app.post("/start", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");
    const env = c.env;

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
                    error: "You already have an active nongki session",
                    sessionId: activeSession.id,
                },
                400,
            );
        }

        // Create a new smoking session
        const result = await db
            .insert(smokingSessions)
            .values({ userId })
            .returning({ id: smokingSessions.id });

        if (!result || result.length === 0) {
            throw new Error("Failed to create nongki session record.");
        }
        const sessionId = result[0].id;

        // --- Notification Logic ---
        let notificationSuccessCount = 0;
        let notificationFailureCount = 0;
        let friendsToNotifyCount = 0;

        const { tokens: tokensToSend, friendIds } = await getFriendDeviceTokens(
            db,
            userId,
        );
        friendsToNotifyCount = tokensToSend.length;

        if (tokensToSend.length > 0) {
            console.log(
                `Found ${tokensToSend.length} iOS tokens for friends: ${friendIds.join(", ")}`,
            );
            const currentUser = await db.query.users.findFirst({
                where: eq(users.id, userId),
                columns: { id: true, username: true, fullName: true },
            });

            if (!currentUser) {
                console.error(
                    `Could not find user ${userId} for notification details.`,
                );
            } else {
                console.log(
                    `Notifying friends about session ${sessionId} started by user ${userId} (${currentUser.username})`,
                );
                const notificationResult = await notifyFriendsOfSession(
                    env,
                    tokensToSend,
                    currentUser,
                    sessionId,
                );
                notificationSuccessCount = notificationResult.successCount;
                notificationFailureCount = notificationResult.failureCount;
                console.log(
                    `Session start notification result: ${notificationSuccessCount} success, ${notificationFailureCount} failed.`,
                );

                // Log invalid tokens for potential cleanup
                if (notificationResult.invalidTokens.length > 0) {
                    console.log(
                        `Found ${notificationResult.invalidTokens.length} invalid device tokens during session start notification that should be removed from database.`
                    );
                    // TODO: Implement automatic cleanup of invalid tokens
                    // await cleanupInvalidTokens(db, notificationResult.invalidTokens);
                }
            }
        } else {
            console.log(
                `User ${userId} has no friends or friends have no iOS tokens to notify.`,
            );
        }
        // --- End Notification Logic ---

        return c.json({
            success: true,
            sessionId,
            message: "Nongki session started.",
            notifications: {
                attempted: friendsToNotifyCount,
                successful: notificationSuccessCount,
                failed: notificationFailureCount,
            },
        });
    } catch (error: any) {
        console.error("Start Nongki Session Error:", error);
        return c.json(
            { success: false, error: "Failed to start nongki session" },
            500,
        );
    }
});

// --- GET /active route ---
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
            console.log(
                `User ${userId} has no friends, returning empty active sessions.`,
            );
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
                    limit: 1, // Only need one
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

// --- POST /end/:sessionId route ---
app.post("/end/:sessionId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const sessionIdParam = c.req.param("sessionId");
    const sessionId = parseInt(sessionIdParam, 10);
    const db = c.get("db");
    const env = c.env; // Get environment variables

    if (isNaN(sessionId)) {
        return c.json(
            { success: false, error: `Invalid session ID: ${sessionIdParam}` },
            400,
        );
    }

    try {
        // End the session by setting endTime
        const endTime = new Date(); // Capture end time before DB call
        const result = await db
            .update(smokingSessions)
            .set({ endTime: endTime }) // Use captured time
            .where(
                and(
                    eq(smokingSessions.id, sessionId),
                    eq(smokingSessions.userId, userId), // Only the owner can end it
                    isNull(smokingSessions.endTime), // Only end active sessions
                ),
            )
            .returning({ id: smokingSessions.id });

        // Check if any row was actually updated
        if (result.length === 0) {
            // Check if the session exists but doesn't belong to user or is already ended
            const existingSession = await db.query.smokingSessions.findFirst({
                where: eq(smokingSessions.id, sessionId),
                columns: { userId: true, endTime: true },
            });
            if (!existingSession) {
                return c.json({ success: false, error: "Session not found" }, 404);
            } else if (existingSession.userId !== userId) {
                return c.json(
                    { success: false, error: "You are not the owner of this session" },
                    403,
                );
            } else if (existingSession.endTime !== null) {
                return c.json(
                    { success: false, error: "This session has already ended" },
                    400,
                );
            }
            return c.json({ success: false, error: "Failed to end session" }, 500);
        }

        console.log(`User ${userId} ended session ${sessionId}`);

        // --- Notify Friends Session Ended ---
        let notificationSuccessCount = 0;
        let notificationFailureCount = 0;
        let friendsToNotifyCount = 0;

        const { tokens: tokensToSend, friendIds } = await getFriendDeviceTokens(
            db,
            userId,
        );
        friendsToNotifyCount = tokensToSend.length;

        if (tokensToSend.length > 0) {
            console.log(
                `Found ${tokensToSend.length} iOS tokens for friends to notify about session end: ${friendIds.join(", ")}`,
            );
            const currentUser = await db.query.users.findFirst({
                where: eq(users.id, userId),
                columns: { username: true, fullName: true },
            });

            if (currentUser) {
                const userName = currentUser.fullName || currentUser.username;
                const payload: ApnsPayload = {
                    aps: {
                        alert: {
                            // Title is optional, body is sufficient
                            body: `${userName} has ended their nongki session.`,
                        },
                        sound: "default",
                    },
                    notificationType: "session_ended", // Distinct type
                    sessionId: sessionId,
                    enderId: userId,
                    enderUsername: currentUser.username,
                };

                console.log(
                    `Notifying friends about session ${sessionId} ending by user ${userId} (${currentUser.username})`,
                );
                // Use the generic sender function
                const notificationResult = await sendPushNotifications(
                    env,
                    tokensToSend,
                    payload,
                );
                notificationSuccessCount = notificationResult.successCount;
                notificationFailureCount = notificationResult.failureCount;
                console.log(
                    `Session end notification result: ${notificationSuccessCount} success, ${notificationFailureCount} failed.`,
                );

                // Log invalid tokens for potential cleanup
                if (notificationResult.invalidTokens.length > 0) {
                    console.log(
                        `Found ${notificationResult.invalidTokens.length} invalid device tokens during session end notification that should be removed from database.`
                    );
                    // TODO: Implement automatic cleanup of invalid tokens
                    // await cleanupInvalidTokens(db, notificationResult.invalidTokens);
                }
            } else {
                console.error(
                    `Could not find user ${userId} for session end notification details.`,
                );
            }
        } else {
            console.log(
                `User ${userId} has no friends or friends have no iOS tokens to notify about session end.`,
            );
        }
        // --- End Notification Logic ---

        return c.json({
            success: true,
            message: "Smoking session ended",
            notifications: {
                // Optional: include notification info in response
                attempted: friendsToNotifyCount,
                successful: notificationSuccessCount,
                failed: notificationFailureCount,
            },
        });
    } catch (error) {
        console.error(`End Nongki Session Error (Session ID: ${sessionId}):`, error);
        return c.json(
            { success: false, error: "Failed to end nongki session" },
            500,
        );
    }
});

// --- POST /respond/:sessionId route ---
app.post(
    "/respond/:sessionId",
    jwtMiddleware,
    zValidator("json", responseSchema),
    async (c) => {
        const responderId = c.get("jwtPayload").id; // User sending the response
        const sessionIdParam = c.req.param("sessionId");
        const sessionId = parseInt(sessionIdParam, 10);
        const { responseType } = c.req.valid("json");
        const db = c.get("db");
        const env = c.env; // Get environment variables

        if (isNaN(sessionId)) {
            return c.json(
                { success: false, error: `Invalid session ID: ${sessionIdParam}` },
                400,
            );
        }

        try {
            // --- Validation ---
            const session = await db.query.smokingSessions.findFirst({
                where: and(
                    eq(smokingSessions.id, sessionId),
                    isNull(smokingSessions.endTime), // Ensure session is active
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

            if (session.userId === responderId) {
                return c.json(
                    { success: false, error: "Cannot respond to your own session" },
                    403,
                );
            }

            const ownerId = session.userId;

            const friendship = await db.query.friendships.findFirst({
                where: and(
                    or(
                        and(
                            eq(friendships.userId1, responderId),
                            eq(friendships.userId2, ownerId),
                        ),
                        and(
                            eq(friendships.userId1, ownerId),
                            eq(friendships.userId2, responderId),
                        ),
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

            // --- Store the Response (Upsert) ---
            console.log(
                `User ${responderId} responding '${responseType}' to session ${sessionId} owned by ${ownerId}`,
            );
            await db
                .insert(sessionResponses)
                .values({
                    sessionId,
                    responderId: responderId,
                    responseType,
                })
                .onConflictDoUpdate({
                    target: [sessionResponses.sessionId, sessionResponses.responderId],
                    set: {
                        responseType: responseType,
                        timestamp: sql`(unixepoch())`, // Use SQL function for timestamp update
                    },
                })
                .run();

            // --- Send Notification to Session Owner ---
            const ownerTokens = await db.query.deviceTokens.findMany({
                where: and(
                    eq(deviceTokens.userId, ownerId),
                    eq(deviceTokens.platform, "ios"),
                ),
                columns: { token: true },
            });

            const tokensToSend = ownerTokens.map((t) => t.token);

            if (tokensToSend.length > 0) {
                console.log(
                    `Found ${tokensToSend.length} iOS tokens for session owner ${ownerId}:`,
                    tokensToSend.map((t) => `${t.substring(0, 5)}...`),
                );

                const responder = await db.query.users.findFirst({
                    where: eq(users.id, responderId),
                    columns: { username: true, fullName: true },
                });

                if (responder) {
                    const responderName = responder.fullName || responder.username;
                    let responseText = "";
                    switch (responseType) {
                        case "coming":
                            responseText = "is coming!";
                            break;
                        case "done":
                            responseText = "is done.";
                            break;
                        case "coming_5":
                            responseText = "is coming in 5 minutes.";
                            break;
                    }

                    const notificationPayload: ApnsPayload = {
                        aps: {
                            alert: {
                                title: "Session Response",
                                body: `${responderName} ${responseText}`,
                            },
                            sound: "default",
                        },
                        notificationType: "session_response",
                        sessionId: sessionId,
                        responderId: responderId,
                        responderUsername: responder.username,
                        responseType: responseType,
                    };

                    console.log(
                        `Attempting to send response notification to owner ${ownerId} (tokens: ${tokensToSend.length})`,
                    );
                    // Await the result for better logging during development
                    try {
                        const result = await sendPushNotifications(
                            env,
                            tokensToSend,
                            notificationPayload,
                        );
                        console.log(
                            `Response notification result for owner ${ownerId}: ${result.successCount} success, ${result.failureCount} failed.`,
                        );

                        // Log invalid tokens for potential cleanup
                        if (result.invalidTokens.length > 0) {
                            console.log(
                                `Found ${result.invalidTokens.length} invalid device tokens for session owner ${ownerId} that should be removed from database.`
                            );
                            // TODO: Implement automatic cleanup of invalid tokens
                            // await cleanupInvalidTokens(db, result.invalidTokens);
                        }
                    } catch (err) {
                        console.error(
                            `Error awaiting response notification to owner ${ownerId}:`,
                            err,
                        );
                    }
                } else {
                    console.error(
                        `Could not find responder details for user ID ${responderId}`,
                    );
                }
            } else {
                console.log(
                    `Session owner ${ownerId} has no registered iOS device tokens.`,
                );
            }
            // --- End Notification Logic ---

            return c.json({
                success: true,
                message: "Response recorded",
                responseType,
            });
        } catch (error: any) {
            console.error(
                `Respond to Session Error (Session ID: ${sessionId}):`,
                error,
            );
            return c.json(
                { success: false, error: "Failed to respond to session" },
                500,
            );
        }
    },
);

// --- GET /responses/:sessionId route ---
app.get("/responses/:sessionId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const sessionIdParam = c.req.param("sessionId");
    const sessionId = parseInt(sessionIdParam, 10);

    if (isNaN(sessionId)) {
        return c.json(
            { success: false, error: `Invalid session ID: ${sessionIdParam}` },
            400,
        );
    }

    const db = c.get("db");

    try {
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
            const exists = await db.query.smokingSessions.findFirst({
                where: eq(smokingSessions.id, sessionId),
                columns: { id: true },
            });
            return c.json(
                {
                    success: false,
                    error: exists ? "You do not own this session" : "Session not found",
                },
                exists ? 403 : 404,
            );
        }

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
        console.error(
            `Get Session Responses Error (Session ID: ${sessionId}):`,
            error,
        );
        return c.json(
            { success: false, error: "Failed to get session responses" },
            500,
        );
    }
});

// --- GET /history route ---
app.get("/history", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const limitParam = c.req.query("limit");
    const pageParam = c.req.query("page");
    const limit = Math.min(50, Math.max(1, parseInt(limitParam || "10", 10)));
    const page = Math.max(1, parseInt(pageParam || "1", 10));
    const offset = (page - 1) * limit;

    const db = c.get("db");

    try {
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

        const countQuery = db
            .select({ count: sql<number>`count(*)` })
            .from(smokingSessions)
            .where(eq(smokingSessions.userId, userId));

        const [sessions, countResult] = await Promise.all([
            sessionsQuery,
            countQuery,
        ]);

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
