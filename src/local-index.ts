// src/local-index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./db/schema";

// Import route handlers
import authRoutes from "./routes/auth";
import userRoutes from "./routes/user";
import friendRoutes from "./routes/friend";
import smokingRoutes from "./routes/smoking";

// Create a type for the local environment
type LocalEnv = {
  Variables: {
    db: any;
    jwtPayload?: {
      id: number;
      exp: number;
      [key: string]: any;
    };
    apnsAuthToken?: { token: string; expires: number };
  };
};

// Create the Hono app instance with the local environment
const app = new Hono<LocalEnv>();

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

// --- Request Body Logging Middleware ---
app.use("*", async (c, next) => {
  if (c.req.method === "POST") {
    try {
      // Read the body and log it
      const contentType = c.req.header("Content-Type");

      // Store original body parser result
      let body;
      if (contentType?.includes("application/json")) {
        // Create a copy of the request to avoid consuming the body
        const reqCopy = new Request(c.req.raw.url, {
          method: c.req.method,
          headers: c.req.raw.headers,
          body: c.req.raw.clone().body
        });

        body = await reqCopy.json();
      } else {
        // For non-JSON content types
        const reqCopy = new Request(c.req.raw.url, {
          method: c.req.method,
          headers: c.req.raw.headers,
          body: c.req.raw.clone().body
        });

        body = await reqCopy.text();
      }

      console.log(`[${c.req.method}] ${c.req.url} - Request Body:`, body);
    } catch (err) {
      console.log(`[${c.req.method}] ${c.req.url} - Failed to log request body:`, err);
    }
  }
  await next();
});

// --- Database Setup ---
// Initialize SQLite database using Bun's native SQLite and attach to each request
const initSQLiteDb = (dbPath: string) => {
  console.log(`Initializing SQLite database at: ${dbPath}`);
  const sqlite = new Database(dbPath, { create: true });
  const db = drizzle(sqlite, { schema });

  // Middleware to attach DB to each request
  app.use("*", async (c, next) => {
    c.set('db', db);
    await next();
  });
};

// --- Basic Routes ---
app.get("/", (c) => {
  return c.text("👋 Teman Sebat API is running locally with Bun SQLite!");
});

// --- Register Route Handlers ---
app.route("/auth", authRoutes);
app.route("/users", userRoutes);
app.route("/friends", friendRoutes);
app.route("/smoking", smokingRoutes);

// --- Error Handling ---
app.onError((err, c) => {
  console.error(`${err}`);
  // Basic error response
  return c.json({ error: "Internal server error", message: err.message }, 500);
});

export { app, initSQLiteDb };
