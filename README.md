# 🚬 Teman Sebat API

A fast, local-first API for tracking smoking habits and connecting with friends for mutual accountability. Built with **Bun**, **Hono**, and **SQLite**.

## ⚡ Quick Start

### Prerequisites

- [Bun](https://bun.sh/) (latest version)
- Git

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd teman-sebat-api
   ```

2. **Install dependencies**
   ```bash
   bun install
   ```

3. **Set up environment variables**
   ```bash
   # Copy the example environment file
   cp .env.example .env
   
   # Edit .env with your configuration
   vim .env
   ```

4. **Initialize the database**
   ```bash
   bun run db:init
   ```

5. **Start the development server**
   ```bash
   bun run dev
   ```

The API will be available at `http://localhost:3000`

## 🛠️ Development Commands

| Command | Description |
|---------|-------------|
| `bun run dev` | Start development server |
| `bun run dev:watch` | Start development server with auto-reload |
| `bun run build` | Build for production |
| `bun run start` | Start production server |
| `bun run db:init` | Initialize and migrate database |
| `bun run db:generate` | Generate new database migrations |
| `bun run db:migrate` | Run database migrations |
| `bun run db:studio` | Open Drizzle Studio (database GUI) |

## 🏗️ Architecture

### Tech Stack
- **Runtime**: [Bun](https://bun.sh/) - Fast JavaScript runtime with built-in SQLite
- **Framework**: [Hono](https://hono.dev/) - Lightweight web framework
- **Database**: [Bun SQLite](https://bun.sh/docs/api/sqlite) - Native SQLite driver
- **ORM**: [Drizzle ORM](https://orm.drizzle.team/) - TypeScript ORM
- **Validation**: [Zod](https://zod.dev/) - Schema validation
- **Authentication**: [Jose](https://github.com/panva/jose) - JWT handling

### Project Structure
```
src/
├── db/                 # Database configuration and schema
│   ├── schema.ts      # Database schema definitions
│   └── index.ts       # Database client setup
├── lib/               # Shared utilities and libraries
├── routes/            # API route handlers
│   ├── auth.ts       # Authentication endpoints
│   ├── user.ts       # User management
│   ├── friend.ts     # Friend/social features
│   └── smoking.ts    # Smoking tracking
├── utils/            # Utility functions
├── types.ts          # TypeScript type definitions
├── local-index.ts    # Local development app setup
└── server.ts         # Server entry point
```

## 📊 Database

The application uses **Bun's native SQLite driver** for optimal performance. The database file is stored locally at `./data/teman-sebat.sqlite` by default.

### Schema Management

Migrations are managed with **Drizzle Kit**:

```bash
# Generate new migration after schema changes
bun run db:generate

# Apply migrations
bun run db:migrate

# Open database GUI
bun run db:studio
```

## 🔧 Configuration

### Environment Variables

Create a `.env` file with the following variables:

```bash
# Database
DB_PATH=./data/teman-sebat.sqlite

# Server
PORT=3000

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key

# Apple Push Notification Service (APNS)
APNS_KEY_ID=your-apns-key-id
APNS_TEAM_ID=your-apple-team-id
APNS_PRIVATE_KEY_BASE64=LS0tLS1CRUdJTi...your-base64-encoded-p8-key...FRSVZBVEUgS0VZLS0tLS0=
APPLE_BUNDLE_ID=your.app.bundle.id
APNS_ENVIRONMENT=development
```

## 🚀 API Endpoints

### Authentication
- `POST /auth/apple` - Apple Sign-In authentication

### Users
- `GET /users/profile` - Get user profile
- `PUT /users/profile` - Update user profile
- `POST /users/device-token` - Register device for push notifications

### Friends
- `GET /friends` - Get friends list
- `POST /friends/add` - Send friend request
- `POST /friends/accept` - Accept friend request
- `DELETE /friends/:friendId` - Remove friend

### Smoking Tracking
- `POST /smoking/sessions` - Log smoking session
- `GET /smoking/sessions` - Get smoking history
- `POST /smoking/sessions/:sessionId/responses` - Respond to friend's session

## ⚡ Performance

This setup leverages **Bun's native SQLite driver**, which is:
- **3-6x faster** than better-sqlite3
- **8-9x faster** than other JavaScript SQLite drivers
- Zero external dependencies for SQLite
- Built-in TypeScript support

## 🔒 Security Features

- JWT-based authentication
- Apple Sign-In integration
- Input validation with Zod schemas
- CORS protection
- Environment variable validation

## 📱 Push Notifications

The API includes **Apple Push Notification Service (APNS)** integration for:
- Friend request notifications
- Smoking session alerts
- Accountability reminders

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests and ensure everything works
5. Commit your changes (`git commit -m 'Add amazing feature'`)
6. Push to the branch (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## 📝 License

This project is licensed under the MIT License.

---

**Built with ❤️ using Bun and modern web technologies**

# APNS Configuration

The application supports Apple Push Notification service (APNs) with enhanced reliability and network compatibility features.

## Environment Variables

### Required APNS Variables
- `APNS_KEY_ID`: Your APNS Auth Key ID from Apple Developer Console
- `APNS_TEAM_ID`: Your Apple Developer Team ID
- `APNS_PRIVATE_KEY_BASE64`: The base64-encoded content of your .p8 private key file
- `APNS_ENVIRONMENT`: Either "development" (sandbox) or "production"
- `APPLE_BUNDLE_ID`: Your iOS app's bundle identifier

### Optional APNS Variables
- `APNS_USE_PORT_2197`: Set to "true" or "1" to use port 2197 by default instead of port 443

## APNS Network Reliability Features

### Port 2197 Support
Apple recommends using port 2197 instead of port 443 for APNs in certain network environments:
- Corporate firewalls that block HTTPS traffic
- Networks with proxy servers
- Local development environments with network restrictions

The application automatically falls back to port 2197 when port 443 fails with network connectivity issues.

### Automatic Retry Logic
- **Default behavior**: Try port 443 first, then retry with port 2197 on network failures
- **Configurable retries**: Up to 2 retry attempts with 1-second delays
- **Smart error handling**: Distinguishes between network errors (retryable) and APNS errors (non-retryable)
- **Invalid token tracking**: Automatically identifies and logs invalid device tokens for cleanup

### Network Error Types That Trigger Port Fallback
- `Malformed_HTTP_Response` errors
- General fetch/network connection failures
- Connection timeout issues

## Usage Examples

### Force Port 2197 (if you have network issues with port 443)
Set the environment variable:
```bash
APNS_USE_PORT_2197=true
```

### Manual Testing
If you're experiencing connectivity issues, you can test both ports:

1. **Test with default configuration** (port 443 first, fallback to 2197):
   - Leave `APNS_USE_PORT_2197` unset or set to "false"
   - The system will automatically try port 2197 if port 443 fails

2. **Test with port 2197 first**:
   - Set `APNS_USE_PORT_2197=true`
   - The system will start with port 2197 and fallback to port 443 if needed

## Troubleshooting APNS Connectivity

If you see errors like "Malformed_HTTP_Response" in your logs:

1. **Check your network**: Corporate firewalls often block port 443 for non-browser traffic
2. **Try port 2197**: Set `APNS_USE_PORT_2197=true` in your environment
3. **Verify credentials**: Ensure your APNS key, team ID, and environment are correct
4. **Check device tokens**: Invalid tokens will be logged and should be removed from your database

## Local Development

When developing locally, you may encounter network issues with Apple's servers. The automatic port fallback should resolve most connectivity problems. If issues persist:

1. Check your local firewall settings
2. Try using port 2197 by setting the environment variable
3. Verify your internet connection allows outbound HTTPS on both ports 443 and 2197
