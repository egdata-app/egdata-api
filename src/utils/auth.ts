import { betterAuth } from "better-auth";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { genericOAuth } from "better-auth/plugins";
import consola from "consola";

const discovery = {
  issuer: "https://api.epicgames.dev/epic/oauth/v2",
  authorization_endpoint: "https://www.epicgames.com/id/authorize",
  token_endpoint: "https://api.epicgames.dev/epic/oauth/v2/token",
  userinfo_endpoint: "https://api.epicgames.dev/epic/oauth/v2/userInfo",
  jwks_uri: "https://api.epicgames.dev/epic/oauth/v2/.well-known/jwks.json",
  response_types_supported: ["code"],
  id_token_signing_alg_values_supported: ["RS256"],
  subject_types_supported: ["public", "pairwise"],
  acr_values_supported: ["urn:epic:loa:aal1", "urn:epic:loa:aal2"],
};

export const auth = betterAuth({
  logger: {
    level: "debug",
  },
  database: {
    dialect: new LibsqlDialect({
      url: process.env.TURSO_DATABASE_URL || "",
      authToken: process.env.TURSO_AUTH_TOKEN || "",
    }),
    type: "sqlite",
  },
  plugins: [
    genericOAuth({
      config: [
        {
          providerId: "epic",
          clientId: process.env.EPIC_CLIENT_ID || "",
          clientSecret: process.env.EPIC_CLIENT_SECRET || "",
          scopes: ["basic_profile"],
          tokenUrl: `${process.env.BETTER_AUTH_URL as string}/api/token`,
          redirectURI: `${
            process.env.BETTER_AUTH_URL as string
          }/api/auth/oauth2/callback/epic`,
          authorizationUrl: discovery.authorization_endpoint,
          userInfoUrl: discovery.userinfo_endpoint,
          getUserInfo: async ({ accessToken }) => {
            consola.info("Fetching user info", {
              accessToken: `${accessToken?.slice(0, 10)}...`,
            });
            const response = await fetch(discovery.userinfo_endpoint, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
            });

            if (!response.ok) {
              consola.error(response.status, await response.json());
              throw new Error("Failed to get user info");
            }

            const data = await response.json();

            consola.info("Got user info", data);

            return {
              id: data.sub,
              name: data.preferred_username,
              email: `${data.sub}@accounts.epicgames.com`,
              createdAt: new Date(),
              updatedAt: new Date(),
              emailVerified: true,
            };
          },
        },
      ],
    }),
  ],
});
