// src/types.ts
import { Context as HonoContext } from "hono";
import { DB } from "./db";
import { JwtVariables } from "hono/jwt";

// Define the complete application environment
export type AppEnv = {
    Bindings: {
        DB: D1Database;
        JWT_SECRET: string;
    };
    Variables: {
        db: DB;
        jwtPayload: {
            id: number;
            exp: number;
            [key: string]: any;
        };
    };
};

// Define a convenience type for the context object in handlers
export type AppContext = HonoContext<AppEnv>;