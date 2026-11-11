import { git, snapshot } from "./changelog/io.js";
import { recordsFrom, publicationOrder } from "./changelog/core.js";
import { canonical, hash } from "./changelog/inventory.js";

// CI-only publisher. Reconcile receipts with the entire validated main manifest,
// so a cancelled/failed previous run cannot lose records or change their merge date.
const endpoint = process.env.CHANGELOG_INGEST_URL;

const token = process.env.CHANGELOG_INGEST_TOKEN;

const head = process.env.GITHUB_SHA;

if (
  !endpoint ||
  !token ||
  !head ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  process.env.GITHUB_EVENT_NAME !== "push"
) {
  throw new Error(
    "Publication requires authenticated main push context and explicit head",
  );
}

const url = new URL(endpoint);

if (
  url.protocol !== "https:" ||
  url.pathname !== "/_internal/change-records" ||
  url.username ||
  url.password ||
  url.search
) {
  throw new Error("Invalid fixed ingestion endpoint");
}

async function post(data: unknown): Promise<Response> {
  for (let attempt = 0; attempt < 4; attempt++) {
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (attempt === 3) {
        throw new Error("Publication network failure; rerun this workflow");
      }
    }
    if (response?.ok) return response;
    if (response && response.status < 500) {
      throw new Error(`Publication rejected: ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  throw new Error("Publication failed; rerun this workflow");
}

const files = snapshot(head);

const records = publicationOrder(recordsFrom(files));

const receiptResponse = await post({ action: "receipts" });

const { receipts } = (await receiptResponse.json()) as {
  receipts: Array<{ id: string; contentHash: string }>;
};

const known = new Map(receipts.map((r) => [r.id, r.contentHash]));

const missing = records.filter((r) => {
  if (!known.has(r.id)) return true;
  if (known.get(r.id) !== hash(canonical(r))) {
    throw new Error(`Immutable published record conflict: ${r.id}`);
  }
  return false;
});

const metadataCache = new Map<
  string,
  { mergeCommit: string; mergedAt: number }
>();

async function metadata(commit: string) {
  const cached = metadataCache.get(commit);
  if (cached) return cached;
  let mergedAt = Date.parse(git("show", "-s", "--format=%cI", commit));
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/commits/${commit}/pulls?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Cannot verify merge metadata: ${response.status}`);
    }
    const prs = (await response.json()) as Array<{
      merge_commit_sha: string;
      merged_at: string | null;
      base: { ref: string };
    }>;
    const merged = prs.find(
      (p) =>
        p.merge_commit_sha === commit && p.merged_at && p.base.ref === "main",
    );
    if (merged?.merged_at) mergedAt = Date.parse(merged.merged_at);
  }
  const result = { mergeCommit: commit, mergedAt };
  metadataCache.set(commit, result);
  return result;
}

const published = [];

for (const record of missing) {
  const commit = git(
    "log",
    "--first-parent",
    "--diff-filter=A",
    "--format=%H",
    "-1",
    head,
    "--",
    `changes/records/${record.id}.json`,
  );
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(`Cannot determine original merge for ${record.id}`);
  }
  published.push({
    record,
    contentHash: hash(canonical(record)),
    ...(await metadata(commit)),
  });
}

const registryMetadata = await metadata(head);

const endpoints = JSON.parse(files.get("changes/endpoints.json") ?? "[]");

const batches = published.length
  ? Array.from({ length: Math.ceil(published.length / 25) }, (_, i) =>
      published.slice(i * 25, i * 25 + 25),
    )
  : [[]];

for (const batch of batches) {
  await post({ ...registryMetadata, endpoints, records: batch });
}

console.log(
  `Published ${published.length} missing records; existing immutable receipts verified.`,
);
