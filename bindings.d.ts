import { Env } from 'hono';

type Environment = Env & {
    Bindings: {
        DB: D1Database;
        JWT_SECRET: string;
    },
    Variables: {
        db: DrizzleD1Database;
    }
};