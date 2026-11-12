import type { DashboardEnv } from "./types.js";

export interface LegalDocument {
  kind: "terms" | "privacy";
  version: string;
  edition: string;
  sha256: string;
  body: string;
  published_at: number;
}

export interface DeveloperStatus {
  enabled: boolean;
  eligible: boolean;
  revision: string | null;
  contactEmail: string | null;
  pendingEmail: string | null;
  verifiedAt: number | null;
  terms: LegalDocument | null;
  privacy: LegalDocument | null;
  acceptedAt: number | null;
  existingKeysContinue: true;
}

export async function accountClosed(db: D1Database, owner: string) {
  return Boolean(
    await db
      .prepare("SELECT 1 FROM account_closures WHERE owner_id=?")
      .bind(owner)
      .first(),
  );
}

export async function developerStatus(
  env: DashboardEnv,
  owner: string,
): Promise<DeveloperStatus> {
  const rollout = await env.DB.prepare(
    "SELECT revision,terms_version,privacy_version FROM legal_rollout WHERE id=1",
  ).first<{
    revision: string;
    terms_version: string;
    privacy_version: string;
  }>();
  const profile = await env.DB.prepare(
    "SELECT contact_email,pending_email,verified_at FROM developer_profiles WHERE owner_id=?",
  )
    .bind(owner)
    .first<{
      contact_email: string | null;
      pending_email: string | null;
      verified_at: number | null;
    }>();
  const base = {
    contactEmail: profile?.contact_email ?? null,
    pendingEmail: profile?.pending_email ?? null,
    verifiedAt: profile?.verified_at ?? null,
    existingKeysContinue: true as const,
  };
  if (!rollout)
    return {
      ...base,
      enabled: false,
      eligible: true,
      revision: null,
      terms: null,
      privacy: null,
      acceptedAt: null,
    };
  const terms = await env.DB.prepare(
    "SELECT * FROM legal_documents WHERE kind='terms' AND version=?",
  )
    .bind(rollout.terms_version)
    .first<LegalDocument>();
  const privacy = await env.DB.prepare(
    "SELECT * FROM legal_documents WHERE kind='privacy' AND version=?",
  )
    .bind(rollout.privacy_version)
    .first<LegalDocument>();
  if (!terms || !privacy) throw new Error("Invalid legal rollout");
  const acceptance = await env.DB.prepare(
    "SELECT accepted_at FROM legal_acceptances WHERE owner_id=? AND edition=? AND retain_until IS NULL ORDER BY accepted_at LIMIT 1",
  )
    .bind(owner, terms.edition)
    .first<{ accepted_at: number }>();
  return {
    ...base,
    enabled: true,
    eligible: Boolean(acceptance && base.verifiedAt),
    revision: rollout.revision,
    terms,
    privacy,
    acceptedAt: acceptance?.accepted_at ?? null,
  };
}

export function onboardingError(status: DeveloperStatus) {
  return {
    error: {
      code: status.acceptedAt
        ? "EMAIL_VERIFICATION_REQUIRED"
        : "AGREEMENT_REQUIRED",
      message:
        "Complete developer onboarding to use the dashboard. Existing API keys keep working.",
      reviewUrl: "https://devs.egdata.app/agreements",
      requirementRevision: status.revision,
      requiredDocuments:
        !status.acceptedAt && status.terms
          ? [
              {
                kind: "terms",
                version: status.terms.version,
                action: "accept",
                url: `https://devs.egdata.app/terms/${encodeURIComponent(status.terms.version)}`,
              },
            ]
          : [],
    },
  };
}
