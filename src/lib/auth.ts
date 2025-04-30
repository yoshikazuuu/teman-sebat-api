// src/lib/auth.ts
import { jwt, sign } from "hono/jwt";
import * as jose from "jose";
import type { AppContext, AppEnv } from "../types";
import type { JWTPayload } from "jose";
import type { MiddlewareHandler } from "hono";

// --- Apple Sign-In Verification ---

// URL for Apple's public keys
const APPLE_PUBLIC_KEY_URL = "https://appleid.apple.com/auth/keys";

// Create a remote JSON Web Key Set (JWKS) instance
// This will fetch and cache Apple's public keys
const appleJWKS = jose.createRemoteJWKSet(new URL(APPLE_PUBLIC_KEY_URL));

/**
 * Verifies an Apple ID token.
 * @param idToken The ID token received from the client.
 * @param requiredAudience The expected audience (your app's bundle ID).
 * @returns The verified JWT payload if successful.
 * @throws {Error} If verification fails (e.g., invalid signature, expired, wrong audience).
 */
export const verifyAppleToken = async (
    idToken: string,
    requiredAudience: string,
): Promise<JWTPayload> => {
    try {
        const { payload } = await jose.jwtVerify(idToken, appleJWKS, {
            issuer: "https://appleid.apple.com", // Apple's issuer identifier
            audience: requiredAudience, // Your app's bundle ID
        });

        // Verification successful, return the payload
        return payload;
    } catch (error: any) {
        console.error("Apple ID Token verification failed:", error.message);
        // Re-throw a more specific error or handle different jose errors
        // (e.g., JWTExpired, JWSSignatureVerificationFailed, JWTClaimValidationFailed)
        throw new Error(`Apple token verification failed: ${error.code || error.message}`);
    }
};

// --- Application JWT Handling ---

/**
 * Generates an authentication token for our application.
 * @param payload The data to include in the token (e.g., user ID).
 * @param secret The JWT secret from environment variables.
 * @returns The generated JWT string.
 */
export const generateAuthToken = async (
    payload: Record<string, any>,
    secret: string,
): Promise<string> => {
    // Add expiration (e.g., 30 days)
    const enrichedPayload = {
        ...payload,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30, // 30 days
    };
    return sign(enrichedPayload, secret);
};

/**
 * Hono middleware to verify the application's JWT.
 * Attaches the decoded payload to c.var.jwtPayload.
 */
export const jwtMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
    const middleware = jwt({
        secret: c.env.JWT_SECRET,
    });
    return middleware(c, next);
};
