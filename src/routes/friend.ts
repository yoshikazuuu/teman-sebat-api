// src/routes/friend.ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, eq, or, sql } from "drizzle-orm";
import { AppEnv } from "../types";
import { users, friendships } from "../db/schema";
import { jwtMiddleware } from "./auth";

// Define validation schemas
const friendRequestSchema = z.object({
    username: z.string().min(1),
});

// Create a router instance
const app = new Hono<AppEnv>();

// --- Existing GET routes remain the same ---

app.get("/", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        // Get accepted friendships where the user is either userId1 or userId2
        const friends = await db.query.friendships.findMany({
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
        const formattedFriends = friends.map((friendship) => {
            const friend =
                friendship.userId1 === userId ? friendship.user2 : friendship.user1;

            return {
                id: friend.id,
                username: friend.username,
                fullName: friend.fullName,
                // Ensure consistent ID format regardless of who initiated
                friendshipId:
                    friendship.userId1 < friendship.userId2
                        ? `${friendship.userId1}-${friendship.userId2}`
                        : `${friendship.userId2}-${friendship.userId1}`,
            };
        });

        return c.json({ success: true, friends: formattedFriends });
    } catch (error) {
        console.error("Get Friends Error:", error);
        return c.json({ success: false, error: "Failed to get friends" }, 500);
    }
});

app.get("/requests", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const db = c.get("db");

    try {
        // Get pending requests where user is the recipient (userId2)
        const pendingRequests = await db.query.friendships.findMany({
            where: and(
                eq(friendships.userId2, userId),
                eq(friendships.status, "pending"),
            ),
            with: {
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
            id: request.user1.id,
            username: request.user1.username,
            fullName: request.user1.fullName,
            // Use consistent ID format
            requestId:
                request.userId1 < request.userId2
                    ? `${request.userId1}-${request.userId2}`
                    : `${request.userId2}-${request.userId1}`,
        }));

        return c.json({ success: true, requests: formattedRequests });
    } catch (error) {
        console.error("Get Requests Error:", error);
        return c.json(
            { success: false, error: "Failed to get friend requests" },
            500,
        );
    }
});

app.get("/search", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const query = c.req.query("q");

    if (!query || query.length < 3) {
        return c.json(
            {
                success: false,
                error: "Search query must be at least 3 characters",
            },
            400,
        );
    }

    const db = c.get("db");

    try {
        // Search for users by username (exclude current user)
        const searchResults = await db.query.users.findMany({
            where: and(
                sql`lower(${users.username}) LIKE ${`%${query.toLowerCase()}%`}`,
                sql`${users.id} != ${userId}`,
            ),
            columns: {
                id: true,
                username: true,
                fullName: true,
            },
        });

        if (searchResults.length === 0) {
            return c.json({ success: true, users: [] });
        }

        // Get existing friendships to mark already friends or pending
        const targetUserIds = searchResults.map((u) => u.id);
        const existingFriendships = await db.query.friendships.findMany({
            where: or(
                and(
                    eq(friendships.userId1, userId),
                    sql`${friendships.userId2} IN ${targetUserIds}`,
                ),
                and(
                    eq(friendships.userId2, userId),
                    sql`${friendships.userId1} IN ${targetUserIds}`,
                ),
            ),
        });

        // Add status to search results
        const formattedResults = searchResults.map((user) => {
            const friendship = existingFriendships.find(
                (f) =>
                    (f.userId1 === userId && f.userId2 === user.id) ||
                    (f.userId2 === userId && f.userId1 === user.id),
            );

            return {
                id: user.id,
                username: user.username,
                fullName: user.fullName,
                status: friendship?.status || "none",
                // If user is the requester, pending request was sent, otherwise it was received
                direction: friendship
                    ? friendship.userId1 === userId
                        ? "sent"
                        : "received"
                    : null,
            };
        });

        return c.json({ success: true, users: formattedResults });
    } catch (error) {
        console.error("Search Users Error:", error);
        return c.json({ success: false, error: "Failed to search users" }, 500);
    }
});

// --- POST and DELETE routes with fixes ---

app.post(
    "/request",
    jwtMiddleware,
    zValidator("json", friendRequestSchema),
    async (c) => {
        const userId = c.get("jwtPayload").id;
        const { username } = c.req.valid("json");
        const db = c.get("db");

        try {
            // Find user by username
            const targetUser = await db.query.users.findFirst({
                where: eq(users.username, username),
                columns: {
                    id: true,
                },
            });

            if (!targetUser) {
                return c.json({ success: false, error: "User not found" }, 404);
            }

            if (targetUser.id === userId) {
                return c.json(
                    { success: false, error: "You cannot add yourself as a friend" },
                    400,
                );
            }

            // Ensure consistent order for userId1 and userId2
            const user1Id = Math.min(userId, targetUser.id);
            const user2Id = Math.max(userId, targetUser.id);

            // Check if a friendship already exists
            const existingFriendship = await db.query.friendships.findFirst({
                where: and(
                    eq(friendships.userId1, user1Id),
                    eq(friendships.userId2, user2Id),
                ),
            });

            if (existingFriendship) {
                if (existingFriendship.status === "accepted") {
                    return c.json(
                        { success: false, error: "You are already friends with this user" },
                        400,
                    );
                } else if (existingFriendship.userId1 === userId) {
                    // The current user initiated the request previously
                    return c.json(
                        { success: false, error: "Friend request already sent" },
                        400,
                    );
                } else {
                    // The target user initiated the request previously, accept it
                    await db
                        .update(friendships)
                        .set({ status: "accepted" })
                        .where(
                            and(
                                eq(friendships.userId1, user1Id),
                                eq(friendships.userId2, user2Id),
                            ),
                        )
                        .run(); // Use run()

                    return c.json({
                        success: true,
                        message: "Friend request accepted",
                        status: "accepted",
                    });
                }
            }

            // Create a new friendship request
            await db.insert(friendships).values({
                userId1: userId, // The initiator is always userId1 on creation
                userId2: targetUser.id,
                status: "pending",
            });

            // Re-order for consistency before inserting if needed, or handle during query/accept
            // Let's stick to initiator = userId1, recipient = userId2 for pending
            // await db.insert(friendships).values({
            //     userId1: user1Id,
            //     userId2: user2Id,
            //     status: "pending",
            // });

            return c.json({
                success: true,
                message: "Friend request sent",
                status: "pending",
            });
        } catch (error) {
            console.error("Send Friend Request Error:", error);
            // Handle potential unique constraint errors if needed
            return c.json(
                { success: false, error: "Failed to send friend request" },
                500,
            );
        }
    },
);

app.post("/accept/:requestId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const requestId = c.req.param("requestId");
    // Assuming requestId format is "user1Id-user2Id" where user1Id < user2Id
    // Or it could be "requesterId-recipientId" - let's assume the latter for now
    const [requesterIdStr, recipientIdStr] = requestId.split("-");
    const requesterId = parseInt(requesterIdStr, 10);
    const recipientId = parseInt(recipientIdStr, 10);

    // Validate the recipient is the current user
    if (isNaN(requesterId) || isNaN(recipientId) || recipientId !== userId) {
        return c.json({ success: false, error: "Invalid or unauthorized request ID" }, 400);
    }

    const db = c.get("db");

    try {
        // Update friendship status to accepted
        // Ensure we target the correct pending request where the current user is userId2
        const result = await db
            .update(friendships)
            .set({ status: "accepted" })
            .where(
                and(
                    eq(friendships.userId1, requesterId), // The user who sent the request
                    eq(friendships.userId2, userId), // The current user who received it
                    eq(friendships.status, "pending"),
                ),
            )
            .run(); // Use run() instead of returning()

        // Check if any row was actually updated
        if (result.meta.changes === 0) {
            return c.json(
                { success: false, error: "Pending friend request not found" },
                404,
            );
        }

        return c.json({ success: true, message: "Friend request accepted" });
    } catch (error) {
        console.error("Accept Friend Request Error:", error);
        return c.json(
            { success: false, error: "Failed to accept friend request" },
            500,
        );
    }
});

app.delete("/reject/:requestId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const requestId = c.req.param("requestId");
    const [requesterIdStr, recipientIdStr] = requestId.split("-");
    const requesterId = parseInt(requesterIdStr, 10);
    const recipientId = parseInt(recipientIdStr, 10);

    // Validate the recipient is the current user
    if (isNaN(requesterId) || isNaN(recipientId) || recipientId !== userId) {
        return c.json({ success: false, error: "Invalid or unauthorized request ID" }, 400);
    }

    const db = c.get("db");

    try {
        // Delete the friendship record for the pending request
        const result = await db
            .delete(friendships)
            .where(
                and(
                    eq(friendships.userId1, requesterId), // The user who sent the request
                    eq(friendships.userId2, userId), // The current user who received it
                    eq(friendships.status, "pending"),
                ),
            )
            .run(); // Use run()

        // Check if any row was actually deleted
        if (result.meta.changes === 0) {
            return c.json(
                { success: false, error: "Pending friend request not found" },
                404,
            );
        }

        return c.json({ success: true, message: "Friend request rejected" });
    } catch (error) {
        console.error("Reject Friend Request Error:", error);
        return c.json(
            { success: false, error: "Failed to reject friend request" },
            500,
        );
    }
});

app.delete("/:friendshipId", jwtMiddleware, async (c) => {
    const userId = c.get("jwtPayload").id;
    const friendshipId = c.req.param("friendshipId");
    // Assume friendshipId is always "smallerId-largerId"
    const [user1IdStr, user2IdStr] = friendshipId.split("-");
    const user1Id = parseInt(user1IdStr, 10);
    const user2Id = parseInt(user2IdStr, 10);

    if (isNaN(user1Id) || isNaN(user2Id)) {
        return c.json({ success: false, error: "Invalid friendship ID format" }, 400);
    }

    // Ensure the current user is part of this friendship
    if (userId !== user1Id && userId !== user2Id) {
        return c.json({ success: false, error: "Unauthorized to remove this friend" }, 403);
    }

    const db = c.get("db");

    try {
        // Delete the friendship (works regardless of who initiated)
        // We need to find the friendship based potentially on reversed IDs if we didn't enforce order
        const result = await db
            .delete(friendships)
            .where(
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
                // No need for the extra OR condition checking userId, already validated above
            )
            .run(); // Use run()

        // Check if any row was actually deleted
        if (result.meta.changes === 0) {
            return c.json({ success: false, error: "Friendship not found" }, 404);
        }

        return c.json({ success: true, message: "Friend removed" });
    } catch (error) {
        console.error("Remove Friend Error:", error);
        return c.json({ success: false, error: "Failed to remove friend" }, 500);
    }
});

export default app;
