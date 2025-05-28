// src/db/index.ts
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

// Function to create the SQLite Drizzle client instance using Bun's native SQLite
export const createDbClient = (dbPath: string) => {
  const sqlite = new Database(dbPath, { create: true });
  return drizzle(sqlite, { schema });
};

// Export the schema for easy access elsewhere
export { schema };

// Type alias for the Drizzle client instance with our schema
export type DB = ReturnType<typeof createDbClient>;
