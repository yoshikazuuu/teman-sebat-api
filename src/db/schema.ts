import { relations, sql } from "drizzle-orm";
import {
    integer,
    sqliteTable,
    text,
    primaryKey,
    uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Users Table
export const users = sqliteTable(
    "users",
    {
        id: integer("id", { mode: "number" }).primaryKey({
            autoIncrement: true,
        }),
        username: text("username").notNull().unique(),
        // Store hashed passwords, never plaintext
        passwordHash: text("password_hash").notNull(),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(sql`(unixepoch())`), // Use SQLite function for current timestamp
    },
    (table) => {
        return {
            usernameIdx: uniqueIndex("username_idx").on(table.username),
        };
    },
);

// Friendships Table
// Represents the connection between two users
export const friendships = sqliteTable(
    "friendships",
    {
        // User who initiated the request
        userId1: integer("user_id_1", { mode: "number" })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // User who received/accepted the request
        userId2: integer("user_id_2", { mode: "number" })
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        // Status: 'pending', 'accepted'
        status: text("status", { enum: ["pending", "accepted"] })
            .notNull()
            .default("pending"),
        createdAt: integer("created_at", { mode: "timestamp" })
            .notNull()
            .default(sql`(unixepoch())`),
    },
    (table) => {
        // Composite primary key to ensure uniqueness of the pair
        // and allows easy querying regardless of who initiated
        return {
            pk: primaryKey({ columns: [table.userId1, table.userId2] }),
        };
    },
);

// Smoking Sessions Table
export const smokingSessions = sqliteTable("smoking_sessions", {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: integer("user_id", { mode: "number" })
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    startTime: integer("start_time", { mode: "timestamp" })
        .notNull()
        .default(sql`(unixepoch())`),
    // Can be null if the session is ongoing or never explicitly ended
    endTime: integer("end_time", { mode: "timestamp" }),
});

// Session Responses Table
export const sessionResponses = sqliteTable("session_responses", {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    sessionId: integer("session_id", { mode: "number" })
        .notNull()
        .references(() => smokingSessions.id, { onDelete: "cascade" }),
    responderId: integer("responder_id", { mode: "number" })
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    // Response types: 'coming', 'done', 'coming_5'
    responseType: text("response_type", {
        enum: ["coming", "done", "coming_5"],
    }).notNull(),
    timestamp: integer("timestamp", { mode: "timestamp" })
        .notNull()
        .default(sql`(unixepoch())`),
});

// Device Tokens Table (for Push Notifications)
export const deviceTokens = sqliteTable("device_tokens", {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    userId: integer("user_id", { mode: "number" })
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    // The actual device token string from APNS/FCM
    token: text("token").notNull().unique(),
    // 'ios', 'android' (though we start with ios)
    platform: text("platform", { enum: ["ios", "android"] }).notNull(),
    lastUpdated: integer("last_updated", { mode: "timestamp" })
        .notNull()
        .default(sql`(unixepoch())`),
});

// --- Define Relations ---

export const usersRelations = relations(users, ({ many }) => ({
    // A user can initiate many friendships (as userId1)
    initiatedFriendships: many(friendships, { relationName: "user1" }),
    // A user can receive many friendships (as userId2)
    receivedFriendships: many(friendships, { relationName: "user2" }),
    // A user can start many smoking sessions
    smokingSessions: many(smokingSessions),
    // A user can give many responses
    sessionResponses: many(sessionResponses),
    // A user can have multiple device tokens (though often just one per platform)
    deviceTokens: many(deviceTokens),
}));

export const friendshipsRelations = relations(friendships, ({ one }) => ({
    // Relation back to the initiating user
    user1: one(users, {
        fields: [friendships.userId1],
        references: [users.id],
        relationName: "user1",
    }),
    // Relation back to the receiving user
    user2: one(users, {
        fields: [friendships.userId2],
        references: [users.id],
        relationName: "user2",
    }),
}));

export const smokingSessionsRelations = relations(
    smokingSessions,
    ({ one, many }) => ({
        // Relation back to the user who started the session
        user: one(users, {
            fields: [smokingSessions.userId],
            references: [users.id],
        }),
        // A session can have many responses
        responses: many(sessionResponses),
    }),
);

export const sessionResponsesRelations = relations(
    sessionResponses,
    ({ one }) => ({
        // Relation back to the session being responded to
        session: one(smokingSessions, {
            fields: [sessionResponses.sessionId],
            references: [smokingSessions.id],
        }),
        // Relation back to the user who responded
        responder: one(users, {
            fields: [sessionResponses.responderId],
            references: [users.id],
        }),
    }),
);

export const deviceTokensRelations = relations(deviceTokens, ({ one }) => ({
    // Relation back to the user owning the token
    user: one(users, {
        fields: [deviceTokens.userId],
        references: [users.id],
    }),
}));
