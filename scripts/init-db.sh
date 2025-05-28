#!/bin/bash
# Initialize and migrate SQLite database for local development

# Load environment variables
source .env 2>/dev/null || echo "No .env file found, using defaults"

# Set default database path if not in environment
DB_PATH=${DB_PATH:-"./data/teman-sebat.sqlite"}
DB_DIR=$(dirname "$DB_PATH")

# Create database directory if it doesn't exist
mkdir -p "$DB_DIR"
echo "Ensuring database directory exists: $DB_DIR"

# Check if the database file exists
if [ ! -f "$DB_PATH" ]; then
    echo "Creating new SQLite database at: $DB_PATH"
    touch "$DB_PATH"
else
    echo "Using existing database at: $DB_PATH"
fi

# Run migrations using Drizzle with bun
echo "Running database migrations..."
bun drizzle-kit generate --config=drizzle.local.config.ts
bun drizzle-kit migrate --config=drizzle.local.config.ts

echo "Database migration complete!"
