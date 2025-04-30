import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'sqlite',
    driver: 'd1-http',
    out: 'drizzle',
    schema: './src/db/schema.ts',
    // dbCredentials needs only for connect drizzle studio
    dbCredentials: {
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
        databaseId: process.env.CLOUDFLARE_DATABASE_ID!,
        token: process.env.CLOUDFLARE_D1_TOKEN!,
    },

});
// https://github.com/drizzle-team/drizzle-kit-mirror/releases/tag/v0.21.3
// creating token https://dash.cloudflare.com/profile/api-tokens
