// src/db/sqlite.ts
import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';

// Function to create a SQLite database client
export const createSqliteClient = (dbPath: string) => {
  const sqlite = new Database(dbPath);
  return drizzle(sqlite, { schema });
};

// Export the schema for easy access elsewhere
export { schema };

// Type alias for the Drizzle client instance with our schema
export type SQLiteDB = ReturnType<typeof createSqliteClient>;
