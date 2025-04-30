import { defineConfig } from "drizzle-kit";

export default process.env.NODE_ENV == "production"
    ? defineConfig({
        dialect: "sqlite",
        driver: "d1-http",
        out: "drizzle",
        schema: "./src/db/schema.ts",
        dbCredentials: {
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
            databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
            token: process.env.CLOUDFLARE_D1_TOKEN!,
        },
    })
    : defineConfig({
        dialect: "sqlite",
        out: "drizzle",
        schema: "./src/db/schema.ts",
        dbCredentials: {
            url: ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/011c4f8f501b1c0c0d1f82d2d0115c271158a53c6b5ceba15a06d9e840880ff0.sqlite",
        },
    });