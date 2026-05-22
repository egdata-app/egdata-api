import type { IResolvers } from "@graphql-tools/utils";
import type { Context } from "../index.js";
import {
  getFeaturedAchievements,
  getFeaturedGames,
  getProfileAchievementConnection,
  getProfileGameConnection,
  getProfileHeroGame,
  getProfileHighlights,
  getProfileIdentity,
  getRecentActivity,
  type ProfileIdentity,
  type ProfileRequestCache,
} from "../services/profile.js";

type ProfileContext = Context & {
  profileRequestCache?: ProfileRequestCache;
};

function getProfileRequestCache(context: ProfileContext) {
  context.profileRequestCache ??= new Map<string, Promise<unknown>>();
  return context.profileRequestCache;
}

const resolvers: IResolvers<Record<string, unknown>, Context> = {
  Query: {
    profile: async (_, { id }, context) => {
      return getProfileIdentity(id, getProfileRequestCache(context));
    },
  },
  Profile: {
    highlights: async (parent: ProfileIdentity, _, context) => {
      return getProfileHighlights(
        parent.accountId,
        parent.reviewsCount,
        getProfileRequestCache(context),
      );
    },
    heroGame: async (parent: ProfileIdentity, _, context) => {
      return getProfileHeroGame(
        parent.accountId,
        getProfileRequestCache(context),
      );
    },
    featuredAchievements: async (
      parent: ProfileIdentity,
      { limit },
      context,
    ) => {
      return getFeaturedAchievements(
        parent.accountId,
        limit,
        getProfileRequestCache(context),
      );
    },
    featuredGames: async (
      parent: ProfileIdentity,
      { filter, limit, sort },
      context,
    ) => {
      return getFeaturedGames(
        parent.accountId,
        { filter, limit, sort },
        getProfileRequestCache(context),
      );
    },
    recentActivity: async (
      parent: ProfileIdentity,
      { limit, page },
      context,
    ) => {
      return getRecentActivity(
        parent.accountId,
        limit,
        page,
        getProfileRequestCache(context),
      );
    },
    games: async (
      parent: ProfileIdentity,
      { filter, limit, page, sort },
      context,
    ) => {
      return getProfileGameConnection(
        parent.accountId,
        { filter, limit, page, sort },
        getProfileRequestCache(context),
      );
    },
    achievements: async (parent: ProfileIdentity, { limit, page }, context) => {
      return getProfileAchievementConnection(
        parent.accountId,
        limit,
        page,
        getProfileRequestCache(context),
      );
    },
  },
};

export default resolvers;
