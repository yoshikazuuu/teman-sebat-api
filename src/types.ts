// src/types.ts
import { Context as HonoContext } from "hono";
import { DB } from "./db";

// Define the complete application environment for local development
export type AppEnv = {
    Bindings: {
        JWT_SECRET: string;
        APPLE_BUNDLE_ID: string; // For Apple Sign In audience check

        // --- APNS Configuration ---
        APNS_KEY_ID: string; // Your APNS Auth Key ID
        APNS_TEAM_ID: string; // Your Apple Developer Team ID
        APNS_PRIVATE_KEY: string; // The content of your .p8 private key file
        APNS_ENVIRONMENT: "development" | "production"; // 'development' for sandbox, 'production' for production
        APNS_USE_PORT_2197?: string; // Optional: Set to "true" or "1" to use port 2197 by default
    };
    Variables: {
        db: DB;
        jwtPayload: {
            id: number; // Your internal user ID
            exp: number;
            [key: string]: any;
        };
        // Optional: Cache the APNS token briefly if needed
        apnsAuthToken?: { token: string; expires: number };
    };
};

// Define a convenience type for the context object in handlers
export type AppContext = HonoContext<AppEnv>;
