import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PriceRoutes from "../src/routes/offers/price.js";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  offer: vi.fn(),
  current: vi.fn(),
  history: vi.fn(),
  currents: vi.fn(),
}));
vi.mock("../src/clients/redis.js", () => ({
  default: { get: mocks.get, set: mocks.set },
}));
vi.mock("../src/models/index.js", () => ({
  Offer: { findOne: () => ({ lean: mocks.offer }) },
  PriceEngine: {
    findOne: () => ({ lean: mocks.current }),
    find: () => ({ lean: mocks.currents }),
  },
  PriceEngineHistorical: {
    find: (...args: unknown[]) => {
      const result = mocks.history(...args);
      result.sort = () => result;
      return result;
    },
  },
  OfferCountryPricingScore: {},
}));
const app = new Hono().route("/offers/:id", PriceRoutes);
const price = (region: string) => ({
  region,
  updatedAt: new Date("2026-09-01"),
  price: { currencyCode: "USD", discountPrice: 499, originalPrice: 499 },
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue(null);
  mocks.set.mockResolvedValue("OK");
  mocks.offer.mockResolvedValue({
    id: "addon",
    countriesBlacklist: ["CN", "RU", "BY"],
  });
  mocks.current.mockResolvedValue(price("US"));
  mocks.currents.mockResolvedValue([price("US"), price("CN2")]);
  mocks.history.mockResolvedValue([price("US"), price("CN2")]);
});
describe("offer price availability", () => {
  it.each([
    "price",
    "regional-price",
  ])("rejects excluded countries before reading stale %s cache", async (route) => {
    mocks.get.mockResolvedValue(JSON.stringify(price("CN2")));
    const response = await app.request(`/offers/addon/${route}?country=CN`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Price not found" });
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it("omits unavailable regions even when historical and current rows exist", async () => {
    const response = await app.request("/offers/addon/regional-price");
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.US.currentPrice.region).toBe("US");
    expect(result.CN2).toBeUndefined();
  });
  it("allows an eligible country sharing a region with an excluded country", async () => {
    mocks.offer.mockResolvedValue({ countriesWhitelist: ["ES"] });
    mocks.current.mockResolvedValue(price("EURO"));
    expect((await app.request("/offers/addon/price?country=ES")).status).toBe(
      200,
    );
    expect((await app.request("/offers/addon/price?country=DE")).status).toBe(
      404,
    );
  });
  it("keeps excluded regional history accessible", async () => {
    const response = await app.request(
      "/offers/addon/price-history?country=CN",
    );
    expect(response.status).toBe(200);
    expect(mocks.offer).not.toHaveBeenCalled();
    expect(mocks.history).toHaveBeenCalled();
  });
});
