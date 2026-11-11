import {
  cursorParameter,
  defineOperations,
  limitParameter,
  pathParameter,
  queryParameter,
  type V1OperationMetadata,
} from "../route-types.js";

type RequestBody = NonNullable<V1OperationMetadata["requestBody"]>;

const buildIdParameter = (description: string) =>
  pathParameter("id", description);

const sortDirectionParameter = (
  description = "Sort direction. Defaults to `asc`.",
) =>
  queryParameter("dir", description, {
    type: "string",
    enum: ["asc", "desc"],
    default: "asc",
  });

const pathQueryParameter = queryParameter(
  "q",
  "Literal, case-insensitive file path search. Regular-expression characters are matched literally.",
  { type: "string", maxLength: 200 },
);

const extensionParameter = queryParameter(
  "extension",
  "Comma-separated file extensions without leading dots, for example `pak,dll`. At most 20 distinct extensions are accepted.",
  { type: "string", maxLength: 500 },
);

const launcherRecordsBody: RequestBody = {
  required: true,
  description:
    "Up to 100 parsed Windows manifest candidates. Only bounded metadata is accepted; manifest bytes and local file paths are rejected.",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["candidates"],
    properties: {
      candidates: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["requestId", "buildAppName", "buildVersion", "platform"],
          properties: {
            requestId: {
              type: "string",
              minLength: 1,
              maxLength: 128,
              description:
                "Caller correlation value. Every candidate in one request must use a unique `requestId`.",
            },
            buildAppName: {
              type: "string",
              minLength: 1,
              maxLength: 256,
              description: "Application name parsed from the manifest.",
            },
            buildVersion: {
              type: "string",
              maxLength: 512,
              description: "Build version parsed from the manifest.",
            },
            platform: {
              type: "string",
              enum: ["Windows"],
              description: "Only Windows manifests are resolvable.",
            },
            catalogHint: {
              type: "object",
              additionalProperties: false,
              required: ["artifactId", "catalogItemId", "catalogNamespace"],
              properties: {
                artifactId: { type: "string", minLength: 1, maxLength: 256 },
                catalogItemId: { type: "string", minLength: 1, maxLength: 256 },
                catalogNamespace: {
                  type: "string",
                  minLength: 1,
                  maxLength: 256,
                },
              },
            },
          },
        },
      },
    },
  },
};

export const buildsOperations = defineOperations([
  {
    operationId: "listBuilds",
    method: "GET",
    path: "/v1/builds",
    summary: "List observed builds",
    description:
      "Returns observed builds ordered by the requested timestamp field with `_id` as a tie-breaker in the same direction and missing timestamps last. Each entry is a build summary with the matching executable catalog item when one is known.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    paginated: true,
    parameters: [
      cursorParameter(),
      limitParameter(),
      queryParameter(
        "sortBy",
        "Timestamp field used for ordering. Defaults to `createdAt`.",
        {
          type: "string",
          enum: ["createdAt", "updatedAt", "firstSeenAt"],
          default: "createdAt",
        },
      ),
      queryParameter("sortDir", "Sort direction. Defaults to `desc`.", {
        type: "string",
        enum: ["asc", "desc"],
        default: "desc",
      }),
    ],
    responseDescription:
      "Cursor page of build summaries, each with the matching catalog item or `null`.",
    legacy: ["/builds"],
  },
  {
    operationId: "getBuild",
    method: "GET",
    path: "/v1/builds/{id}",
    summary: "Get a sanitized build snapshot",
    description:
      "Returns one build summary with manifest status, sizes, technologies, and stored size fallbacks from the matching platform asset. Raw manifest locations are never returned.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    parameters: [buildIdParameter("Build document identifier.")],
    legacy: ["/builds/{id}"],
  },
  {
    operationId: "getBuildHistory",
    method: "GET",
    path: "/v1/builds/{id}/history",
    summary: "List comparison candidates for a build",
    description:
      "Returns chronological observations for the same label stream or platform as the build, ordered by `firstSeenAt` descending, `createdAt` descending, and `_id` descending. Each entry reports whether it has a comparable stored snapshot and whether it belongs to the same stream; `meta.previousComparableBuildId` identifies the previous comparable snapshot.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    paginated: true,
    parameters: [
      buildIdParameter("Build document identifier."),
      cursorParameter(),
      limitParameter(),
      queryParameter("scope", "Candidate scope. Defaults to `stream`.", {
        type: "string",
        enum: ["stream", "platform"],
        default: "stream",
      }),
    ],
    responseDescription:
      "Cursor page of build summaries with `comparable` and `sameStream`, plus `meta.previousComparableBuildId`.",
    legacy: ["/builds/{id}/history"],
  },
  {
    operationId: "compareBuilds",
    method: "GET",
    path: "/v1/builds/{targetId}/compare/{baseId}",
    summary: "Compare two stored build snapshots",
    description:
      "Compares immutable file snapshots by full path, ordered by `fileName` in the requested direction with an opaque `fileName` cursor. Responding requires streaming both stored snapshots so the summary, top files, and top directories are complete; the page size is bounded, the scan is not. Full-download deltas are not patch-download estimates.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    paginated: true,
    parameters: [
      pathParameter(
        "targetId",
        "Build document identifier of the target build.",
      ),
      pathParameter("baseId", "Build document identifier of the base build."),
      cursorParameter(),
      limitParameter(),
      sortDirectionParameter("Path order. Defaults to `asc`."),
      queryParameter(
        "status",
        "Comma-separated change statuses. Defaults to `added,modified,removed`.",
        {
          type: "string",
          pattern:
            "^(added|removed|modified|unchanged)(,(added|removed|modified|unchanged))*$",
        },
      ),
      pathQueryParameter,
      extensionParameter,
    ],
    responseDescription:
      "Comparison summary, warnings, and a cursor page of `changes`.",
    legacy: ["/builds/{targetId}/compare/{baseId}"],
  },
  {
    operationId: "listBuildFiles",
    method: "GET",
    path: "/v1/builds/{id}/files",
    summary: "List files in a build snapshot",
    description:
      "Returns file snapshot records ordered by `depth`, `fileName`, or `fileSize` with a `fileName` tie-breaker, filtered by literal path search and extension. Items without the sort value use the natural BSON null order for the requested direction.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    paginated: true,
    parameters: [
      buildIdParameter("Build document identifier."),
      cursorParameter(),
      limitParameter(),
      queryParameter("sort", "Sort field. Defaults to `depth`.", {
        type: "string",
        enum: ["depth", "fileName", "fileSize"],
        default: "depth",
      }),
      sortDirectionParameter(),
      pathQueryParameter,
      extensionParameter,
    ],
    responseDescription:
      "Cursor page of file records plus `meta.manifestStatus`.",
    legacy: ["/builds/{id}/files"],
  },
  {
    operationId: "getBuildTree",
    method: "GET",
    path: "/v1/builds/{id}/tree",
    summary: "Expand one directory of a build file tree",
    description:
      "Returns only the immediate child files and directories of the requested manifest directory, ordered by node type and then name. Expand a directory by passing the `path` returned for that node. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    paginated: true,
    parameters: [
      buildIdParameter("Build document identifier."),
      cursorParameter(),
      limitParameter(),
      queryParameter(
        "path",
        "Relative directory to expand, using forward slashes. Omit for the build root.",
        { type: "string", maxLength: 500 },
      ),
    ],
    responseDescription:
      "Cursor page of `directory` and `file` nodes plus `meta.path` and `meta.manifestStatus`.",
    legacy: ["/builds/{id}/tree"],
  },
  {
    operationId: "listBuildItems",
    method: "GET",
    path: "/v1/builds/{id}/items",
    summary: "List catalog items associated with a build",
    description:
      "Returns catalog items whose release info references the build app name, ordered by catalog `id` ascending.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    paginated: true,
    parameters: [
      buildIdParameter("Build document identifier."),
      cursorParameter(),
      limitParameter(),
    ],
    responseDescription: "Cursor page of serialized catalog items.",
    legacy: ["/builds/{id}/items"],
  },
  {
    operationId: "getBuildInstallOptions",
    method: "GET",
    path: "/v1/builds/{id}/install-options",
    summary: "Summarize install tags in a build",
    description:
      "Returns a bounded map keyed by install tag, with file counts and total bytes. The map is not paginated; `meta.truncated` reports whether the safety cap was reached.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    parameters: [buildIdParameter("Build document identifier.")],
    responseDescription:
      "Object keyed by install tag with `{ files, size }` values and `meta.truncated`.",
    legacy: ["/builds/{id}/install-options"],
  },
  {
    operationId: "resolveLauncherRecords",
    method: "POST",
    path: "/v1/builds/resolve-launcher-records",
    summary: "Resolve parsed Windows manifests to launcher metadata",
    description:
      "Resolves bounded, path-free metadata from parsed Windows manifests. Results preserve request order and echo each `requestId` with its per-candidate status. Ambiguous catalog, asset, and parent relationships are reported as `ambiguous` instead of guessing.",
    tags: ["Builds"],
    scope: "builds:read",
    auth: "key",
    expensivePolicy: "bulk",
    requestBody: launcherRecordsBody,
    responseDescription:
      "Object with a `results` array holding one resolved record or status per candidate, in request order.",
    legacy: ["/builds/resolve-launcher-records"],
  },
] as const);
