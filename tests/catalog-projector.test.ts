import { describe, expect, it } from "vitest";
import {
  catalogRecordKey,
  graphHashForRecords,
  sha256Hex,
  stableJson,
} from "../src/catalog/hydration.js";
import { projectCatalogGraph } from "../src/catalog/projector.js";

const item = (id: string, linkedOffers: string[] = []) => ({
  namespace: "ns",
  id,
  title: `Item ${id}`,
  linkedOffers,
  keyImages: [],
  categories: [],
  customAttributes: [{ key: "canRunOffline", value: "true" }],
  installModes: [],
  releaseInfo: [
    { id: `release-${id}`, appId: `app-${id}`, platform: ["Windows"] },
  ],
  unsearchable: true,
});

describe("direct catalog graph projection", () => {
  it("deduplicates relationship sources and selects the deterministic primary offer", () => {
    const records = projectCatalogGraph({
      offers: [
        {
          namespace: "ns",
          id: "base",
          title: "Base",
          offerType: "BASE_GAME",
          prePurchase: false,
          items: [{ namespace: "ns", id: "owned" }],
          keyImages: [],
          tags: [],
          categories: [],
          customAttributes: [],
          countriesBlacklist: [],
          countriesWhitelist: [],
          offerMappings: [],
        },
        {
          namespace: "ns",
          id: "prepurchase",
          title: "Prepurchase",
          offerType: "BASE_GAME",
          prePurchase: true,
          items: [{ namespace: "ns", id: "owned" }],
          keyImages: [],
          tags: [],
          categories: [],
          customAttributes: [],
          countriesBlacklist: [],
          countriesWhitelist: [],
          offerMappings: [],
        },
      ],
      items: [item("owned", ["base"]), item("sibling")],
      assets: [
        {
          namespace: "ns",
          artifactId: "artifact",
          platform: "Windows",
          itemId: "owned",
        },
      ],
      subItems: [
        {
          _id: "base",
          namespace: "ns",
          subItems: [
            { namespace: "ns", id: "owned" },
            { namespace: "ns", id: "sibling" },
          ],
        },
      ],
    });
    const ownedEdge = records.find(
      (record) =>
        record.type === "offer-item" &&
        record.offerId === "base" &&
        record.itemId === "owned",
    );
    expect(ownedEdge).toMatchObject({
      sources: ["direct", "subitem", "linked"],
      isPrimary: true,
    });
    expect(
      records.find((record) => record.type === "item" && record.id === "owned"),
    ).toMatchObject({
      unsearchable: true,
      primaryOfferId: "base",
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        type: "release-app",
        appId: "app-owned",
        platform: "Windows",
      }),
    );
  });

  it("changes the graph hash when record metadata changes without changing keys", () => {
    const makeHash = (title: string) => {
      const record = {
        type: "item" as const,
        namespace: "ns",
        id: "item",
        title,
        keyImages: [],
        categories: [],
        customAttributes: [],
        installModes: [],
      };
      const envelope = {
        recordKey: catalogRecordKey(record),
        sha256: sha256Hex(stableJson(record)),
        record,
      };
      return graphHashForRecords([envelope]);
    };
    expect(makeHash("First")).not.toBe(makeHash("Second"));
  });
});
