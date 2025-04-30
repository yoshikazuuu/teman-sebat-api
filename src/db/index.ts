// src/db/index.ts
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// Function to create the Drizzle client instance
// It expects the D1 binding from the Cloudflare Worker environment
export const createDbClient = (d1Binding: D1Database) => {
    return drizzle(d1Binding, { schema });
};

// Export the schema for easy access elsewhere
export { schema };

// Type alias for the Drizzle client instance with our schema
export type DB = ReturnType<typeof createDbClient>;
