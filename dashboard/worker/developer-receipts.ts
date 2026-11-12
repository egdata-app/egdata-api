import type { LegalDocument } from "./developer-status.js";

export interface DeveloperReceipt {
  receipt_id: string;
  account_id: string;
  accepted_at: number;
  accepted_at_iso: string;
  requirement_revision: string;
  // Preserve the original JSON download fields.
  version: string;
  sha256: string;
  body: string;
  terms: LegalDocument;
  privacy: LegalDocument | null;
  privacy_recorded_at: number | null;
  privacy_status: "provided" | "not_recorded";
}

interface ReceiptRow {
  receipt_id: string;
  owner_id: string;
  version: string;
  edition: string;
  sha256: string;
  accepted_at: number;
  requirement_revision: string;
  body: string;
  published_at: number;
  privacy_version: string | null;
  privacy_sha256: string | null;
  privacy_body: string | null;
  privacy_edition: string | null;
  privacy_published_at: number | null;
}

const receiptQuery = `SELECT a.receipt_id,a.owner_id,a.version,a.edition,a.sha256,a.accepted_at,a.requirement_revision,
  t.body,t.published_at,a.privacy_version,a.privacy_sha256,p.body AS privacy_body,
  p.edition AS privacy_edition,p.published_at AS privacy_published_at
  FROM legal_acceptances a
  JOIN legal_documents t ON t.kind='terms' AND t.version=a.version AND t.sha256=a.sha256
  LEFT JOIN legal_documents p ON p.kind='privacy' AND p.version=a.privacy_version AND p.sha256=a.privacy_sha256`;

function receiptFromRow(row: ReceiptRow): DeveloperReceipt {
  const privacy =
    row.privacy_version &&
    row.privacy_sha256 &&
    row.privacy_body !== null &&
    row.privacy_published_at !== null
      ? {
          kind: "privacy" as const,
          version: row.privacy_version,
          edition: row.privacy_edition ?? "",
          sha256: row.privacy_sha256,
          body: row.privacy_body,
          published_at: row.privacy_published_at,
        }
      : null;
  return {
    receipt_id: row.receipt_id,
    account_id: row.owner_id,
    accepted_at: row.accepted_at,
    accepted_at_iso: new Date(row.accepted_at).toISOString(),
    requirement_revision: row.requirement_revision,
    version: row.version,
    sha256: row.sha256,
    body: row.body,
    terms: {
      kind: "terms",
      version: row.version,
      edition: row.edition,
      sha256: row.sha256,
      body: row.body,
      published_at: row.published_at,
    },
    privacy,
    privacy_recorded_at: privacy ? row.accepted_at : null,
    privacy_status: privacy ? "provided" : "not_recorded",
  };
}

export async function listDeveloperReceipts(db: D1Database, owner: string) {
  const { results } = await db
    .prepare(
      `${receiptQuery} WHERE a.owner_id=? AND a.retain_until IS NULL ORDER BY a.accepted_at DESC,a.receipt_id`,
    )
    .bind(owner)
    .all<ReceiptRow>();
  return results.map(receiptFromRow);
}

/** Internal outbox lookup; never exposed as an unauthenticated receipt endpoint. */
export async function receiptForMail(db: D1Database, id: string) {
  const row = await db
    .prepare(`${receiptQuery} WHERE a.receipt_id=?`)
    .bind(id)
    .first<ReceiptRow>();
  if (!row) throw new Error("Receipt evidence unavailable");
  return receiptFromRow(row);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function receiptEmail(receipt: DeveloperReceipt, origin: string) {
  const url = new URL(
    `/profile/receipts?receipt=${encodeURIComponent(receipt.receipt_id)}`,
    origin,
  ).href;
  const privacyLine = receipt.privacy
    ? `Privacy Notice v${receipt.privacy.version} provided alongside the terms. This is not privacy or marketing consent.`
    : "The privacy notice version was not recorded for this historical acceptance.";
  const summary = `egdata developer agreement receipt\n\nReceipt: ${receipt.receipt_id}\nEpic account: ${receipt.account_id}\nAccepted at (UTC): ${receipt.accepted_at_iso}\nDeveloper Terms v${receipt.version}: accepted\n${privacyLine}\n\nView, print or save your receipt as PDF (sign-in required):\n${url}`;
  const documents = [
    receipt.terms,
    ...(receipt.privacy ? [receipt.privacy] : []),
  ];
  const text =
    summary +
    documents
      .map(
        (d) =>
          `\n\n--- ${d.kind === "terms" ? "Accepted Developer Terms" : "Privacy Notice provided"} v${d.version} ---\nSHA-256: ${d.sha256}\n\n${d.body}`,
      )
      .join("");
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f4f5f7;color:#18181c;font-family:Arial,sans-serif;line-height:1.6"><main style="max-width:600px;margin:32px auto;background:white;border:1px solid #ddd;border-radius:12px;padding:32px"><p style="font-weight:bold;color:#0879aa">egdata Developers</p><h1 style="font-size:24px;line-height:1.3">Your agreement receipt</h1><p>Your acceptance has been recorded. Keep this email for your records.</p><p><strong>Developer Terms v${escapeHtml(receipt.version)}</strong><br>Accepted ${escapeHtml(receipt.accepted_at_iso)} (UTC)</p><p>${escapeHtml(privacyLine)}</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#0879aa;color:white;border-radius:6px;text-decoration:none">View your receipt</a></p><p style="font-size:13px;color:#555">Sign in to view both documents, print your receipt, or save it as PDF.</p><hr style="border:0;border-top:1px solid #ddd"><p style="font-size:12px;overflow-wrap:anywhere">Receipt: ${escapeHtml(receipt.receipt_id)}<br>Epic account: ${escapeHtml(receipt.account_id)}</p>${documents.map((d) => `<p style="font-size:12px;overflow-wrap:anywhere"><strong>${d.kind === "terms" ? "Terms" : "Privacy Notice"} v${escapeHtml(d.version)} · SHA-256</strong><br>${escapeHtml(d.sha256)}</p>`).join("")}<p style="font-size:12px">Questions? <a href="mailto:contact@egdata.app">contact@egdata.app</a></p></main></body></html>`;
  return { text, html };
}
