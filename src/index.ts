import { Env, Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createDbClient, DB } from "./db";
import { Environment } from "../bindings";

// Create the Hono app instance, specifying the Env type
const app = new Hono<Environment>();

// --- Middleware ---
app.use("*", logger()); // Log all requests
app.use(
  "*",
  cors({
    // Configure CORS for your frontend URL in production
    origin: "*", // Allow all for now, restrict later
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// --- Database Middleware ---
// Attach the Drizzle client instance to the context (c.var.db)
// for easy access in route handlers.
app.use("*", async (c, next) => {
  if (!c.env.DB) {
    console.error("D1 Database binding 'DB' not found in environment.");
    return c.json({ error: "Internal server error" }, 500);
  }
  const db = createDbClient(c.env.DB);
  // Use c.set to attach the db instance to the context
  c.set("db", db)
  await next();
});

// --- Type helper for context with DB ---
// This makes it easier to type route handlers
export type AppContext = typeof app extends Hono<
  Environment,
  any,
  infer I
>
  ? I & { Variables: { db: DB } }
  : never;

// --- Basic Routes ---
app.get("/", (c) => {
  return c.text("👋 Teman Sebat API is running!");
});

// --- TODO: Add Route Handlers ---
// import authRoutes from './routes/auth';
// import friendRoutes from './routes/friends';
// import smokingRoutes from './routes/smoking';
//
// app.route('/auth', authRoutes);
// app.route('/friends', friendRoutes);
// app.route('/smoking', smokingRoutes);

// --- Error Handling ---
app.onError((err, c) => {
  console.error(`${err}`);
  // Basic error response
  return c.json({ error: "Internal server error", message: err.message }, 500);
});

// Export the app for Cloudflare Workers
export default app;
