import { betterAuth } from "better-auth";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.NEON_CONNECTION_URI });

export const auth = betterAuth({
  logger: {
    level: "debug",
  },
  database: pool,
  plugins: [],
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // Cache duration in seconds
    },
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: false,
      domain: import.meta.env.PROD ? ".egdata.app" : "localhost",
    },
    crossSubDomainCookies: {
      enabled: true,
      domain: import.meta.env.PROD ? ".egdata.app" : "localhost",
    },
  },
});

export async function getLinkedEpicSession(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  // Recheck the live session along with its OAuth link, even when Better Auth
  // served the session from its signed cookie cache.
  const { rows } = await pool.query<{ accountId: string }>(
    `SELECT DISTINCT a."accountId" FROM "account" a
     INNER JOIN "session" s ON s."userId" = a."userId"
     WHERE s."token" = $1 AND s."userId" = $2 AND s."expiresAt" > NOW()
       AND a."providerId" = 'epic' AND a."accountId" <> ''
     LIMIT 2`,
    [session.session.token, session.user.id],
  );
  return rows.length === 1 ? { ...session, epicAccountId: rows[0].accountId } : null;
}
