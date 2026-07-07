import { GraphQLClient, gql } from "graphql-request";
import type { PlayerProfileQuery } from "../types/get-epic-user.js";
import type { PlayerProfilePrivateResponse } from "../types/get-user-achievements.js";
import type { PlayerProfileAchievementsByProductIdQuery } from "../types/get-user-product-achievements.js";
import type {
  GetOffersValidationQuery,
  GetOffersValidationQueryVariables,
} from "./queries/get-owned-offers.js";

const EPIC_STORE_GRAPHQL_URL = "https://store.epicgames.com/graphql";
const EPIC_STORE_USER_AGENT =
  "EpicGames/16.11.0-35427934+++Portal+Release-Live-Windows";
const EPIC_STORE_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://store.epicgames.com",
  Referer: "https://store.epicgames.com/en-US/",
  "User-Agent": EPIC_STORE_USER_AGENT,
};

type EpicGraphQlError = {
  response?: {
    status?: number;
    headers?: Headers | Record<string, unknown>;
    body?: unknown;
    errors?: unknown;
  };
};

type EpicGraphQlErrorSummary = {
  status?: number;
  cfMitigated?: string;
  cfRay?: string;
  contentType?: string;
  cloudflareChallenge: boolean;
  message: string;
};

function getHeader(
  headers: EpicGraphQlError["response"] extends { headers?: infer H }
    ? H
    : never,
  name: string,
) {
  if (!headers) {
    return undefined;
  }

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  const headerRecord = headers as Record<string, unknown>;
  const exactValue = headerRecord[name];
  if (typeof exactValue === "string") {
    return exactValue;
  }

  const lowerName = name.toLowerCase();
  const matchingKey = Object.keys(headerRecord).find(
    (key) => key.toLowerCase() === lowerName,
  );
  const matchingValue = matchingKey ? headerRecord[matchingKey] : undefined;

  return typeof matchingValue === "string" ? matchingValue : undefined;
}

export function isEpicGraphQlCloudflareChallenge(error: unknown) {
  const response = (error as EpicGraphQlError | undefined)?.response;

  if (!response || response.status !== 403) {
    return false;
  }

  if (getHeader(response.headers, "cf-mitigated") === "challenge") {
    return true;
  }

  if (getHeader(response.headers, "server")?.toLowerCase() === "cloudflare") {
    const body = typeof response.body === "string" ? response.body : "";
    return (
      body.includes("cf_challenge_container") ||
      body.includes("/cdn-cgi/challenge-platform/")
    );
  }

  return false;
}

export function summarizeEpicGraphQlError(
  operation: string,
  error: unknown,
): EpicGraphQlErrorSummary {
  const response = (error as EpicGraphQlError | undefined)?.response;
  const status = response?.status;
  const cfMitigated = getHeader(response?.headers, "cf-mitigated");
  const cfRay = getHeader(response?.headers, "cf-ray");
  const contentType = getHeader(response?.headers, "content-type");
  const cloudflareChallenge = isEpicGraphQlCloudflareChallenge(error);

  return {
    status,
    cfMitigated,
    cfRay,
    contentType,
    cloudflareChallenge,
    message: cloudflareChallenge
      ? `Epic GraphQL ${operation} was blocked by a Cloudflare challenge.`
      : `Epic GraphQL ${operation} failed.`,
  };
}

export class EpicStoreClient {
  private client: GraphQLClient;

  constructor() {
    this.client = new GraphQLClient(EPIC_STORE_GRAPHQL_URL, {
      errorPolicy: "ignore",
      headers: EPIC_STORE_HEADERS,
    });
  }

  private async request<T>(
    operation: string,
    query: string,
    variables: Record<string, unknown>,
  ) {
    try {
      return await this.client.request<T>(query, variables);
    } catch (err) {
      const summary = summarizeEpicGraphQlError(operation, err);
      const logData = {
        operation,
        status: summary.status,
        cfMitigated: summary.cfMitigated,
        cfRay: summary.cfRay,
        contentType: summary.contentType,
      };

      if (summary.cloudflareChallenge) {
        console.warn(summary.message, logData);
      } else {
        console.error(summary.message, logData);
      }

      return null;
    }
  }

  async getUser(accountId: string) {
    const query = gql`
      query playerProfile($epicAccountId: String!) {
        PlayerProfile {
          playerProfile(epicAccountId: $epicAccountId) {
            epicAccountId
            displayName
            avatar {
              small
              medium
              large
            }
          }
        }
      }
    `;

    const data = await this.request<PlayerProfileQuery>(
      "playerProfile",
      query,
      {
        epicAccountId: accountId,
      },
    );
    return data?.PlayerProfile?.playerProfile;
  }

  async getUserProductAchievements(accountId: string, productId: string) {
    const query = gql`
      query playerProfileAchievementsByProductId(
        $epicAccountId: String!
        $productId: String!
      ) {
        PlayerProfile {
          playerProfile(epicAccountId: $epicAccountId) {
            epicAccountId
            displayName
            relationship
            avatar {
              small
              medium
              large
            }
            productAchievements(productId: $productId) {
              __typename
              ... on PlayerProductAchievementsResponseSuccess {
                data {
                  epicAccountId
                  sandboxId
                  totalXP
                  totalUnlocked
                  achievementSets {
                    achievementSetId
                    isBase
                    totalUnlocked
                    totalXP
                  }
                  playerAwards {
                    awardType
                    unlockedDateTime
                    achievementSetId
                  }
                  playerAchievements {
                    playerAchievement {
                      achievementName
                      epicAccountId
                      progress
                      sandboxId
                      unlocked
                      unlockDate
                      XP
                      achievementSetId
                      isBase
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await this.request<PlayerProfileAchievementsByProductIdQuery>(
      "playerProfileAchievementsByProductId",
      query,
      {
        epicAccountId: accountId,
        productId,
      },
    );
    return data?.PlayerProfile?.playerProfile?.productAchievements;
  }

  async getUserAchievements(accountId: string) {
    const query = gql`
      query playerProfilePrivate($epicAccountId: String!, $locale: String!) {
        PlayerProfile {
          playerProfile(epicAccountId: $epicAccountId) {
            privacy {
              accessLevel
            }
            relationship
            achievementsSummaries {
              __typename
              ... on PlayerAchievementResponseSuccess {
                status
                data {
                  totalUnlocked
                  totalXP
                  sandboxId
                  baseOfferForSandbox(locale: $locale) {
                    id
                    namespace
                    keyImages {
                      url
                      type
                      alt
                      md5
                    }
                  }
                  product(locale: $locale) {
                    name
                    slug
                  }
                  productAchievements {
                    totalAchievements
                    totalProductXP
                  }
                  playerAwards {
                    # Corrected to use only valid fields
                    awardType # Assuming 'awardType' is a valid field
                    # Add other valid fields for PlayerAward as needed
                  }
                }
              }
            }
          }
        }
        ContentControl {
          get {
            __typename
          }
        }
      }
    `;

    const data = await this.request<PlayerProfilePrivateResponse>(
      "playerProfilePrivate",
      query,
      {
        epicAccountId: accountId,
        locale: "en-US",
      },
    );
    return data?.PlayerProfile?.playerProfile?.achievementsSummaries;
  }

  async checkOwnership(
    offers: { id: string; namespace: string }[],
    authToken: string,
  ) {
    try {
      const query = gql`
        query getOffersValidation($offers: [OfferToValidate]!) {
          Entitlements {
            cartOffersValidation(offerParams: $offers) {
              conflictingOffers {
                offerId
                namespace
                conflictingOffers {
                  namespace
                  offerId
                }
              }
              missingPrerequisites {
                namespace
                offerId
                missingPrerequisiteItems {
                  itemId
                  namespace
                }
              }
              fullyOwnedOffers {
                namespace
                offerId
              }
              possiblePartialUpgradeOffers {
                namespace
                offerId
              }
              unablePartiallyUpgradeOffers {
                namespace
                offerId
              }
            }
          }
        }
      `;

      const client = new GraphQLClient(EPIC_STORE_GRAPHQL_URL, {
        headers: {
          ...EPIC_STORE_HEADERS,
          Authorization: `Bearer ${authToken}`,
        },
      });

      const data = await client.request<
        GetOffersValidationQuery,
        GetOffersValidationQueryVariables
      >(query, {
        offers: offers.map((o) => ({ offerId: o.id, namespace: o.namespace })),
      });
      return data?.Entitlements?.cartOffersValidation ?? null;
    } catch (err) {
      const summary = summarizeEpicGraphQlError("getOffersValidation", err);
      console.error(summary.message, {
        status: summary.status,
        cfMitigated: summary.cfMitigated,
        cfRay: summary.cfRay,
        contentType: summary.contentType,
      });

      return (err as EpicGraphQlError).response?.errors ?? null;
    }
  }
}

export const epicStoreClient = new EpicStoreClient();
