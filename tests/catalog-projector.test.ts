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
  it("uses Node localeCompare for hydration list and graph-selection ordering", () => {
    const values = ["10", "2", "_", "-", "a", "A", "á", "ä", "e", "É", "z"];
    const expected = [...values].sort((left, right) =>
      left.localeCompare(right),
    );
    const offer = {
      namespace: "ns",
      id: "offer",
      title: "Sorted",
      items: [{ namespace: "ns", id: "item" }],
      keyImages: values.map((value) => ({
        type: value,
        url: `https://example.test/${value}`,
      })),
      tags: values.map((id) => ({ id })),
      categories: [],
      customAttributes: values.map((key) => ({ key, value: "v" })),
      countriesBlacklist: [],
      countriesWhitelist: [],
      offerMappings: [],
    };
    const records = projectCatalogGraph({
      offers: [offer],
      items: [item("item")],
      assets: [],
      subItems: [],
    });
    const projected = records.find((record) => record.type === "offer");
    expect(projected).toBeDefined();
    if (projected?.type !== "offer") throw new Error("offer record missing");
    expect(projected.keyImages.map((image) => image.type)).toEqual(expected);
    expect(projected.tags.map((tag) => tag.id)).toEqual(expected);
    expect(
      projected.customAttributes.map((attribute) => attribute.key),
    ).toEqual(expected);

    const tiedOffers = ["10", "2", "_", "-", "á"].map((id) => ({
      ...offer,
      id,
      items: [{ namespace: "ns", id: "item" }],
      keyImages: [],
      tags: [],
      customAttributes: [],
    }));
    const winner = projectCatalogGraph({
      offers: tiedOffers,
      items: [item("item")],
      assets: [],
      subItems: [],
    }).find((record) => record.type === "offer-item" && record.isPrimary);
    expect(winner?.type === "offer-item" ? winner.offerId : undefined).toBe(
      [...tiedOffers.map((candidate) => candidate.id)].sort((left, right) =>
        `ns:${left}`.localeCompare(`ns:${right}`),
      )[0],
    );
  });

  it("matches JavaScript integer-key enumeration after locale sorting", () => {
    expect(
      stableJson({
        "10": "ten",
        "2": "two",
        "01": "leading",
        "4294967295": "max",
        á: "accent",
        _: "under",
        "-": "dash",
      }),
    ).toBe(
      '{"2":"two","10":"ten","_":"under","-":"dash","01":"leading","4294967295":"max","á":"accent"}',
    );
  });

  it("sorts graph hash pairs with Node localeCompare", () => {
    const records = ["á", "_", "-", "2", "10"].map((recordKey) => ({
      recordKey,
      sha256: recordKey.padEnd(64, "0"),
      record: { type: "item", namespace: "n", id: recordKey },
    }));
    expect(
      records
        .map(({ recordKey }) => recordKey)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["_", "-", "10", "2", "á"]);
    expect(graphHashForRecords(records as never)).toBe(
      "38f18bf793168a485e8144c01399495c2fcef4779be7a9956f875307c902067a",
    );
  });

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
        eulaIds: [],
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
