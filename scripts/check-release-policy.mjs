import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (process.env.GITHUB_EVENT_PATH) {
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    const labels = event.pull_request?.labels?.map((label) => label.name) ?? [];
    if (labels.includes("skip-changelog")) {
      console.log("Release policy check skipped by skip-changelog label.");
      process.exit(0);
    }
  } catch {
    // Ignore malformed or unavailable GitHub event payloads outside CI.
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const base =
  process.env.GITHUB_BASE_REF &&
  process.env.GITHUB_EVENT_NAME === "pull_request"
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : "HEAD~1";

let changed = [];
try {
  const output = git(["diff", "--name-only", `${base}...HEAD`]);
  changed = output ? output.split(/\r?\n/) : [];
} catch {
  const output = git(["diff", "--name-only", "HEAD"]);
  changed = output ? output.split(/\r?\n/) : [];
}

const workingTreeOutput = git(["diff", "--name-only", "HEAD"]);
const workingTreeChanged = workingTreeOutput ? workingTreeOutput.split(/\r?\n/) : [];
const untrackedOutput = git(["ls-files", "--others", "--exclude-standard"]);
const untrackedChanged = untrackedOutput ? untrackedOutput.split(/\r?\n/) : [];
changed = Array.from(
  new Set([...changed, ...workingTreeChanged, ...untrackedChanged]),
);

const policyRelevant = changed.filter((file) =>
  [
    /^src\//,
    /^scripts\//,
    /^apps\/docs\//,
    /^openapi\//,
    /^package\.json$/,
    /^pnpm-lock\.yaml$/,
    /^pnpm-workspace\.yaml$/,
    /^Dockerfile/,
    /^\.github\/workflows\//,
  ].some((pattern) => pattern.test(file)),
);

const hasReleaseNote = changed.some(
  (file) =>
    file === "CHANGELOG.md" ||
    file === "docs/release-policy.md" ||
    /^\.changeset\/.+\.md$/.test(file),
);

if (policyRelevant.length > 0 && !hasReleaseNote) {
  console.error(
    [
      "Release policy check failed.",
      "Changes that can affect users or maintainers need a CHANGELOG.md update, docs/release-policy.md update, or .changeset/*.md note.",
      "Relevant files:",
      ...policyRelevant.map((file) => `- ${file}`),
      "Use the skip-changelog PR label only for intentionally exempt maintenance changes.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("Release policy check passed.");
