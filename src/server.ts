// src/server.ts
import { config } from 'dotenv';
import { app, initSQLiteDb } from './local-index';
import path from 'path';
import fs from 'fs';

// Load environment variables from .env file
config();

// Check for required environment variables
const requiredEnvVars = [
  'DB_PATH',
  'JWT_SECRET',
  'APPLE_BUNDLE_ID',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY',
  'APNS_ENVIRONMENT'
];

const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingVars.length > 0) {
  console.error(`Error: Missing required environment variables: ${missingVars.join(', ')}`);
  console.error('Please check your .env file');
  process.exit(1);
}

// Ensure the database directory exists
const dbPath = process.env.DB_PATH!;
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  console.log(`Creating database directory: ${dbDir}`);
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize the SQLite database
initSQLiteDb(dbPath);

// Create a binding object that provides environment variables to the Hono app
const bindings = {
  JWT_SECRET: process.env.JWT_SECRET!,
  APPLE_BUNDLE_ID: process.env.APPLE_BUNDLE_ID!,
  APNS_KEY_ID: process.env.APNS_KEY_ID!,
  APNS_TEAM_ID: process.env.APNS_TEAM_ID!,
  APNS_PRIVATE_KEY: process.env.APNS_PRIVATE_KEY!,
  APNS_ENVIRONMENT: process.env.APNS_ENVIRONMENT as 'development' | 'production'
};

// Start the server using Bun's built-in server
const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`🚀 Teman Sebat API starting on port ${port}`);
console.log(`📦 Database: ${dbPath}`);
console.log(`🔧 Environment: ${process.env.APNS_ENVIRONMENT || 'development'}`);

// Start Bun server
Bun.serve({
  port,
  fetch: (request: Request) => {
    return app.fetch(request, bindings);
  },
});

console.log(`✅ Server is running on http://localhost:${port}`);
