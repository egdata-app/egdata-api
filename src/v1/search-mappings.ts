import type { Client } from "@opensearch-project/opensearch";

type FieldRequirement = {
  path: string;
  types: string[];
  /** Adding a subfield to an existing text field is not possible in place. */
  requiresSubfield?: boolean;
};

type IndexRequirement = {
  index: string;
  fields: FieldRequirement[];
};

export const v1SearchRequirements: IndexRequirement[] = [
  {
    index: "egdata.offers",
    fields: [
      { path: "id.keyword", types: ["keyword"], requiresSubfield: true },
      { path: "title", types: ["text"] },
      { path: "description", types: ["text"] },
      { path: "lastModifiedDate", types: ["date"] },
      { path: "releaseDate", types: ["date"] },
      { path: "effectiveDate", types: ["date"] },
      { path: "creationDate", types: ["date"] },
      { path: "viewableDate", types: ["date"] },
      { path: "pcReleaseDate", types: ["date"] },
      { path: "offerType.keyword", types: ["keyword"], requiresSubfield: true },
      { path: "tags.id.keyword", types: ["keyword"], requiresSubfield: true },
      { path: "tags.name.keyword", types: ["keyword"], requiresSubfield: true },
      {
        path: "categories.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "customAttributes.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "seller.id.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "seller.name.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "developerDisplayName.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "publisherDisplayName.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "refundType.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "lastBuilds.technologies.technology.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      { path: "freeEntries.endDate", types: ["date"] },
    ],
  },
  {
    index: "egdata.items",
    fields: [
      { path: "lastModifiedDate", types: ["date"] },
      { path: "id.keyword", types: ["keyword"], requiresSubfield: true },
      { path: "namespace.keyword", types: ["keyword"], requiresSubfield: true },
      {
        path: "entitlementType.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
    ],
  },
  {
    index: "egdata.changelog",
    fields: [
      { path: "timestamp", types: ["date"] },
      {
        path: "metadata.contextId.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
      {
        path: "metadata.contextType.keyword",
        types: ["keyword"],
        requiresSubfield: true,
      },
    ],
  },
];

function lookupMapping(
  properties: Record<string, any> | undefined,
  path: string,
): Record<string, any> | undefined {
  let current: any = { properties };
  for (const segment of path.split(".")) {
    if (!current?.properties?.[segment]) return undefined;
    current = current.properties[segment];
  }
  return current;
}

function parentProperties(
  mapping: Record<string, any>,
  path: string,
): Record<string, any> | null {
  const segments = path.split(".");
  let current: any = mapping;
  for (const segment of segments.slice(0, -1)) {
    current.properties ??= {};
    current.properties[segment] ??= { properties: {} };
    current = current.properties[segment];
    current.properties ??= {};
  }
  return current.properties ?? null;
}

function typeFor(path: string): string {
  if (path.endsWith("Date") || path.endsWith("endDate")) return "date";
  if (path.endsWith("title") || path.endsWith("description")) return "text";
  return "keyword";
}

export type SearchMappingReport = {
  index: string;
  missing: string[];
  incompatible: string[];
  applied: string[];
};

export async function ensureV1SearchMappings(
  client: Client,
  options: { apply?: boolean } = {},
): Promise<SearchMappingReport[]> {
  const reports: SearchMappingReport[] = [];

  for (const requirement of v1SearchRequirements) {
    const report: SearchMappingReport = {
      index: requirement.index,
      missing: [],
      incompatible: [],
      applied: [],
    };

    let mapping: Record<string, any> | null = null;
    try {
      const response = await client.indices.getMapping({
        index: requirement.index,
      });
      mapping =
        (response.body as Record<string, any>)[requirement.index]?.mappings ??
        null;
    } catch (error) {
      const status =
        (error as { meta?: { statusCode?: number } }).meta?.statusCode ?? 0;
      if (status !== 404) throw error;
    }

    if (!mapping) {
      report.missing.push("* (index does not exist)");
      reports.push(report);
      continue;
    }

    for (const field of requirement.fields) {
      const existing = lookupMapping(mapping.properties, field.path);
      if (existing) {
        const type = String(existing.type ?? "");
        if (existing.properties || field.types.includes(type)) {
          continue;
        }
        report.incompatible.push(`${field.path} (found ${type})`);
        continue;
      }

      report.missing.push(`${field.path} (${field.types.join("|")})`);
      if (!options.apply) continue;
      if (field.requiresSubfield) {
        report.incompatible.push(
          `${field.path} (requires an explicit keyword subfield mapping)`,
        );
        continue;
      }

      const segments = field.path.split(".");
      const last = segments.at(-1);
      if (!last) continue;
      const parent = parentProperties(mapping, field.path);
      const directParentField =
        segments.length > 1
          ? lookupMapping(mapping.properties, segments.slice(0, -1).join("."))
          : null;
      if (directParentField?.type === "text") {
        report.incompatible.push(
          `${field.path} (cannot add a subfield to an existing text field)`,
        );
        continue;
      }
      if (parent) {
        parent[last] = { type: typeFor(field.path) };
        report.applied.push(field.path);
      }
    }

    if (options.apply && report.applied.length > 0) {
      await client.indices.putMapping({
        index: requirement.index,
        body: { properties: mapping.properties },
      });
    }

    reports.push(report);
  }

  return reports;
}
