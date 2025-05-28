// Update the drizzle.config.ts for SQLite with Docker setup
import { defineConfig } from "drizzle-kit";
import { config } from 'dotenv';

// Load environment variables
config();

// Default database path if not specified in environment
const dbPath = process.env.DB_PATH || './data/teman-sebat.sqlite';

export default defineConfig({
  dialect: "sqlite",
  out: "drizzle",
  schema: "./src/db/schema.ts",
  dbCredentials: {
    url: dbPath
  },
});
