// src/routes/friend.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, or, sql, ne, inArray } from "drizzle-orm";
import { AppContext, AppEnv } from "../types";
import { users, friendships, deviceTokens } from "../db/schema"; // Import deviceTokens
import { jwtMiddleware } from "../lib/auth";
import { ApnsPayload, sendPushNotifications } from "../lib/apns"; // Import APNS functions

// Define validation schemas
const friendRequestSchema = z
    .object({
        // Allow sending request by username OR userId
        username: z.string().min(1).optional(),
        userId: z.number().int().positive().optional(),
    })
    .refine((data) => data.username || data.userId, {
        message: "Either username or userId must be provided",
    });

// Create a router instance
const app = new Hono<AppEnv>();

// --- Helper Function for Sending Friend Notifications ---
// Encapsulates fetching tokens and sending notification
const notifyUser = async (
    c: AppContext, // Use HonoContext for access to env and db
    recipientId: number,
    payload: ApnsPayload,
) => {
    const db = c.get("db");
    const env = c.env;

    try {
        // Fetch recipient's iOS device tokens
        const recipientTokens = await db.query.deviceTokens.findMany({
            where: and(
                eq(deviceTokens.userId, recipientId),
                eq(deviceTokens.platform, "ios"),
            ),
            columns: { token: true },
        });

        const tokensToSend = recipientTokens.map((t) => t.token);

        if (tokensToSend.length > 0) {
            console.log(
                `Sending notification type '${payload.notificationType}' to user ${recipientId} (${tokensToSend.length} tokens)`,
            );
            // Fire and forget (don't await to avoid blocking response)
            sendPushNotifications(env, tokensToSend, payload)
                .then((result) => {
                    console.log(
                        `Friend notification result for user ${recipientId}: ${result.successCount} success, ${result.failureCount} failed.`,
                    );
                })
                .catch((err) => {
                    console.error(
                        `Error sending friend notification promise to user ${recipientId}:`,
                        err,
                    );
                });
        } else {
            console.log(
                `No iOS device tokens found for user ${recipientId} to send notification type '${payload.notificationType}'.`,
            );
        }
    } catch (error) {
        console.error(
            `Failed to prepare notification for user ${recipientId}:`,
            error,
        );
    }
};

// --- GET routes remain the same ---

app.get("/", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        // Get accepted friendships where the user is either userId1 or userId2
        const acceptedFriendships = await db.query.friendships.findMany({
            where: and(
                or(eq(friendships.userId1, userId), eq(friendships.userId2, userId)),
                eq(friendships.status, "accepted"),
            ),
            with: {
                user1: {
                    columns: {
                        id: true,
                        username: true,
                        fullName: true,
                    },
                },
                user2: {
                    columns: {
                        id: true,
                        username: true,
                        fullName: true,
                    },
                },
            },
        });

        // Format the response to show friend info
        const formattedFriends = acceptedFriendships.map((friendship) => {
            // Determine who the friend is in this relationship object
            const friend =
                friendship.userId1 === userId ? friendship.user2 : friendship.user1;

            // Generate the consistent friendshipId (smallerId-largerId) for deletion
            const user1Id = Math.min(friendship.userId1, friendship.userId2);
            const user2Id = Math.max(friendship.userId1, friendship.userId2);

            return {
                id: friend.id, // The friend's user ID
                username: friend.username,
                fullName: friend.fullName,
                friendshipId: `${user1Id}-${user2Id}`, // Consistent ID for removal
            };
        });

        return c.json({ success: true, friends: formattedFriends });
    } catch (error) {
        console.error("Get Friends Error:", error);
        return c.json({ success: false, error: "Failed to get friends" }, 500);
    }
});

app.get("/requests", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id; // This user is the recipient (userId2)
    const db = c.get("db");

    try {
        // Get pending requests where user is the recipient (userId2)
        const pendingRequests = await db.query.friendships.findMany({
            where: and(
                eq(friendships.userId2, userId), // Current user received the request
                eq(friendships.status, "pending"),
            ),
            with: {
                // We need info about the user who sent the request (userId1)
                user1: {
                    columns: {
                        id: true,
                        username: true,
                        fullName: true,
                    },
                },
            },
        });

        const formattedRequests = pendingRequests.map((request) => ({
            // Info about the person who sent the request
            id: request.user1.id,
            username: request.user1.username,
            fullName: request.user1.fullName,
            // Use consistent ID format: requesterId-recipientId
            // Here, user1 is requester, userId (current user) is recipient
            requestId: `${request.userId1}-${request.userId2}`,
        }));

        return c.json({ success: true, requests: formattedRequests });
    } catch (error) {
        console.error("Get Friend Requests Error:", error);
        return c.json(
            { success: false, error: "Failed to get friend requests" },
            500,
        );
    }
});

app.get("/search", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const query = c.req.query("q");

    if (!query || query.length < 2) {
        // Allow 2 chars for searching? Adjust if needed.
        return c.json(
            {
                success: false,
                error: "Search query must be at least 2 characters",
            },
            400,
        );
    }

    const db = c.get("db");

    try {
        // Search for users by username (case-insensitive, exclude current user)
        const searchResults = await db.query.users.findMany({
            where: and(
                // Use lower() for case-insensitive search if DB supports it well (SQLite does)
                sql`lower(${users.username}) LIKE ${`%${query.toLowerCase()}%`}`,
                ne(users.id, userId), // Exclude self
            ),
            columns: {
                id: true,
                username: true,
                fullName: true,
            },
            limit: 10, // Limit results
        });

        if (searchResults.length === 0) {
            return c.json({ success: true, users: [] });
        }

        // Get existing friendship statuses between current user and search results
        const targetUserIds = searchResults.map((u) => u.id);
        const existingFriendships = await db.query.friendships.findMany({
            where: or(
                // Current user initiated or received from target users
                and(
                    eq(friendships.userId1, userId),
                    inArray(friendships.userId2, targetUserIds),
                ),
                and(
                    inArray(friendships.userId1, targetUserIds),
                    eq(friendships.userId2, userId),
                ),
            ),
        });

        // Add status to search results
        const formattedResults = searchResults.map((user) => {
            const friendship = existingFriendships.find(
                (f) =>
                    (f.userId1 === userId && f.userId2 === user.id) ||
                    (f.userId1 === user.id && f.userId2 === userId),
            );

            let status: "accepted" | "pending" | "none" = "none";
            let direction: "sent" | "received" | null = null;

            if (friendship) {
                status = friendship.status;
                if (status === "pending") {
                    // If userId1 is the current user, they sent the request
                    direction = friendship.userId1 === userId ? "sent" : "received";
                }
            }

            return {
                id: user.id,
                username: user.username,
                fullName: user.fullName,
                status: status,
                direction: direction, // Indicates who initiated if pending
            };
        });

        return c.json({ success: true, users: formattedResults });
    } catch (error) {
        console.error("Search Users Error:", error);
        return c.json({ success: false, error: "Failed to search users" }, 500);
    }
});

// --- POST /request (Send/Accept Friend Request) ---
app.post(
    "/request",
    jwtMiddleware,
    zValidator("json", friendRequestSchema),
    async (c) => {
        const userId = c.get("jwtPayload").id; // The user initiating this action
        const { username, userId: targetUserIdInput } = c.req.valid("json");
        const db = c.get("db");

        // Get current user's info for notifications
        const currentUser = await db.query.users.findFirst({
            where: eq(users.id, userId),
            columns: { username: true, fullName: true },
        });
        // If user somehow doesn't exist (token valid but DB inconsistent), proceed but log error
        if (!currentUser) {
            console.error(
                `Could not find current user ${userId} details for friend notification.`,
            );
            // Fallback name
            // currentUser = { username: `User ${userId}`, fullName: null };
        }
        const currentUserName = currentUser?.fullName || currentUser?.username || `User ${userId}`;

        try {
            // Find the target user
            let targetUser: { id: number } | undefined;
            if (targetUserIdInput) {
                if (targetUserIdInput === userId) {
                    return c.json(
                        { success: false, error: "You cannot add yourself as a friend" },
                        400,
                    );
                }
                targetUser = await db.query.users.findFirst({
                    where: eq(users.id, targetUserIdInput),
                    columns: { id: true },
                });
            } else if (username) {
                targetUser = await db.query.users.findFirst({
                    where: eq(users.username, username),
                    columns: { id: true },
                });
                if (targetUser?.id === userId) {
                    return c.json(
                        { success: false, error: "You cannot add yourself as a friend" },
                        400,
                    );
                }
            }

            if (!targetUser) {
                return c.json({ success: false, error: "Target user not found" }, 404);
            }
            const targetUserId = targetUser.id;

            // Check existing friendship status in both directions
            const existingFriendship = await db.query.friendships.findFirst({
                where: or(
                    // Did current user already interact with target user?
                    and(
                        eq(friendships.userId1, userId),
                        eq(friendships.userId2, targetUserId),
                    ),
                    // Did target user already interact with current user?
                    and(
                        eq(friendships.userId1, targetUserId),
                        eq(friendships.userId2, userId),
                    ),
                ),
            });

            if (existingFriendship) {
                if (existingFriendship.status === "accepted") {
                    return c.json(
                        { success: false, error: "You are already friends with this user" },
                        400,
                    );
                } else if (existingFriendship.status === "pending") {
                    // A pending request exists. Who initiated it?
                    if (existingFriendship.userId1 === userId) {
                        // Current user initiated previously.
                        return c.json(
                            { success: false, error: "Friend request already sent" },
                            400,
                        );
                    } else {
                        // Target user initiated previously. Accept it now.
                        console.log(
                            `User ${userId} accepting pending request from ${targetUserId} via POST /request`,
                        );
                        await db
                            .update(friendships)
                            .set({ status: "accepted" })
                            .where(
                                and(
                                    eq(friendships.userId1, targetUserId), // Original initiator
                                    eq(friendships.userId2, userId), // Original recipient (current user)
                                    eq(friendships.status, "pending"),
                                ),
                            )
                            .run(); // Use run() for D1 updates

                        // --- Send Notification: Request Accepted ---
                        const payload: ApnsPayload = {
                            aps: {
                                alert: {
                                    title: "Friend Request Accepted",
                                    body: `${currentUserName} accepted your friend request!`,
                                },
                                sound: "default",
                            },
                            notificationType: "friend_accepted",
                            accepterId: userId, // User who accepted
                            accepterUsername: currentUser?.username,
                        };
                        // Notify the original requester (targetUserId)
                        notifyUser(c, targetUserId, payload);
                        // --- End Notification ---

                        return c.json({
                            success: true,
                            message: "Friend request accepted",
                            status: "accepted", // Reflect the new status
                        });
                    }
                }
            }

            // No existing relationship, create a new pending request
            console.log(`User ${userId} sending friend request to ${targetUserId}`);
            await db.insert(friendships).values({
                userId1: userId, // Initiator
                userId2: targetUserId, // Recipient
                status: "pending",
            });

            // --- Send Notification: Request Received ---
            const payload: ApnsPayload = {
                aps: {
                    alert: {
                        title: "New Friend Request",
                        body: `${currentUserName} sent you a friend request.`,
                    },
                    sound: "default",
                    badge: 1, // Increment badge? Or handle client-side
                },
                notificationType: "friend_request",
                requesterId: userId,
                requesterUsername: currentUser?.username,
            };
            // Notify the target user
            notifyUser(c, targetUserId, payload);
            // --- End Notification ---

            return c.json({
                success: true,
                message: "Friend request sent",
                status: "pending", // Reflect the new status
            });
        } catch (error: any) {
            console.error("Send Friend Request Error:", error);
            // Handle potential unique constraint errors if the check somehow failed
            if (error.message?.includes("UNIQUE constraint failed")) {
                return c.json(
                    {
                        success: false,
                        error: "Friendship already exists or request pending",
                    },
                    409, // Conflict
                );
            }
            return c.json(
                { success: false, error: "Failed to process friend request" },
                500,
            );
        }
    },
);

// --- POST /accept/:requestId (Accept Incoming Request) ---
app.post("/accept/:requestId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id; // This user is accepting (should be recipient)
    const requestId = c.req.param("requestId");
    // Expect format "requesterId-recipientId" from GET /requests
    const [requesterIdStr, recipientIdStr] = requestId.split("-");
    const requesterId = parseInt(requesterIdStr, 10);
    const recipientId = parseInt(recipientIdStr, 10);

    // Validate the IDs and that the current user is the intended recipient
    if (isNaN(requesterId) || isNaN(recipientId) || recipientId !== userId) {
        console.error(
            `Invalid accept request: requestId=${requestId}, userId=${userId}`,
        );
        return c.json(
            { success: false, error: "Invalid or unauthorized request ID" },
            400,
        );
    }

    const db = c.get("db");

    // Get accepter's info for notification
    const accepter = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { username: true, fullName: true },
    });
    if (!accepter) {
        console.error(
            `Could not find accepter user ${userId} details for friend notification.`,
        );
    }
    const accepterName = accepter?.fullName || accepter?.username || `User ${userId}`;

    try {
        // Update the specific pending friendship status to accepted
        const result = await db
            .update(friendships)
            .set({ status: "accepted" })
            .where(
                and(
                    eq(friendships.userId1, requesterId), // The user who sent the request
                    eq(friendships.userId2, userId), // The current user who received it
                    eq(friendships.status, "pending"), // Must be pending
                ),
            )
            .returning({ userId1: friendships.userId1 }); // Check if update happened

        // Check if any row was actually updated
        if (result.length === 0) {
            // Check if it was already accepted or doesn't exist
            const existing = await db.query.friendships.findFirst({
                where: and(
                    eq(friendships.userId1, requesterId),
                    eq(friendships.userId2, userId),
                ),
            });
            return c.json(
                {
                    success: false,
                    error: existing
                        ? "Request already actioned or invalid"
                        : "Pending friend request not found",
                },
                404,
            );
        }

        console.log(`User ${userId} accepted friend request from ${requesterId}`);

        // --- Send Notification: Request Accepted ---
        const payload: ApnsPayload = {
            aps: {
                alert: {
                    title: "Friend Request Accepted",
                    body: `${accepterName} accepted your friend request!`,
                },
                sound: "default",
            },
            notificationType: "friend_accepted",
            accepterId: userId,
            accepterUsername: accepter?.username,
        };
        // Notify the original requester
        notifyUser(c, requesterId, payload);
        // --- End Notification ---

        return c.json({ success: true, message: "Friend request accepted" });
    } catch (error) {
        console.error(`Accept Friend Request Error (ID: ${requestId}):`, error);
        return c.json(
            { success: false, error: "Failed to accept friend request" },
            500,
        );
    }
});

// --- DELETE /reject/:requestId (Reject Incoming Request) ---
app.delete("/reject/:requestId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id; // This user is rejecting (should be recipient)
    const requestId = c.req.param("requestId");
    // Expect format "requesterId-recipientId"
    const [requesterIdStr, recipientIdStr] = requestId.split("-");
    const requesterId = parseInt(requesterIdStr, 10);
    const recipientId = parseInt(recipientIdStr, 10);

    // Validate the IDs and that the current user is the intended recipient
    if (isNaN(requesterId) || isNaN(recipientId) || recipientId !== userId) {
        console.error(
            `Invalid reject request: requestId=${requestId}, userId=${userId}`,
        );
        return c.json(
            { success: false, error: "Invalid or unauthorized request ID" },
            400,
        );
    }

    const db = c.get("db");

    try {
        // Delete the specific pending friendship record
        const result = await db
            .delete(friendships)
            .where(
                and(
                    eq(friendships.userId1, requesterId), // The user who sent the request
                    eq(friendships.userId2, userId), // The current user who received it
                    eq(friendships.status, "pending"), // Must be pending
                ),
            )
            .returning({ id: friendships.userId1 }); // Use returning to check if delete happened

        // Check if any row was actually deleted
        if (result.length === 0) {
            // Check if it was already actioned or doesn't exist
            const existing = await db.query.friendships.findFirst({
                where: and(
                    eq(friendships.userId1, requesterId),
                    eq(friendships.userId2, userId),
                ),
            });
            return c.json(
                {
                    success: false,
                    error: existing
                        ? "Request already actioned or invalid"
                        : "Pending friend request not found",
                },
                404,
            );
        }

        console.log(`User ${userId} rejected friend request from ${requesterId}`);
        // Optional: Notify requester that request was rejected? Generally not done.

        return c.json({ success: true, message: "Friend request rejected" });
    } catch (error) {
        console.error(`Reject Friend Request Error (ID: ${requestId}):`, error);
        return c.json(
            { success: false, error: "Failed to reject friend request" },
            500,
        );
    }
});

// --- DELETE /:friendshipId (Remove Existing Friend) ---
app.delete("/:friendshipId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const friendshipId = c.req.param("friendshipId");
    // Expect format "smallerId-largerId" from GET /
    const [user1IdStr, user2IdStr] = friendshipId.split("-");
    const user1Id = parseInt(user1IdStr, 10);
    const user2Id = parseInt(user2IdStr, 10);

    if (isNaN(user1Id) || isNaN(user2Id)) {
        return c.json(
            { success: false, error: "Invalid friendship ID format" },
            400,
        );
    }

    // Ensure the current user is part of this friendship
    if (userId !== user1Id && userId !== user2Id) {
        return c.json(
            { success: false, error: "Unauthorized to remove this friend" },
            403,
        );
    }

    const db = c.get("db");
    const friendId = userId === user1Id ? user2Id : user1Id; // ID of the friend being removed

    try {
        // Delete the friendship
        // We need to find the actual record which could be (user1Id, user2Id) OR (user2Id, user1Id)
        // depending on who initiated the request originally.
        const result = await db
            .delete(friendships)
            .where(
                and(
                    or(
                        and(
                            eq(friendships.userId1, user1Id),
                            eq(friendships.userId2, user2Id),
                        ),
                        and(
                            eq(friendships.userId1, user2Id),
                            eq(friendships.userId2, user1Id),
                        ),
                    ),
                    // Ensure it's actually an accepted friendship we are removing
                    eq(friendships.status, "accepted"),
                ),
            )
            .returning({ id: friendships.userId1 }); // Use returning to check delete

        // Check if any row was actually deleted
        if (result.length === 0) {
            // Check if friendship exists but maybe wasn't accepted or IDs were wrong
            const existing = await db.query.friendships.findFirst({
                where: or(
                    and(
                        eq(friendships.userId1, user1Id),
                        eq(friendships.userId2, user2Id),
                    ),
                    and(
                        eq(friendships.userId1, user2Id),
                        eq(friendships.userId2, user1Id),
                    ),
                ),
            });
            return c.json(
                {
                    success: false,
                    error: existing
                        ? "Friendship not found or not accepted"
                        : "Friendship not found",
                },
                404,
            );
        }

        console.log(`User ${userId} removed friend ${friendId}`);
        // Optional: Notify the removed friend? Generally not done for privacy/UX.

        return c.json({ success: true, message: "Friend removed" });
    } catch (error) {
        console.error(`Remove Friend Error (ID: ${friendshipId}):`, error);
        return c.json(
            { success: false, error: "Failed to remove friend" },
            500,
        );
    }
});

export default app;
