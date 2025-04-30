// src/types.ts
import { Context as HonoContext } from "hono";
import { DB } from "./db";

// Define the complete application environment
export type AppEnv = {
    Bindings: {
        DB: D1Database;
        JWT_SECRET: string;
        APPLE_BUNDLE_ID: string; // Add Apple Bundle ID
    };
    Variables: {
        db: DB;
        jwtPayload: {
            id: number; // Your internal user ID
            exp: number;
            [key: string]: any;
        };
    };
};

// Define a convenience type for the context object in handlers
export type AppContext = HonoContext<AppEnv>;
