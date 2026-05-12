import { logger, schedules } from "@trigger.dev/sdk/v3";
const REFRESH_CHANGELOG_URL = "https://api.egdata.app/refresh/changelog";
const REFRESH_OFFERS_URL = "https://api.egdata.app/refresh/offers";
const REFRESH_ITEMS_URL = "https://api.egdata.app/refresh/items";
const REFRESH_SELLERS_URL = "https://api.egdata.app/refresh/sellers";
const REFRESH_FREE_GAMES_URL = "https://api.egdata.app/free-games/index";

const patchOrThrow = async (url: string) => {
  const response = await fetch(url, { method: "PATCH" });
  if (!response.ok) {
    throw new Error(`Failed request: ${response.status} ${response.statusText}`);
  }
};

export const refreshChangelog = schedules.task({
  id: "refresh-changelog",
  cron: "*/30 * * * *", // Every 30 minutes
  run: async (payload, { ctx }) => {
    logger.log("Refreshing changelog");
    await patchOrThrow(REFRESH_CHANGELOG_URL);
    logger.log("Changelog refreshed");
  },
});

export const refreshOffers = schedules.task({
  id: "refresh-offers",
  cron: "*/5 * * * *", // Every 5 minutes
  run: async (payload, { ctx }) => {
    logger.log("Refreshing offers");
    await patchOrThrow(REFRESH_OFFERS_URL);
    logger.log("Offers refreshed");
  },
});

export const refreshItems = schedules.task({
  id: "refresh-items",
  cron: "*/5 * * * *", // Every 5 minutes
  run: async (payload, { ctx }) => {
    logger.log("Refreshing items");
    await patchOrThrow(REFRESH_ITEMS_URL);
    logger.log("Items refreshed");
  },
});

export const refreshSellers = schedules.task({
  id: "refresh-sellers",
  cron: "*/5 * * * *", // Every 5 minutes
  run: async (payload, { ctx }) => {
    logger.log("Refreshing sellers");
    await patchOrThrow(REFRESH_SELLERS_URL);
    logger.log("Sellers refreshed");
  },
});

export const refreshFreeGames = schedules.task({
  id: "refresh-free-games",
  cron: "*/20 * * * *", // Every 20 minutes
  run: async (payload, { ctx }) => {
    logger.log("Refreshing free games");
    await patchOrThrow(REFRESH_FREE_GAMES_URL);
    logger.log("Free games refreshed");
  },
});
