import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Offline preparation only. Applying the SQL is an explicit deployment operation.
const [termsPath, privacyPath, version, publishedAt, output] =
  process.argv.slice(2);
if (
  !termsPath ||
  !privacyPath ||
  !/^[A-Za-z0-9._-]{1,50}$/.test(version ?? "") ||
  !output ||
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
    publishedAt ?? "",
  ) ||
  !Number.isFinite(Date.parse(publishedAt))
) {
  throw new Error(
    "Usage: node scripts/prepare-legal-rollout.mjs <final-terms.md> <final-privacy.md> <version> <publication-ISO> <output.sql>",
  );
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const published = Date.parse(publishedAt);
// D1 execute does not accept SQL BEGIN/COMMIT. Publish immutable documents first;
// only the final statement enables onboarding. A partial import never enables it.
const statements = [];
for (const [kind, file] of [
  ["terms", termsPath],
  ["privacy", privacyPath],
]) {
  const body = readFileSync(file, "utf8");
  if (
    !body.trim() ||
    /REVIEW DRAFT|TO CONFIRM|TO COMPLETE|IMPLEMENTATION PENDING|PUBLICATION GATE|Proposed version|implementation plan|\bTODO\b|\bTBD\b|\]\((?:\.\.\/|drafts\/)/i.test(
      body,
    )
  ) {
    throw new Error(
      `${file}: finalize the text and publication metadata before preparing a rollout.`,
    );
  }
  const sha = createHash("sha256").update(body, "utf8").digest("hex");
  statements.push(
    `INSERT INTO legal_documents(kind,version,edition,sha256,body,published_at) VALUES(${quote(kind)},${quote(version)},${quote(kind === "terms" ? `terms-${version}` : "")},${quote(sha)},${quote(body)},${published});`,
  );
}
// A second rollout intentionally fails. Material updates need the separately
// designed notice/deadline workflow, not silently replacing this initial gate.
statements.push(
  `INSERT INTO legal_rollout(id,revision,terms_version,privacy_version) VALUES(1,${quote(randomUUID())},${quote(version)},${quote(version)});`,
);
statements.push("");
writeFileSync(output, statements.join("\n"), { flag: "wx" });
console.log(
  `Prepared initial portal-only rollout in ${output}. No database or deployment changed.`,
);
