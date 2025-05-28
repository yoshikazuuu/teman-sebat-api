// src/server.ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
import type { AppEnv } from './types'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { Database } from 'bun:sqlite'
import * as schema from './db/schema'
import { cors } from "hono/cors";
import { logger } from "hono/logger";

// Import route handlers
import authRoutes from "./routes/auth";
import userRoutes from "./routes/user";
import friendRoutes from "./routes/friend";
import smokingRoutes from "./routes/smoking";

// Load environment variables from .env file
config()

// Check for required environment variables
const requiredEnvVars = [
  'DB_PATH',
  'JWT_SECRET',
  'APPLE_BUNDLE_ID',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY_BASE64',
  'APNS_ENVIRONMENT'
]

const missingVars = requiredEnvVars.filter(varName => !process.env[varName])
if (missingVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingVars.join(', ')}`)
  console.error('Please check your .env file')
  process.exit(1)
}

// Ensure the database directory exists
const dbPath = process.env.DB_PATH!
const dbDir = path.dirname(dbPath)
if (!fs.existsSync(dbDir)) {
  console.log(`Creating database directory: ${dbDir}`)
  fs.mkdirSync(dbDir, { recursive: true })
}

// Initialize SQLite database with schema
const sqlite = new Database(dbPath, { create: true })
const db = drizzle(sqlite, { schema })

// Create Hono app with proper typing
const app = new Hono<AppEnv>()

// --- Middleware ---
app.use("*", logger()); // Log all requests
app.use(
  "*",
  cors({
    origin: "*", // Allow all for development
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    exposeHeaders: ["Content-Length", "X-Total-Count"],
    maxAge: 600,
  }),
);

// Middleware to inject database into context
app.use('*', async (c, next) => {
  c.set('db', db)
  await next()
})

// --- Request Body Logging Middleware ---
app.use("*", async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "PATCH") {
    try {
      const contentType = c.req.header("Content-Type");
      let body;
      // Clone the request to read the body without consuming it for subsequent handlers
      const reqClone = c.req.raw.clone();
      if (contentType?.includes("application/json")) {
        body = await reqClone.json();
      } else if (contentType?.includes("application/x-www-form-urlencoded") || contentType?.includes("multipart/form-data")) {
        // For form data, text() might be more appropriate or specific parsing needed
        // For simplicity, logging as text. Multipart might need more complex handling if files are involved.
        body = await reqClone.text();
      } else {
        body = await reqClone.text();
      }
      console.log(`[${c.req.method}] ${c.req.url} - Request Body:`, body);
    } catch (err) {
      console.log(`[${c.req.method}] ${c.req.url} - Failed to log request body:`, err);
    }
  }
  await next();
});

// Create bindings object that provides environment variables
const bindings: AppEnv['Bindings'] = {
  JWT_SECRET: process.env.JWT_SECRET!,
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID!,
  APNS_KEY_ID: process.env.APNS_KEY_ID!,
  APNS_TEAM_ID: process.env.APNS_TEAM_ID!,
  APNS_PRIVATE_KEY_BASE64: process.env.APNS_PRIVATE_KEY_BASE64!,
  APNS_ENVIRONMENT: process.env.APNS_ENVIRONMENT as 'development' | 'production'
}

// --- Basic Routes ---
app.get("/", (c) => {
  return c.text("👋 Teman Sebat API is running!");
});

// --- Register Route Handlers ---
app.route("/auth", authRoutes);
app.route("/users", userRoutes);
app.route("/friends", friendRoutes);
app.route("/smoking", smokingRoutes);

// --- Error Handling ---
app.onError((err, c) => {
  console.error(`Error in ${c.req.method} ${c.req.url}:`, err);
  return c.json({ error: "Internal server error", message: err.message }, 500);
});

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000

console.log(`🚀 Teman Sebat API starting on port ${port}`)
console.log(`📦 Database: ${dbPath}`)
console.log(`🔧 Environment: ${process.env.APNS_ENVIRONMENT || 'development'}`)

// Start server with proper bindings
serve({
  fetch: (request: Request) => app.fetch(request, bindings),
  port
})

console.log(`✅ Server is running on http://localhost:${port}`)
