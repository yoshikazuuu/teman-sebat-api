# Multi-stage production Dockerfile for Bun + TypeScript API

# Stage 1: Build stage
FROM oven/bun:1.1.34-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package management files
COPY package.json bun.lock* ./

# Install dependencies (including dev dependencies for build)
RUN bun install --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build the application
RUN bun run build

# Stage 2: Runtime dependencies
FROM oven/bun:1.1.34-alpine AS deps

WORKDIR /app

# Copy package management files
COPY package.json bun.lock* ./

# Install only production dependencies
RUN bun install --frozen-lockfile --production

# Stage 3: Production runtime
FROM oven/bun:1.1.34-alpine AS runtime

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S bunuser -u 1001

# Set working directory
WORKDIR /app

# Copy built application from builder stage
COPY --from=builder --chown=bunuser:nodejs /app/dist ./dist

# Copy production dependencies from deps stage
COPY --from=deps --chown=bunuser:nodejs /app/node_modules ./node_modules

# Copy package.json for metadata
COPY --chown=bunuser:nodejs package.json ./

# Create data directory with proper permissions
RUN mkdir -p /app/data && chown -R bunuser:nodejs /app/data

# Switch to non-root user
USER bunuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun --version || exit 1

# Set environment to production
ENV NODE_ENV=production

# Start the application
CMD ["bun", "run", "dist/server.js"] 