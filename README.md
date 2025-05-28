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
APNS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
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
