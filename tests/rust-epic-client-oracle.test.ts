import { stripIgnoredCharacters } from "graphql";
import { it, vi } from "vitest";
import { assertOracle } from "../rust/oracles/record.js";
import { EpicStoreClient } from "../src/clients/epic.js";
import { getDiscordUser } from "../src/utils/get-discord-user.js";
import { getFeaturedGames } from "../src/utils/get-featured-games.js";

type Operation =
  | "profile"
  | "product"
  | "summaries"
  | "ownership"
  | "featured"
  | "discord";
type Reply = {
  token?: string;
  body?: unknown;
  raw?: string;
  status?: number;
  type?: string;
  drop?: boolean;
};
const profile = {
  epicAccountId: "fixture",
  displayName: "Player",
  productAchievements: { __typename: "ServiceError" },
  achievementsSummaries: { status: "OK" },
};
const valid = { data: { PlayerProfile: { playerProfile: profile } } };
const cart = {
  conflictingOffers: [],
  missingPrerequisites: [],
  fullyOwnedOffers: [],
  possiblePartialUpgradeOffers: [],
  unablePartiallyUpgradeOffers: [],
};
const cartData = { Entitlements: { cartOffersValidation: cart } };
const error = [{ message: "fixture error" }];
const modules = (modules: unknown) => ({
  data: { Storefront: { storefrontModulesPaginated: { modules } } },
});
const carousel = (slides: unknown) =>
  modules([{ id: "new-carousel-definitive", slides }]);

it("records Epic and Discord clients against deterministic upstream responses", async () => {
  const cases: [string, Operation, Reply][] = [];
  for (const op of ["profile", "product", "summaries"] as const) {
    for (const [label, body] of Object.entries({
      success: valid,
      partial: { ...valid, errors: error },
      empty: {},
      data: { data: {} },
      player: { data: { PlayerProfile: {} } },
      nullProfile: { data: { PlayerProfile: { playerProfile: null } } },
    }))
      cases.push([op + " " + label, op, { body }]);
    cases.push(
      [op + " non-success", op, { status: 429, body: valid }],
      [op + " unavailable", op, { drop: true }],
    );
  }
  cases.push(
    ["ownership success", "ownership", { body: { data: cartData } }],
    [
      "ownership partial errors",
      "ownership",
      { body: { data: cartData, errors: error } },
    ],
    [
      "ownership HTTP error with data and errors",
      "ownership",
      { status: 403, body: { data: cartData, errors: error } },
    ],
    [
      "ownership HTTP error with only data",
      "ownership",
      { status: 401, body: { data: cartData } },
    ],
    [
      "ownership empty errors",
      "ownership",
      { body: { data: cartData, errors: [] } },
    ],
    ["ownership errors only", "ownership", { body: { errors: error } }],
    ["ownership malformed JSON", "ownership", { raw: "not JSON" }],
    ["ownership connection closed", "ownership", { drop: true }],
    [
      "ownership forbidden with an empty error list",
      "ownership",
      { status: 403, body: { errors: [] } },
    ],
    [
      "ownership invalid bearer header",
      "ownership",
      { token: "bad\nvalue", body: { data: cartData } },
    ],
    [
      "featured full references",
      "featured",
      {
        body: carousel([
          { offer: { id: "one", namespace: "ns", offer: { title: "One" } } },
          { offer: { id: "two", namespace: "second" } },
        ]),
      },
    ],
    ["featured empty slides", "featured", { body: carousel([]) }],
    ["featured missing carousel", "featured", { body: modules([]) }],
    [
      "featured absent slides",
      "featured",
      { body: modules([{ id: "new-carousel-definitive" }]) },
    ],
    ["featured missing offer", "featured", { body: carousel([{}]) }],
    [
      "featured HTTP error with valid layout",
      "featured",
      { status: 503, body: carousel([]) },
    ],
    ["featured invalid JSON", "featured", { raw: "invalid" }],
    ["featured unavailable", "featured", { drop: true }],
    [
      "discord accepted response",
      "discord",
      { status: 201, body: { user: { id: "one", username: "Player" } } },
    ],
    ["discord missing user", "discord", { body: {} }],
    [
      "discord unauthorized",
      "discord",
      { status: 401, body: { error: "invalid" } },
    ],
    ["discord invalid JSON", "discord", { raw: "malformed" }],
    ["discord unavailable", "discord", { drop: true }],
  );
  const records = [];
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [name, op, input] of cases) {
    const requests: unknown[] = [];
    const transport = (async (url, init) => {
      const request = new Request(url, init);
      let body: { query: string } | undefined;
      if (request.method === "POST") {
        body = (await request.json()) as { query: string };
        body.query = stripIgnoredCharacters(body.query).replace(/\s+/g, "");
      }
      requests.push({
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
      });
      if (input.drop) throw new TypeError("fetch failed");
      return new Response(input.raw ?? JSON.stringify(input.body), {
        status: input.status ?? 200,
        headers: { "content-type": input.type ?? "application/json" },
      });
    }) as typeof fetch;
    vi.stubGlobal("fetch", transport);
    let output: unknown;
    try {
      const client = new EpicStoreClient(transport);
      switch (op) {
        case "profile":
          output = await client.getUser("fixture");
          break;
        case "product":
          output = await client.getUserProductAchievements(
            "fixture",
            "product",
          );
          break;
        case "summaries":
          output = await client.getUserAchievements("fixture");
          break;
        case "ownership":
          output = await client.checkOwnership(
            [{ id: "one", namespace: "ns" }],
            input.token ?? "fixture-token",
          );
          break;
        // Registered featured handlers consume the array and read each offer's id.
        case "featured": {
          const offers = await getFeaturedGames();
          offers.map((offer) => offer.id);
          output = offers;
          break;
        }
        case "discord":
          output = await getDiscordUser("fixture-token");
          break;
      }
      output = { value: output ?? null };
    } catch (e) {
      const message = (e as Error).message;
      output = {
        error: message.startsWith("Failed to fetch Discord user:")
          ? message
          : "upstream",
      };
    } finally {
      vi.unstubAllGlobals();
    }
    records.push({ name, op, input, requests, output });
  }
  errors.mockRestore();
  assertOracle("epic-client-node", records);
});
