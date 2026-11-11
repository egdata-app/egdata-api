import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  canonical,
  contractOperations,
  closure,
  dependencies,
  endpointKey,
  graphqlContract,
  hash,
  routeInventory,
  type Endpoint,
  type Snapshot,
} from "./inventory.js";

export type ChangeRecord = {
  id: string;
  recordedDate: string;
  title: string;
  corrects?: string;
  verification: string[];
  endpoints: Array<
    Pick<Endpoint, "apiVersion" | "operationId" | "method" | "path"> & {
      type:
        | "added"
        | "changed"
        | "fixed"
        | "deprecated"
        | "removed"
        | "security";
      compatibility: "compatible" | "breaking";
      before: string;
      after: string;
      clientAction: string;
      schemaFields?: string[];
      replaces?: string;
      replacement?: string | null;
    }
  >;
};

export type Assessment = {
  baseCommit: string;
  diffHash: string;
  operations: Array<{
    endpoint: string;
    impact: "public" | "none";
    reason: string;
    records: string[];
  }>;
  unknownFiles: Array<{ file: string; reason: string; endpoints: string[] }>;
};

/** Corrections must follow their originals, including recovery across publication batches. */
export function publicationOrder(records: ChangeRecord[]): ChangeRecord[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const ordered: ChangeRecord[] = [];
  function visit(record: ChangeRecord) {
    if (done.has(record.id)) return;
    if (visiting.has(record.id))
      throw new Error(`Correction cycle: ${record.id}`);
    visiting.add(record.id);
    const original = record.corrects && byId.get(record.corrects);
    if (original) visit(original);
    visiting.delete(record.id);
    done.add(record.id);
    ordered.push(record);
  }
  records.forEach(visit);
  return ordered;
}

export function validateSchema(schema: object, data: unknown): void {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    throw new Error(ajv.errorsText(validate.errors, { separator: "\n" }));
  }
}

export function recordsFrom(files: Snapshot): ChangeRecord[] {
  return [...files]
    .filter(([p]) => /^changes\/records\/[^/]+\.json$/.test(p))
    .map(([p, s]) => {
      const record = JSON.parse(s);
      validateSchema(
        JSON.parse(files.get("changes/record.schema.json")!),
        record,
      );
      if (/TODO:/.test(JSON.stringify(record))) {
        throw new Error(`Unfinished record: ${p}`);
      }
      if (p !== `changes/records/${record.id}.json`) {
        throw new Error(`Record filename does not match ID: ${p}`);
      }
      return record as ChangeRecord;
    })
    .sort(
      (a, b) =>
        b.recordedDate.localeCompare(a.recordedDate) ||
        a.id.localeCompare(b.id),
    );
}

const relevant = (p: string) =>
  /^(src\/|openapi\/|dashboard\/worker\/|dashboard\/(wrangler\.jsonc|package\.json)$|Dockerfile|rslib\.config\.|package\.json$|pnpm-(lock|workspace)\.yaml$)/.test(
    p,
  );

export function impact(base: Snapshot, head: Snapshot) {
  const changed = [...new Set([...base.keys(), ...head.keys()])]
    .filter((p) => relevant(p) && base.get(p) !== head.get(p))
    .sort();
  const all = new Map<string, Endpoint>();
  for (const files of [base, head]) {
    for (const e of routeInventory(files)) all.set(endpointKey(e), e);
  }
  // A registry entry is retained even after a route disappears from both generated contracts.
  for (const files of [base, head]) {
    for (const e of JSON.parse(
      files.get("changes/endpoints.json") ?? "[]",
    ) as Endpoint[]) {
      if (!all.has(endpointKey(e))) all.set(endpointKey(e), e);
    }
  }
  const candidates = new Set<string>();
  const known = new Set<string>();
  for (const files of [base, head]) {
    const graph = dependencies(files);
    for (const e of all.values()) {
      const deps = closure(graph, e.sources);
      for (const file of changed) {
        if (deps.has(file)) {
          candidates.add(endpointKey(e));
          known.add(file);
        }
      }
    }
  }
  const mappings = JSON.parse(
    head.get("changes/impact-map.json") ?? "{}",
  ) as Record<string, string[]>;
  for (const files of [base, head]) {
    const graph = dependencies(files);
    for (const [root, versions] of Object.entries(mappings)) {
      const deps = closure(graph, [root]);
      for (const file of changed.filter((p) => deps.has(p))) {
        known.add(file);
        for (const e of all.values()) {
          if (versions.includes(e.apiVersion)) candidates.add(endpointKey(e));
        }
      }
    }
  }
  const before = contractOperations(base);
  const after = contractOperations(head);
  const structural = new Set(
    [...new Set([...before.keys(), ...after.keys()])].filter(
      (k) => before.get(k) !== after.get(k),
    ),
  );
  const oldRoutes = new Map(
    routeInventory(base).map((e) => [endpointKey(e), `${e.method} ${e.path}`]),
  );
  const newRoutes = new Map(
    routeInventory(head).map((e) => [endpointKey(e), `${e.method} ${e.path}`]),
  );
  for (const key of new Set([...oldRoutes.keys(), ...newRoutes.keys()])) {
    if (oldRoutes.get(key) !== newRoutes.get(key)) structural.add(key);
  }
  structural.forEach((k) => candidates.add(k));
  if (graphqlContract(base) !== graphqlContract(head)) {
    for (const e of all.values()) {
      if (e.path === "/graphql") {
        structural.add(endpointKey(e));
        candidates.add(endpointKey(e));
      }
    }
  }
  // Generated contracts are classified by the resolved operation comparison.
  changed.filter((p) => p.startsWith("openapi/")).forEach((p) => known.add(p));
  return {
    changed,
    candidates: [...candidates].sort(),
    structural,
    added: new Set([...newRoutes.keys()].filter((k) => !oldRoutes.has(k))),
    removed: new Set([...oldRoutes.keys()].filter((k) => !newRoutes.has(k))),
    unknown: changed.filter((p) => !known.has(p)),
    diffHash: hash(
      canonical(
        changed.map((p) => [
          p,
          hash(base.get(p) ?? ""),
          hash(head.get(p) ?? ""),
        ]),
      ),
    ),
    endpoints: all,
  };
}

export function checkChanges(
  base: Snapshot,
  head: Snapshot,
  baseCommit: string,
) {
  const errors: string[] = [];
  const records = recordsFrom(head);
  try {
    publicationOrder(records);
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : "Invalid correction chain",
    );
  }
  const registry = JSON.parse(
    head.get("changes/endpoints.json") ?? "[]",
  ) as Endpoint[];
  if (head.has("changes/endpoint-registry.schema.json")) {
    validateSchema(
      JSON.parse(head.get("changes/endpoint-registry.schema.json")!),
      registry,
    );
  }

  const endpoints = new Map(registry.map((e) => [endpointKey(e), e]));
  if (endpoints.size !== registry.length) {
    errors.push("Duplicate endpoint registry IDs");
  }

  const current = routeInventory(head);
  for (const e of current) {
    const entry = endpoints.get(endpointKey(e));
    if (
      !entry ||
      entry.method !== e.method ||
      entry.path !== e.path ||
      entry.status !== "active" ||
      canonical(entry.sources) !== canonical(e.sources)
    ) {
      errors.push(`Stale registry: ${endpointKey(e)}; run changelog:generate`);
    }
  }
  const currentKeys = new Set(current.map(endpointKey));
  for (const entry of registry) {
    if (!currentKeys.has(endpointKey(entry)) && entry.status !== "removed") {
      errors.push(
        `Removed endpoint must retain a removed registry entry: ${endpointKey(entry)}`,
      );
    }
  }

  const oldRegistry = JSON.parse(
    base.get("changes/endpoints.json") ?? "[]",
  ) as Endpoint[];
  for (const old of oldRegistry) {
    const next = endpoints.get(endpointKey(old));
    if (!next || next.path !== old.path || next.method !== old.method) {
      errors.push(
        `Endpoint identities are immutable: ${endpointKey(old)}; use a new ID and replacement reference`,
      );
    }
  }

  for (const [p, content] of base) {
    if (/^changes\/records\/.*\.json$/.test(p) && head.get(p) !== content) {
      errors.push(`Merged records are append-only: ${p}`);
    }
  }
  if (
    base.has("changes/archive/undated.md") &&
    base.get("changes/archive/undated.md") !==
      head.get("changes/archive/undated.md")
  ) {
    errors.push("Undated historical archive is immutable");
  }

  const ids = new Set(records.map((r) => r.id));
  if (ids.size !== records.length) errors.push("Duplicate record IDs");
  for (const r of records) {
    if (r.corrects && (!ids.has(r.corrects) || r.corrects === r.id)) {
      errors.push(`Invalid correction reference: ${r.id}`);
    }
    const seen = new Set<string>();
    for (const e of r.endpoints) {
      const key = endpointKey(e);
      const registered = endpoints.get(key);
      if (seen.has(key)) errors.push(`Duplicate endpoint in ${r.id}: ${key}`);
      seen.add(key);
      if (
        !registered ||
        registered.method !== e.method ||
        registered.path !== e.path
      ) {
        errors.push(`Unknown endpoint identity in ${r.id}: ${key}`);
      }
      if (
        e.compatibility === "breaking" &&
        /^(none|n\/a|no action)[.!]?$/i.test(e.clientAction.trim())
      ) {
        errors.push(
          `Breaking change needs migration instructions: ${r.id} ${key}`,
        );
      }
      if (e.path === "/graphql" && !e.schemaFields?.length) {
        errors.push(`GraphQL changes need affected schema fields: ${r.id}`);
      }
      for (const ref of [e.replaces, e.replacement]) {
        if (ref && (!endpoints.has(ref) || ref === key)) {
          errors.push(`Unknown/self replacement: ${r.id} ${ref}`);
        }
      }
      if (e.type === "removed" && !("replacement" in e)) {
        errors.push(
          `Removal must explicitly identify replacement (or null): ${r.id} ${key}`,
        );
      }
    }
  }

  const result = impact(base, head);
  const assessments: Assessment[] = [];
  for (const [p, content] of head) {
    if (/^changes\/assessments\/.*\.json$/.test(p) && content !== base.get(p)) {
      const a = JSON.parse(content);
      validateSchema(
        JSON.parse(head.get("changes/assessment.schema.json")!),
        a,
      );
      if (/TODO:/.test(JSON.stringify(a))) {
        errors.push(`Unfinished assessment: ${p}`);
      }
      if (a.baseCommit !== baseCommit || a.diffHash !== result.diffHash) {
        errors.push(
          `Stale assessment: ${p}; refresh against --base ${baseCommit}`,
        );
      } else assessments.push(a);
    }
  }
  if (result.changed.length && !assessments.length) {
    errors.push("API changes require a current validated impact assessment");
  }

  const declared = assessments.flatMap((a) => a.operations);
  const classify = (key: string) => {
    const entries = declared.filter((e) => e.endpoint === key);
    if (entries.length !== 1) {
      errors.push(`Expected one impact classification: ${key}`);
      return;
    }
    const entry = entries[0];
    if (entry.impact === "none" && entry.records.length) {
      errors.push(`No-impact classification has records: ${key}`);
    }
    if (result.structural.has(key) && entry.impact !== "public") {
      errors.push(`Structural contract change cannot be waived: ${key}`);
    }
    if (entry.impact === "public") {
      if (!entry.records.length) {
        errors.push(`Public change missing records: ${key}`);
      }
      for (const id of entry.records) {
        if (
          !records.some(
            (r) =>
              r.id === id &&
              !base.has(`changes/records/${id}.json`) &&
              r.endpoints.some((e) => endpointKey(e) === key),
          )
        ) {
          errors.push(
            `Record ${id} does not cover ${key} (must be new in this PR)`,
          );
        }
      }
      const coverage = records
        .filter(
          (r) =>
            entry.records.includes(r.id) &&
            !base.has(`changes/records/${r.id}.json`),
        )
        .flatMap((r) => r.endpoints)
        .filter((e) => endpointKey(e) === key);
      if (
        result.removed.has(key) &&
        !coverage.some(
          (e) =>
            e.type === "removed" &&
            e.compatibility === "breaking" &&
            "replacement" in e,
        )
      ) {
        errors.push(
          `Removed operation needs a breaking removal record with an explicit replacement or null: ${key}`,
        );
      }
      if (result.added.has(key) && !coverage.some((e) => e.type === "added")) {
        errors.push(`Added operation needs an added record: ${key}`);
      }
      // A method/path whose operation ID changed is an explicit identity rename.
      const endpoint = result.endpoints.get(key);
      if (endpoint && result.removed.has(key)) {
        const replacement = [...result.added].find((k) => {
          const added = result.endpoints.get(k);
          return (
            added?.apiVersion === endpoint.apiVersion &&
            added.method === endpoint.method &&
            added.path === endpoint.path
          );
        });
        if (
          replacement &&
          !coverage.some((e) => e.replacement === replacement)
        ) {
          errors.push(
            `Operation rename must identify replacement ${replacement}: ${key}`,
          );
        }
      }
      if (endpoint && result.added.has(key)) {
        const old = [...result.removed].find((k) => {
          const removed = result.endpoints.get(k);
          return (
            removed?.apiVersion === endpoint.apiVersion &&
            removed.method === endpoint.method &&
            removed.path === endpoint.path
          );
        });
        if (old && !coverage.some((e) => e.replaces === old)) {
          errors.push(
            `Operation rename must identify old operation ${old}: ${key}`,
          );
        }
      }
    }
  };
  const extraCandidates = new Set(result.candidates);
  for (const file of result.unknown) {
    const entries = assessments
      .flatMap((a) => a.unknownFiles)
      .filter((e) => e.file === file);
    if (entries.length !== 1) {
      errors.push(`Unknown impact requires explicit classification: ${file}`);
    }
    for (const key of entries[0]?.endpoints ?? []) extraCandidates.add(key);
  }
  for (const entry of declared) {
    if (!endpoints.has(entry.endpoint)) {
      errors.push(`Unknown assessment endpoint: ${entry.endpoint}`);
    }
  }
  extraCandidates.forEach(classify);
  return { errors, ...result };
}

export function generatedOutputs(files: Snapshot): Map<string, string> {
  const records = recordsFrom(files);
  const previous = JSON.parse(
    files.get("changes/endpoints.json") ?? "[]",
  ) as Endpoint[];
  const inventory = routeInventory(files);
  const current = new Set(inventory.map(endpointKey));
  const registry = [
    ...inventory,
    ...previous
      .filter((e) => !current.has(endpointKey(e)))
      .map((e) => ({ ...e, status: "removed" as const })),
  ].sort((a, b) => endpointKey(a).localeCompare(endpointKey(b)));
  const out = new Map<string, string>();
  out.set("changes/endpoints.json", JSON.stringify(registry, null, 2) + "\n");
  const manifest = {
    schemaVersion: 1,
    endpoints: registry,
    records: records.map((record) => ({
      record,
      contentHash: hash(canonical(record)),
      source: `changes/records/${record.id}.json`,
    })),
  };
  out.set("changes/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  const header =
    "# Changelog\n\nGenerated from validated change records. Recorded dates are not deployment dates.\n\n";
  const escape = (s: string) =>
    s
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("{", "&#123;")
      .replaceAll("}", "&#125;");
  const render = (r: ChangeRecord) =>
    `## ${r.recordedDate} — ${escape(r.title)}\n\nRecord: [${r.id}](https://github.com/egdata-app/egdata-api/blob/main/changes/records/${r.id}.json)${r.corrects ? `; corrects ${r.corrects}` : ""}.\n\n` +
    r.endpoints
      .map(
        (e) =>
          `- **${e.apiVersion} ${e.method} ${escape(e.path)}** (${e.operationId}; ${e.type}; ${e.compatibility})\n  - Before: ${escape(e.before)}\n  - After: ${escape(e.after)}\n  - Client action: ${escape(e.clientAction)}\n${e.schemaFields ? `  - Schema fields: ${e.schemaFields.join(", ")}\n` : ""}${e.replacement ? `  - Replacement: ${e.replacement}\n` : ""}`,
      )
      .join("") +
    `\nVerification: ${r.verification.map(escape).join("; ")}.\n\n`;
  const history =
    records.map(render).join("") || "No dated change records yet.\n\n";
  out.set(
    "CHANGELOG.md",
    header +
      history +
      "## Undated historical notes\n\nEarlier notes are preserved verbatim in [the historical archive](changes/archive/undated.md). They have no inferred dates or endpoint mappings and never generate personalized alerts.\n",
  );
  out.set(
    "apps/docs/content/docs/endpoint-history.mdx",
    "---\ntitle: Endpoint histories\ndescription: Dated API behavior changes, independent of deployment.\n---\n\n" +
      history +
      "[Undated historical notes](https://github.com/egdata-app/egdata-api/blob/main/changes/archive/undated.md) are excluded from alerts.\n",
  );
  out.set(
    "apps/docs/content/docs/histories/meta.json",
    JSON.stringify(
      {
        title: "Endpoint histories",
        pages: [
          "index",
          ...registry.map((e) => `${e.apiVersion}-${e.operationId}`),
        ],
      },
      null,
      2,
    ) + "\n",
  );
  out.set(
    "apps/docs/content/docs/histories/index.mdx",
    "---\ntitle: Histories by operation\ndescription: Stable identities for legacy and v1 endpoints.\n---\n\n" +
      ["legacy", "v1"]
        .map(
          (version) =>
            `## ${version}\n\n` +
            registry
              .filter((e) => e.apiVersion === version)
              .map(
                (e) =>
                  `- [${e.operationId}](/docs/histories/${e.apiVersion}-${e.operationId}) — \`${e.method} ${e.path}\` (${e.status})`,
              )
              .join("\n") +
            "\n\n",
        )
        .join(""),
  );
  for (const e of registry) {
    const entries = records.filter((r) =>
      r.endpoints.some((item) => endpointKey(item) === endpointKey(e)),
    );
    out.set(
      `apps/docs/content/docs/histories/${e.apiVersion}-${e.operationId}.mdx`,
      `---\ntitle: ${e.apiVersion} ${e.operationId}\ndescription: History for ${e.method} ${e.path}\n---\n\n\`${e.method} ${e.path}\` — ${e.status}. Recorded dates are not deployment dates.\n\n` +
        entries
          .map((record) =>
            render({
              ...record,
              endpoints: record.endpoints.filter(
                (item) => endpointKey(item) === endpointKey(e),
              ),
            }),
          )
          .join("") +
        (entries.length ? "" : "No dated records for this operation.\n"),
    );
  }
  for (const [path, content] of out) out.set(path, content.trimEnd() + "\n");
  return out;
}
