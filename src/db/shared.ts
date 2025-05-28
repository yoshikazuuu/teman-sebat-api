// src/db/shared.ts
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// Function to create the Drizzle client instance for D1
// It expects the D1 binding from the Cloudflare Worker environment
export const createD1Client = (d1Binding: D1Database) => {
  return drizzle(d1Binding, { schema });
};

// Type for database in both environments
export type Database = ReturnType<typeof createD1Client> | any;

// Export the schema for easy access elsewhere
export { schema };
