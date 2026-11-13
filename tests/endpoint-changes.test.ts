import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkChanges,
  generatedOutputs,
  impact,
  publicationOrder,
  type ChangeRecord,
} from "../scripts/changelog/core.js";
import {
  routeInventory,
  type Snapshot,
} from "../scripts/changelog/inventory.js";

const baseCommit = "a".repeat(40);

it("orders correction recovery before batching and rejects cycles", () => {
  const original = record(routeInventory(fixture())[0]);
  const correction = { ...original, id: "correction", corrects: original.id };
  expect(publicationOrder([correction, original]).map((r) => r.id)).toEqual([
    original.id,
    correction.id,
  ]);
  expect(() =>
    publicationOrder([correction, { ...original, corrects: correction.id }]),
  ).toThrow("Correction cycle");
});

it("attributes transitive shared gateway dependencies to every mapped operation", () => {
  const base = fixture();
  base.set(
    "changes/impact-map.json",
    JSON.stringify({ "dashboard/worker/proxy.ts": ["legacy"] }),
  );
  base.set(
    "dashboard/worker/proxy.ts",
    'import { policy } from "./policy.js";',
  );
  base.set(
    "dashboard/worker/policy.ts",
    'export { check } from "./nested.js";',
  );
  base.set("dashboard/worker/nested.ts", "export const check = 1;");
  const head = new Map(base);
  head.set("dashboard/worker/nested.ts", "export const check = 2;");
  const result = impact(base, head);
  expect(result.candidates).toHaveLength(2);
  expect(result.unknown).toEqual([]);
  assess(base, head);
  expect(checkChanges(base, head, baseCommit).errors).toEqual([]);
});

function fixture(): Snapshot {
  const files: Snapshot = new Map([
    [
      "changes/record.schema.json",
      readFileSync("changes/record.schema.json", "utf8"),
    ],
    [
      "changes/assessment.schema.json",
      readFileSync("changes/assessment.schema.json", "utf8"),
    ],
    [
      "src/index.ts",
      'import Offers from "./routes/offers.js"; app.route("/offers", Offers);',
    ],
    [
      "src/routes/offers.ts",
      'import { shared } from "../utils/shared.js"; app.get("/", handler); app.get("/:id", handler);',
    ],
    ["src/utils/shared.ts", 'export { schema } from "./nested.js";'],
    ["src/utils/nested.ts", "export const schema = 1;"],
  ]);
  files.set("changes/endpoints.json", JSON.stringify(routeInventory(files)));
  return files;
}

function assess(base: Snapshot, head: Snapshot, publicIds: string[] = []) {
  const result = impact(base, head);
  head.set(
    "changes/assessments/test.json",
    JSON.stringify({
      baseCommit,
      diffHash: result.diffHash,
      operations: result.candidates.map((endpoint) => ({
        endpoint,
        impact: publicIds.includes(endpoint) ? "public" : "none",
        reason:
          "Internal refactor preserves all request and response behavior.",
        records: publicIds.includes(endpoint) ? ["test-change"] : [],
      })),
      unknownFiles: result.unknown.map((file) => ({
        file,
        reason: "Internal module has no effect on public operations.",
        endpoints: [],
      })),
    }),
  );
}

function record(e: ReturnType<typeof routeInventory>[number]): ChangeRecord {
  return {
    id: "test-change",
    recordedDate: "2026-11-11",
    title: "Concrete response fix",
    verification: ["tests/regression.test.ts"],
    endpoints: [
      {
        apiVersion: e.apiVersion,
        operationId: e.operationId,
        method: e.method,
        path: e.path,
        type: "fixed",
        compatibility: "compatible",
        before: "Response omitted the field.",
        after: "Response includes the field.",
        clientAction: "None",
      },
    ],
  };
}

function registry(head: Snapshot) {
  head.set(
    "changes/endpoints.json",
    generatedOutputs(head).get("changes/endpoints.json")!,
  );
}

describe("strict operation coverage", () => {
  it("assigns distinct legacy IDs to colliding punctuation and preserves version identity", () => {
    const files = fixture();
    files.set(
      "src/routes/offers.ts",
      'app.get("/sitemap.xml", handler); app.get("/sitemap-xml", handler);',
    );
    const endpoints = routeInventory(files);
    expect(new Set(endpoints.map((e) => e.operationId)).size).toBe(2);
  });
  it("detects GraphQL schema structure changes and requires field detail", () => {
    const base = fixture();
    base.set("src/index.ts", 'app.use("/graphql", middleware);');
    base.set(
      "src/graphql/typedefs.ts",
      "export const typeDefs=`type Query { offer: String }`;",
    );
    registry(base);
    const head = new Map(base);
    head.set(
      "src/graphql/typedefs.ts",
      "export const typeDefs=`type Query { offer: Int }`;",
    );
    registry(head);
    assess(base, head);
    expect(
      checkChanges(base, head, baseCommit).errors.filter((e) =>
        e.includes("cannot be waived"),
      ),
    ).toHaveLength(2);
  });
  it("finds transitive shared dependencies for every affected handler", () => {
    const base = fixture();
    const head = new Map(base);
    head.set("src/utils/nested.ts", "export const schema=2;");
    expect(impact(base, head).candidates).toHaveLength(2);
    expect(checkChanges(base, head, baseCommit).errors.join("\n")).toContain(
      "classification",
    );
    assess(base, head);
    expect(checkChanges(base, head, baseCommit).errors).toEqual([]);
  });
  it("rejects stale assessments and unknown impact", () => {
    const base = fixture();
    const head = new Map(base);
    head.set("src/new-shared.ts", "export const x=1;");
    expect(checkChanges(base, head, baseCommit).errors.join("\n")).toContain(
      "Unknown impact",
    );
    assess(base, head);
    expect(checkChanges(base, head, baseCommit).errors).toEqual([]);
    head.set("src/new-shared.ts", "export const x=2;");
    expect(checkChanges(base, head, baseCommit).errors.join("\n")).toContain(
      "Stale assessment",
    );
  });
  it("resolves shared schemas and attributes structural changes to every consumer", () => {
    const base = fixture();
    const doc = {
      openapi: "3.0.3",
      paths: {
        "/v1/a": {
          get: {
            operationId: "a",
            responses: { 200: { $ref: "#/components/responses/Shared" } },
          },
        },
        "/v1/b": {
          get: {
            operationId: "b",
            responses: { 200: { $ref: "#/components/responses/Shared" } },
          },
        },
      },
      components: {
        responses: {
          Shared: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Shared" },
              },
            },
          },
        },
        schemas: {
          Shared: { type: "object", properties: { value: { type: "string" } } },
        },
      },
    };
    base.set("openapi/egdata.v1.openapi.json", JSON.stringify(doc));
    registry(base);
    const head = new Map(base);
    doc.components.schemas.Shared.properties.value.type = "number";
    head.set("openapi/egdata.v1.openapi.json", JSON.stringify(doc));
    registry(head);
    assess(base, head);
    const result = checkChanges(base, head, baseCommit);
    expect([...result.structural]).toEqual(["v1:a", "v1:b"]);
    expect(
      result.errors.filter((e) => e.includes("cannot be waived")),
    ).toHaveLength(2);
    assess(base, head, ["v1:a", "v1:b"]);
    const r = record(routeInventory(head).find((e) => e.operationId === "a")!);
    head.set("changes/records/test-change.json", JSON.stringify(r));
    expect(checkChanges(base, head, baseCommit).errors.join("\n")).toContain(
      "does not cover v1:b",
    );
  });
  it("requires removal and rename coverage including non-JSON endpoints and keeps histories", () => {
    const base = fixture();
    base.set("src/routes/offers.ts", 'app.get("/:id/og", handler);');
    registry(base);
    const head = new Map(base);
    head.set("src/routes/offers.ts", 'app.get("/:id/image", handler);');
    registry(head);
    assess(base, head);
    const result = checkChanges(base, head, baseCommit);
    expect(result.structural.size).toBe(2);
    expect(
      result.errors.filter((e) => e.includes("cannot be waived")),
    ).toHaveLength(2);
    const entries = JSON.parse(head.get("changes/endpoints.json")!);
    expect(entries.find((e: any) => e.path.endsWith("/og")).status).toBe(
      "removed",
    );
    expect(
      generatedOutputs(head).has(
        `apps/docs/content/docs/histories/legacy-${entries.find((e: any) => e.path.endsWith("/og")).operationId}.mdx`,
      ),
    ).toBe(true);
  });
  it("rejects changed history but accepts new correction records", () => {
    const base = fixture();
    const r = record(routeInventory(base)[0]);
    base.set("changes/records/test-change.json", JSON.stringify(r));
    const head = new Map(base);
    head.set(
      "changes/records/test-change.json",
      JSON.stringify({ ...r, title: "Modified history" }),
    );
    expect(checkChanges(base, head, baseCommit).errors.join("\n")).toContain(
      "append-only",
    );
    head.set(
      "changes/records/test-change.json",
      base.get("changes/records/test-change.json")!,
    );
    head.set(
      "changes/records/corrected-change.json",
      JSON.stringify({ ...r, id: "corrected-change", corrects: r.id }),
    );
    expect(checkChanges(base, head, baseCommit).errors).toEqual([]);
  });
  it("rejects invalid fields, wildcard identities, and breaking changes without migration steps", () => {
    const base = fixture();
    const head = new Map(base);
    const r = record(routeInventory(base)[0]);
    r.endpoints[0].compatibility = "breaking";
    head.set("changes/records/test-change.json", JSON.stringify(r));
    expect(checkChanges(base, head, baseCommit).errors.join("\n")).toContain(
      "migration instructions",
    );
    r.endpoints[0].operationId = "*";
    head.set("changes/records/test-change.json", JSON.stringify(r));
    expect(() => checkChanges(base, head, baseCommit)).toThrow();
  });

  it("isolates mounted sub-routers and attributes v1 routes per handler module", () => {
    const base = fixture();
    base.set(
      "src/index.ts",
      [
        'import Offers from "./routes/offers.js";',
        'import v1Router from "./v1/router.js";',
        'app.get("/health", () => new Response("ok"));',
        'app.route("/offers", Offers);',
        'app.route("/v1", v1Router);',
      ].join("\n"),
    );
    base.set(
      "src/v1/router.ts",
      [
        'import assetsRoutes from "./routes/assets.js";',
        'import buildsRoutes from "./routes/builds.js";',
        'v1.route("/", assetsRoutes);',
        'v1.route("/", buildsRoutes);',
      ].join("\n"),
    );
    base.set(
      "src/v1/routes/assets.ts",
      'app.get("/assets/:id", handler);',
    );
    base.set(
      "src/v1/routes/builds.ts",
      'app.get("/builds/:id", handler);',
    );
    base.set(
      "openapi/egdata.v1.openapi.json",
      JSON.stringify({
        openapi: "3.0.3",
        paths: {
          "/v1/assets/{id}": { get: { operationId: "getAsset" } },
          "/v1/builds/{id}": { get: { operationId: "getBuild" } },
        },
      }),
    );
    registry(base);

    const head = new Map(base);
    head.set(
      "src/v1/routes/assets.ts",
      'app.get("/assets/:id", handler); const v = 2;',
    );
    const result = impact(base, head);
    expect(result.candidates).toEqual(["v1:getAsset"]);
    expect(result.unknown).toEqual([]);
  });

  it("ignores type-only, comment-only, non-dependency package.json, and non-public impact-map changes", () => {
    const base = fixture();
    base.set(
      "changes/impact-map.json",
      JSON.stringify({
        "dashboard/worker/proxy.ts": ["legacy"],
        "dashboard/worker/analytics-reporting.ts": [],
        "src/trigger/": [],
      }),
    );
    base.set(
      "dashboard/worker/proxy.ts",
      'import { record } from "./analytics.js"; import type { Summary } from "./types.js"; export const run = (s: Summary) => record(s);',
    );
    base.set(
      "dashboard/worker/analytics.ts",
      'export const record = (x: unknown) => x; export { query } from "./analytics-reporting.js";',
    );
    base.set(
      "dashboard/worker/analytics-reporting.ts",
      "export const query = () => 1;",
    );
    base.set("dashboard/worker/types.ts", "export interface Summary { a: number }");
    base.set("src/trigger/job.ts", "export const runJob = () => 1;");
    base.set(
      "package.json",
      JSON.stringify({ dependencies: { hono: "1.0.0" }, devDependencies: { vitest: "1.0.0" } }),
    );
    registry(base);

    const head = new Map(base);
    head.set(
      "dashboard/worker/analytics-reporting.ts",
      "export const query = () => 2;",
    );
    head.set(
      "dashboard/worker/types.ts",
      "// updated docs\nexport interface Summary { a: number; b?: string }",
    );
    head.set("src/trigger/job.ts", "export const runJob = () => 2;");
    head.set("src/utils/nested.ts", "// comment only\nexport const schema = 1;");
    head.set(
      "package.json",
      JSON.stringify({ dependencies: { hono: "1.0.0" }, devDependencies: { vitest: "2.0.0" } }),
    );

    const result = impact(base, head);
    expect(result.candidates).toEqual([]);
    expect(result.unknown).toEqual([]);
    expect(checkChanges(base, head, baseCommit).errors).toEqual([]);
  });
});
