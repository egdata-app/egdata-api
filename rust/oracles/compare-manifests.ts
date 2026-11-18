export const historicalComparisons = [
  {
    name: "unknown-status",
    target: { manifestStatus: "old-importer" },
    legacy: 409,
    v1: 409,
  },
  {
    name: "numeric-manifest",
    target: { manifestId: 17 },
    legacy: 409,
    v1: 409,
  },
  {
    name: "incompatible-before-status",
    target: { appName: "another", manifestStatus: "old-importer" },
    legacy: 400,
    v1: 400,
  },
  {
    name: "bad-platform",
    target: { platform: null, labelName: null },
    legacy: 500,
    v1: 500,
  },
  {
    name: "string-update",
    target: { updatedAt: "archived-time" },
    legacy: 200,
    v1: 500,
  },
  {
    name: "historical-sizes",
    base: {
      installedSizeBytes: 12.5,
      downloadSizeBytes: "size unknown",
      manifestFileCount: "two",
    },
    target: { installedSizeBytes: -7.25, downloadSizeBytes: 3.5 },
    legacy: 200,
    v1: 200,
  },
  {
    name: "duplicate-technologies",
    base: {
      technologies: [
        { section: "engine", technology: "old", version: 1 },
        { section: "engine", technology: "old", version: 2 },
      ],
    },
    target: {
      technologies: [
        { section: "engine", technology: "new", version: 1 },
        { section: "engine", technology: "new", version: 2 },
        { metadata: { publisher: "studio" } },
      ],
    },
    legacy: 200,
    v1: 200,
  },
  {
    name: "invalid-technologies",
    target: { technologies: "archived" },
    legacy: 500,
    v1: 500,
  },
  {
    name: "null-technology",
    target: { technologies: [null] },
    legacy: 500,
    v1: 500,
  },
  {
    name: "absent-optional-fields",
    target: {
      technologies: null,
      previousObservedBuildId: "previous-import",
      manifestParserVersion: 3,
      buildVersion: null,
    },
    legacy: 200,
    v1: 200,
  },
];
