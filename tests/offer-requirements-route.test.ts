import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OfferRequirementsRoute from "../src/routes/offers/requirements.js";

const mocks = vi.hoisted(() => ({
  findOffer: vi.fn(),
  findRequirements: vi.fn(),
  collection: vi.fn(),
}));

vi.mock("../src/models/index.js", () => ({
  Offer: {
    findOne: (...args: unknown[]) => ({ lean: () => mocks.findOffer(...args) }),
  },
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: (...args: unknown[]) => mocks.collection(...args),
    },
  },
}));

const app = new Hono().route("/offers/:id", OfferRequirementsRoute);
const offer = { id: "offer-1", namespace: "namespace-1" };
const minimum = { os: { name: "Windows" }, cpu: { rawEvidence: "2 GHz" } };

function requirementsDoc(
  platform: "windows" | "macos",
  overrides: Record<string, unknown> = {},
) {
  return {
    namespace: offer.namespace,
    offerId: offer.id,
    platform,
    offerType: "BASE_GAME",
    source: {
      sourceType: "product_page",
      observedAt: new Date("2026-08-01T12:00:00.000Z"),
      rawRows: [{ title: "Minimum", minimum: "2 GHz", recommended: null }],
    },
    processing: { sourceGeneration: 3, state: "normalized" },
    parent: {
      parentNamespace: null,
      parentOfferId: null,
      relationshipType: null,
      resolvedInheritance: false,
    },
    requirements: { minimum, recommended: null },
    ...overrides,
  };
}

describe("GET /offers/{id}/requirements", () => {
  let documents: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    documents = {};
    mocks.findOffer.mockResolvedValue(offer);
    mocks.collection.mockReturnValue({
      findOne: mocks.findRequirements,
    });
    mocks.findRequirements.mockImplementation(
      ({ namespace, offerId, platform }) =>
        Promise.resolve(
          documents[`${namespace}:${offerId}:${platform}`] ?? null,
        ),
    );
  });

  it("returns resolved Windows and macOS results", async () => {
    documents["namespace-1:offer-1:windows"] = requirementsDoc("windows");
    documents["namespace-1:offer-1:macos"] = requirementsDoc("macos");

    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      windows: {
        namespace: "namespace-1",
        offerId: "offer-1",
        platform: "windows",
        state: "normalized",
        inherited: false,
        requirements: { minimum, recommended: null },
      },
      macos: {
        platform: "macos",
        state: "normalized",
      },
    });
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("returns null for a platform with no requirements record", async () => {
    documents["namespace-1:offer-1:windows"] = requirementsDoc("windows");

    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      windows: { platform: "windows" },
      macos: null,
    });
  });

  it("returns 404 when neither platform has a record", async () => {
    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      message: "Offer requirements not found",
    });
  });

  it("returns 404 for an unknown offer", async () => {
    mocks.findOffer.mockResolvedValueOnce(null);

    const response = await app.request("/offers/missing/requirements");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Offer not found" });
    expect(mocks.findRequirements).not.toHaveBeenCalled();
  });

  it("inherits from an explicitly linked base game after confirmed absence", async () => {
    const dlc = requirementsDoc("windows", {
      offerType: "DLC",
      source: {
        sourceType: "confirmed_absent",
        observedAt: new Date("2026-08-02T00:00:00Z"),
        rawRows: [],
      },
      processing: { sourceGeneration: 4, state: "empty" },
      parent: {
        parentNamespace: "base-namespace",
        parentOfferId: "base-offer",
        relationshipType: "explicit_dlc",
        resolvedInheritance: true,
      },
      requirements: { minimum: null, recommended: null },
    });
    documents["namespace-1:offer-1:windows"] = dlc;
    documents["base-namespace:base-offer:windows"] = {
      ...requirementsDoc("windows"),
      namespace: "base-namespace",
      offerId: "base-offer",
    };

    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      windows: {
        inherited: true,
        isInherited: true,
        parentOfferId: "base-offer",
        parent: {
          namespace: "base-namespace",
          offerId: "base-offer",
          relationshipType: "explicit_dlc",
        },
        state: "inherited",
        requirements: { minimum },
      },
      macos: null,
    });
  });

  it("retains parent requirements with a stale inherited state", async () => {
    documents["namespace-1:offer-1:windows"] = requirementsDoc("windows", {
      offerType: "DLC",
      source: {
        sourceType: "confirmed_absent",
        observedAt: new Date("2026-08-02T00:00:00Z"),
        rawRows: [],
      },
      processing: { sourceGeneration: 4, state: "empty" },
      parent: {
        parentNamespace: "base-namespace",
        parentOfferId: "base-offer",
        relationshipType: "explicit_dlc",
        resolvedInheritance: true,
      },
      requirements: { minimum: null, recommended: null },
    });
    documents["base-namespace:base-offer:windows"] = {
      ...requirementsDoc("windows"),
      namespace: "base-namespace",
      offerId: "base-offer",
      processing: { sourceGeneration: 2, state: "stale" },
    };

    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      windows: {
        inherited: true,
        state: "stale",
        requirements: { minimum },
      },
      macos: null,
    });
  });

  it("does not fill missing tiers on partially specified DLC requirements", async () => {
    documents["namespace-1:offer-1:windows"] = requirementsDoc("windows", {
      offerType: "DLC",
      parent: {
        parentNamespace: "base-namespace",
        parentOfferId: "base-offer",
        relationshipType: "explicit_dlc",
        resolvedInheritance: true,
      },
      requirements: { minimum, recommended: null },
    });
    documents["base-namespace:base-offer:windows"] = {
      ...requirementsDoc("windows"),
      namespace: "base-namespace",
      offerId: "base-offer",
      requirements: {
        minimum: { os: { name: "Parent OS" } },
        recommended: minimum,
      },
    };

    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      windows: {
        inherited: false,
        requirements: { minimum, recommended: null },
      },
    });
    expect(mocks.findRequirements).toHaveBeenCalledTimes(2);
    expect(mocks.findRequirements).not.toHaveBeenCalledWith(
      expect.objectContaining({ offerId: "base-offer" }),
    );
  });

  it.each([
    "stale",
    "failed",
  ] as const)("preserves %s state and avoids inheritance", async (state) => {
    documents["namespace-1:offer-1:windows"] = requirementsDoc("windows", {
      offerType: "DLC",
      source: {
        sourceType: "confirmed_absent",
        observedAt: new Date("2026-08-02T00:00:00Z"),
        rawRows: [],
      },
      processing: { sourceGeneration: 4, state },
      parent: {
        parentNamespace: "base-namespace",
        parentOfferId: "base-offer",
        relationshipType: "explicit_dlc",
        resolvedInheritance: true,
      },
      requirements: { minimum: null, recommended: null },
    });

    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      windows: {
        inherited: false,
        state,
        requirements: { minimum: null, recommended: null },
      },
      macos: null,
    });
    expect(mocks.findRequirements).toHaveBeenCalledTimes(2);
  });

  it("returns unknown when DLC inheritance cannot be validated", async () => {
    documents["namespace-1:offer-1:windows"] = requirementsDoc("windows", {
      offerType: "DLC",
      source: {
        sourceType: "confirmed_absent",
        observedAt: new Date("2026-08-02T00:00:00Z"),
        rawRows: [],
      },
      processing: { sourceGeneration: 4, state: "empty" },
      parent: {
        parentNamespace: "base-namespace",
        parentOfferId: "base-offer",
        relationshipType: "explicit_dlc",
        resolvedInheritance: true,
      },
      requirements: { minimum: null, recommended: null },
    });

    const response = await app.request("/offers/offer-1/requirements");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      windows: {
        inherited: false,
        state: "unknown",
        parentOfferId: "base-offer",
        requirements: { minimum: null, recommended: null },
      },
      macos: null,
    });
  });
});
