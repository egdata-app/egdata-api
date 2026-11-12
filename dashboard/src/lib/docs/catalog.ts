import { guideDocs, loadGuideSource } from "./guides";
import { fieldIssueDocs, problemDocs, streamResultDocs } from "./problems";
import type { DocCategory, DocEntry } from "./types";

const problemIndex: DocEntry = {
  slug: "problems",
  kind: "index",
  title: "Problem details reference",
  description:
    "Every stable v1 problem code with its HTTP status, meaning, and recovery steps.",
  category: "Errors",
  order: 2,
};

const fieldIssueIndex: DocEntry = {
  slug: "field-issues",
  kind: "index",
  title: "Field issue codes",
  description:
    "Error codes found in the `errors` array of an RFC 9457 problem response.",
  category: "Errors",
  order: 3,
};

export const allDocs: DocEntry[] = [
  ...guideDocs,
  problemIndex,
  fieldIssueIndex,
  ...problemDocs,
  ...streamResultDocs,
  ...fieldIssueDocs,
];

const bySlug = new Map(allDocs.map((entry) => [entry.slug, entry]));

/** Common shorthand links that predate the stable type slugs. */
const aliases = new Map([
  ["invalid-key", "invalid-api-key"],
  ["missing-key", "missing-api-key"],
]);

export function findDoc(slug: string | undefined): DocEntry | undefined {
  if (!slug) return undefined;
  const key = slug.toLowerCase();
  return bySlug.get(aliases.get(key) ?? key);
}

export const DOC_CATEGORY_ORDER: DocCategory[] = [
  "Start here",
  "Find data",
  "Request essentials",
  "Track changes",
  "Advanced",
  "Errors",
  "Credentials",
  "Permissions",
  "Request validation",
  "Pagination",
  "Resource lookup",
  "Payload and protocol",
  "Quota and service",
  "Stream results",
  "Field issues",
];

export function groupDocs(entries: DocEntry[]): Array<{
  category: DocCategory;
  entries: DocEntry[];
}> {
  return DOC_CATEGORY_ORDER.map((category) => ({
    category,
    entries: entries
      .filter((entry) => entry.category === category)
      .sort(
        (a, b) =>
          (a.order ?? 100) - (b.order ?? 100) || a.title.localeCompare(b.title),
      ),
  })).filter((group) => group.entries.length > 0);
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function problemTable(entries: DocEntry[]): string {
  return [
    "| Code | Status | Meaning |",
    "| --- | ---: | --- |",
    ...entries.map(
      (entry) =>
        `| [${entry.code}](/docs/${entry.slug}) | ${entry.status} | ${escapeTableCell(entry.summary ?? entry.description)} |`,
    ),
  ].join("\n");
}

export function problemIndexMarkdown(): string {
  const groups = new Map<string, DocEntry[]>();
  for (const entry of problemDocs) {
    const list = groups.get(entry.category) ?? [];
    list.push(entry);
    groups.set(entry.category, list);
  }

  return [
    "Stable codes are grouped by the layer that returns them. Use `code` for programmatic handling and `requestId` when contacting support.",
    ...DOC_CATEGORY_ORDER.filter((category) =>
      problemDocs.some((entry) => entry.category === category),
    ).map(
      (category) =>
        `## ${category}\n\n${problemTable(groups.get(category) ?? [])}`,
    ),
    `## Stream results\n\n${[
      "| Code | Meaning |",
      "| --- | --- |",
      ...streamResultDocs.map(
        (entry) =>
          `| [${entry.code}](/docs/${entry.slug}) | ${escapeTableCell(entry.summary ?? "")} |`,
      ),
    ].join(
      "\n",
    )}\n\nThese codes appear in newline-delimited catalog hydration results rather than as the HTTP status.`,
    "See [v1 Problem Details](/docs/v1-problems) for the response shape and field-level `errors` arrays.",
  ].join("\n\n");
}

export function fieldIssueIndexMarkdown(): string {
  return [
    "A problem response can include an `errors` array with one entry per invalid field. Each entry can include `pointer`, `parameter`, `code`, and `message`.",
    "| Code | Meaning | Recovery |",
    "| --- | --- | --- |",
    ...fieldIssueDocs.map(
      (entry) =>
        `| [${entry.code}](/docs/${entry.slug}) | ${escapeTableCell(entry.summary ?? "")} | ${escapeTableCell(entry.fix ?? "")} |`,
    ),
    "Field codes describe one value. The top-level `code` still describes the whole request, for example [INVALID_BODY](/docs/invalid-body) or [INVALID_QUERY](/docs/invalid-query).",
  ].join("\n\n");
}

const HTTP_REASON: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

function fencedJson(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function problemMarkdown(entry: DocEntry): string {
  const code = entry.code ?? "UNKNOWN";
  return [
    entry.summary ?? "",
    "## How to fix",
    entry.fix ?? "",
    "## Example response",
    fencedJson({
      type: `https://api.egdata.app/problems/${entry.slug}`,
      title: HTTP_REASON[entry.status ?? 500] ?? "Error",
      status: entry.status,
      detail: entry.summary ?? "The request could not be completed.",
      code,
      requestId: "req_example",
    }),
  ].join("\n\n");
}

function streamResultMarkdown(entry: DocEntry): string {
  return [
    entry.summary ?? "",
    "This code is not the HTTP status of the whole response. Catalog hydration returns `application/x-ndjson`, and each line is a result for one root. Check `status` and `error.code` on every line.",
    "## How to fix",
    entry.fix ?? "",
    "## Example line",
    fencedJson({
      status: "error",
      error: {
        code: entry.code ?? "UNKNOWN",
        message: entry.summary ?? "The root could not be hydrated.",
      },
    }),
  ].join("\n\n");
}

function fieldIssueMarkdown(entry: DocEntry): string {
  return [
    entry.summary ?? "",
    "## How to fix",
    entry.fix ?? "",
    "## Example entry",
    fencedJson({
      pointer: "/limit",
      parameter: "limit",
      code: entry.code ?? "INVALID",
      message: "Expected an integer.",
    }),
    "A field issue appears inside the top-level problem's `errors` array. Handle the top-level `code` first, then inspect each field entry.",
  ].join("\n\n");
}

export async function loadDocSource(
  entry: DocEntry,
): Promise<{ title?: string; description?: string; markdown: string }> {
  if (entry.kind === "problem") {
    return { markdown: problemMarkdown(entry) };
  }
  if (entry.kind === "issue") {
    return { markdown: fieldIssueMarkdown(entry) };
  }
  if (entry.kind === "stream") {
    return { markdown: streamResultMarkdown(entry) };
  }
  if (entry.slug === "endpoint-history") {
    return {
      markdown: [
        "Recorded dates describe when a change was merged into the repository. They are not deployment dates, and a change may be ahead of the deployed contract.",
        "Open any operation in the [API reference](/docs) and use the **Change History** tab to see its dated entries. Each entry lists the before and after behavior, compatibility, and any client action.",
        "A merged record is published independently of deployment. Project alerts mark relevant changes as **Merged; deployment not verified** until the deployment is confirmed.",
      ].join("\n\n"),
    };
  }
  if (entry.slug === "histories") {
    return {
      markdown: [
        "Operations that are no longer part of the deployed v1 contract remain in the reference under the **Merged history** resource group.",
        "Open the [API reference](/docs), expand **Merged history**, and select an operation ID to inspect its recorded history. The operation is clearly marked as absent from the deployed contract, and **Try it** is disabled.",
        "Legacy-only operation IDs do not accept new v1 requests. Use the deployed operation that replaces them when one is listed in the change history.",
      ].join("\n\n"),
    };
  }
  if (entry.slug === "api-reference") {
    return {
      markdown: [
        "The interactive reference is available at [/docs](/docs). It groups operations by resource, shows the deployed contract, and lets you run requests with a short-lived console session or your own API key.",
        "Open an operation from the sidebar or the resource grid to inspect parameters, request bodies, response schemas, examples, and dated change history.",
        "Problem codes are documented individually under [Problem details reference](/docs/problems).",
      ].join("\n\n"),
    };
  }
  if (entry.slug === "problems") {
    return { markdown: problemIndexMarkdown() };
  }
  if (entry.slug === "field-issues") {
    return { markdown: fieldIssueIndexMarkdown() };
  }
  const source = loadGuideSource(entry.slug);
  if (!source) return { markdown: "" };
  return { markdown: await source };
}
