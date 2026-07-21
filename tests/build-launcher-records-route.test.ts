import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assetFind: vi.fn(),
  itemFind: vi.fn(),
  offerFind: vi.fn(),
  subItemFind: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({
  db: {
    db: {
      collection: vi.fn(() => ({
        find: mocks.subItemFind,
      })),
    },
  },
}));

vi.mock("../src/models/index.js", () => ({
  Asset: { find: mocks.assetFind },
  Item: { find: mocks.itemFind },
  Offer: { find: mocks.offerFind },
}));

import BuildLauncherRecordsRoute from "../src/routes/build-launcher-records.js";

function request(candidates: unknown[]) {
  return new Request("http://localhost/builds/resolve-launcher-records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ candidates }),
  });
}

describe("launcher record resolver", () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono().route("/builds", BuildLauncherRecordsRoute);
    mocks.assetFind.mockReset();
    mocks.itemFind.mockReset();
    mocks.offerFind.mockReset();
    mocks.subItemFind.mockReset();
    mocks.subItemFind.mockReturnValue({
      toArray: vi.fn().mockResolvedValue([]),
    });
  });

  it("resolves an executable base game from its binary build app name", async () => {
    mocks.itemFind.mockResolvedValue([
      {
        id: "catalog",
        namespace: "namespace",
        title: "Example Game",
        entitlementType: "EXECUTABLE",
        itemType: "APPLICATION",
        customAttributes: [
          { key: "FolderName", value: "Example", type: "STRING" },
          { key: "CanRunOffline", value: "false", type: "STRING" },
        ],
      },
    ]);
    mocks.assetFind.mockResolvedValue([
      { artifactId: "LauncherApp", itemId: "catalog", platform: "Windows" },
    ]);
    mocks.offerFind.mockResolvedValue([
      { id: "offer", offerType: "BASE_GAME", items: [{ id: "catalog" }] },
    ]);

    const response = await app.request(
      request([
        {
          requestId: "candidate-1",
          buildAppName: "BinaryBuildApp",
          buildVersion: "1.0",
          platform: "Windows",
        },
      ]),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: [
        {
          requestId: "candidate-1",
          status: "resolved",
          record: {
            artifactId: "LauncherApp",
            catalogItemId: "catalog",
            catalogNamespace: "namespace",
            displayName: "Example Game",
            kind: "base-game",
            appCategories: ["public", "games", "applications"],
            mainGame: null,
            mandatoryAppFolderName: "Example",
            canRunOffline: false,
            requiresAuth: true,
            ownershipToken: false,
            ignoredProcessNames: [],
          },
        },
      ],
    });
  });

  it("uses a companion hint and resolves an add-on parent", async () => {
    mocks.itemFind
      .mockResolvedValueOnce([
        {
          id: "addon-item",
          namespace: "namespace",
          title: "Example Add-on",
          entitlementType: "EXECUTABLE",
          itemType: "DURABLE",
          customAttributes: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "base-item",
          namespace: "namespace",
          title: "Example Game",
          entitlementType: "EXECUTABLE",
        },
      ]);
    mocks.assetFind
      .mockResolvedValueOnce([
        { artifactId: "AddonApp", itemId: "addon-item", platform: "Windows" },
      ])
      .mockResolvedValueOnce([
        { artifactId: "BaseApp", itemId: "base-item", platform: "Windows" },
      ]);
    mocks.offerFind.mockResolvedValue([
      {
        id: "base-offer",
        offerType: "BASE_GAME",
        items: [{ id: "addon-item" }, { id: "base-item" }],
      },
      { id: "addon-offer", offerType: "DLC", items: [{ id: "addon-item" }] },
    ]);

    const response = await app.request(
      request([
        {
          requestId: "addon",
          buildAppName: "SharedBinaryBuild",
          buildVersion: "2.0",
          platform: "Windows",
          catalogHint: {
            artifactId: "AddonApp",
            catalogItemId: "addon-item",
            catalogNamespace: "namespace",
          },
        },
      ]),
    );
    const body = await response.json();

    expect(body.results[0]).toMatchObject({
      requestId: "addon",
      status: "resolved",
      record: {
        kind: "addon",
        artifactId: "AddonApp",
        mainGame: {
          artifactId: "BaseApp",
          catalogItemId: "base-item",
          catalogNamespace: "namespace",
        },
      },
    });
  });

  it("returns ambiguity and validates batch bounds without leaking details", async () => {
    mocks.itemFind.mockResolvedValue([
      { id: "one", namespace: "ns" },
      { id: "two", namespace: "ns" },
    ]);
    const ambiguous = await app.request(
      request([
        {
          requestId: "duplicate",
          buildAppName: "Build",
          buildVersion: "1",
          platform: "Windows",
        },
      ]),
    );
    expect(await ambiguous.json()).toEqual({
      results: [{ requestId: "duplicate", status: "ambiguous" }],
    });

    const invalid = await app.request(
      request([
        {
          requestId: "same",
          buildAppName: "Build",
          buildVersion: "1",
          platform: "Windows",
        },
        {
          requestId: "same",
          buildAppName: "Build2",
          buildVersion: "1",
          platform: "Windows",
        },
      ]),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid launcher record request",
      },
    });
  });

  it("rejects a mismatched companion artifact and returns unknown builds as not found", async () => {
    mocks.itemFind
      .mockResolvedValueOnce([
        {
          id: "hinted-item",
          namespace: "namespace",
          entitlementType: "EXECUTABLE",
          itemType: "APPLICATION",
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.assetFind.mockResolvedValue([
      {
        artifactId: "RealArtifact",
        itemId: "hinted-item",
        platform: "Windows",
      },
    ]);

    const response = await app.request(
      request([
        {
          requestId: "mismatched-hint",
          buildAppName: "Build",
          buildVersion: "1",
          platform: "Windows",
          catalogHint: {
            artifactId: "DifferentArtifact",
            catalogItemId: "hinted-item",
            catalogNamespace: "namespace",
          },
        },
        {
          requestId: "unknown",
          buildAppName: "UnknownBuild",
          buildVersion: "1",
          platform: "Windows",
        },
      ]),
    );

    expect(await response.json()).toEqual({
      results: [
        { requestId: "mismatched-hint", status: "unsupported" },
        { requestId: "unknown", status: "not-found" },
      ],
    });
  });

  it("rejects batches over 100 candidates", async () => {
    const response = await app.request(
      request(
        Array.from({ length: 101 }, (_, index) => ({
          requestId: `candidate-${index}`,
          buildAppName: `Build-${index}`,
          buildVersion: "1",
          platform: "Windows",
        })),
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid launcher record request",
      },
    });
  });
});
