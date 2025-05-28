FROM oven/bun:latest

# Set the working directory
WORKDIR /app

# Copy package.json and bun.lock
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy the rest of the application code
COPY . .

# Build the application
RUN bun run build

# Expose the port the application runs on
EXPOSE 3000

# Set the command to start the application
CMD ["bun", "run", "start"] 