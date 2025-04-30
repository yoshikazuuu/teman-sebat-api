# TemanSebat API

Backend API for TemanSebat, a social smoking app that allows users to notify friends when they're smoking and receive responses.

## Features

- **Authentication**
  - Apple Sign-In integration
  - JWT-based authentication

- **User Management**
  - Profile creation and updates
  - Device token registration for push notifications

- **Friend Management**
  - Search for users
  - Send, accept, and reject friend requests
  - View friends and pending requests

- **Smoking Sessions (Core Feature)**
  - Start and end smoking sessions
  - Notify friends when a session begins
  - Respond with "I'll be there", "I've done", or "I'll be there in 5 minutes"
  - View active sessions from friends
  - Track session history

## Tech Stack

- **Hono.js** - Lightweight web framework
- **Cloudflare Workers** - Serverless runtime
- **Drizzle ORM** - SQL ORM
- **Cloudflare D1** - Serverless SQL database
- **TypeScript** - Type-safe JavaScript

## Development

### Prerequisites

- Node.js 18+ or Bun 1.0+
- Cloudflare account
- Wrangler CLI

### Setup

1. Clone the repository
2. Install dependencies:

```bash
npm install
# or
bun install
```

3. Set up local D1 database:

```bash
wrangler d1 create teman-sebat
wrangler d1 execute teman-sebat --local --file=./drizzle/0000_freezing_joseph.sql
```

4. Update the database configuration in `wrangler.jsonc` if needed.

5. Start the development server:

```bash
npm run dev
# or
bun run dev
```

### Database Migrations

Generate schema changes:

```bash
npx drizzle-kit generate:sqlite
```

Push schema changes to the database:

```bash
npx drizzle-kit push:sqlite
```

## Deployment

1. Configure the JWT secret for production in `wrangler.jsonc` or use Cloudflare's secret manager:

```bash
wrangler secret put JWT_SECRET
```

2. Deploy to Cloudflare Workers:

```bash
npm run deploy
# or
bun run deploy
```

## API Endpoints

### Authentication

- `POST /auth/apple` - Sign in/up with Apple

### User Management

- `GET /users/profile` - Get current user profile
- `PATCH /users/profile` - Update user profile
- `POST /users/devices` - Register device token
- `DELETE /users/devices/:token` - Delete device token

### Friend Management

- `GET /friends` - Get all friends
- `GET /friends/requests` - Get pending friend requests
- `GET /friends/search` - Search for users
- `POST /friends/request` - Send friend request
- `POST /friends/accept/:requestId` - Accept friend request
- `DELETE /friends/reject/:requestId` - Reject friend request
- `DELETE /friends/:friendshipId` - Remove friend

### Smoking Sessions

- `POST /smoking/start` - Start a smoking session
- `POST /smoking/end/:sessionId` - End a smoking session
- `GET /smoking/active` - Get active smoking sessions of friends
- `POST /smoking/respond/:sessionId` - Respond to a smoking session
- `GET /smoking/responses/:sessionId` - Get responses for a specific session
- `GET /smoking/history` - Get user's session history

## iOS Client Integration

For the iOS SwiftUI client, implement:

1. Apple Sign In authentication
2. Push notifications registration with APNS
3. UI for friend management
4. Interface for smoking sessions
5. Real-time notifications for session updates

## Security

- Always use HTTPS in production
- Replace the JWT secret before deployment
- Consider implementing rate limiting for production
- Store sensitive values in Cloudflare's secret manager

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```bash
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
