import type {
  DashboardEnv,
  DashboardProject,
  EpicSessionUser,
} from "./types.js";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendLimitIncreaseRequestEmail(
  env: DashboardEnv,
  payload: {
    requestId: string;
    user: EpicSessionUser;
    project: DashboardProject;
    contactEmail: string;
    requestedTier: string;
    requestedRpm: number;
    expectedMonthlyRequests: number;
    useCase: string;
    websiteUrl: string;
  },
): Promise<{
  status: "sent" | "logged_local";
  messageId?: string;
  error?: string;
}> {
  const adminEmail = env.ADMIN_EMAIL || "admin@egdata.app";
  const fromEmail = env.EMAIL_FROM_ADDRESS || "noreply@egdata.app";
  const fromName = env.EMAIL_FROM_NAME || "egdata Developer Portal";

  const subject = `[egdata API] Rate Limit Increase Request — ${payload.project.name} (${payload.requestedTier.toUpperCase()})`;

  const text = [
    `New API Rate Limit Increase Request (${payload.requestId})`,
    `--------------------------------------------------`,
    `Epic Account: ${payload.user.displayName} (${payload.user.epicAccountId})`,
    `Contact Email: ${payload.contactEmail}`,
    `Project: ${payload.project.name} (${payload.project.id})`,
    `Website: ${payload.websiteUrl || "N/A"}`,
    `Current Tier: ${payload.project.tier}`,
    `Requested Tier: ${payload.requestedTier}`,
    `Requested RPM: ${payload.requestedRpm.toLocaleString()} req/min`,
    `Expected Monthly Volume: ${payload.expectedMonthlyRequests.toLocaleString()} req/month`,
    ``,
    `Use Case & Architecture Details:`,
    payload.useCase,
  ].join("\n");

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background:#101014; color:#f5f5f7; padding:32px; border-radius:12px;">
      <div style="max-width:600px; margin:0 auto; background:#18181c; border:1px solid #26262c; border-radius:12px; padding:28px;">
        <p style="margin:0 0 8px; color:#26bbff; font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em;">
          egdata Developer Portal
        </p>
        <h2 style="margin:0 0 20px; font-size:20px; color:#ffffff;">
          Rate Limit Increase Request
        </h2>
        <table style="width:100%; border-collapse:collapse; font-size:14px; margin-bottom:20px;">
          <tr>
            <td style="padding:8px 0; color:#9a9aa6; width:180px;">Request ID</td>
            <td style="padding:8px 0; color:#f5f5f7; font-family:monospace;">${escapeHtml(payload.requestId)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#9a9aa6;">Epic Account</td>
            <td style="padding:8px 0; color:#f5f5f7;">${escapeHtml(payload.user.displayName)} <span style="color:#9a9aa6;">(${escapeHtml(payload.user.epicAccountId)})</span></td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#9a9aa6;">Contact Email</td>
            <td style="padding:8px 0; color:#26bbff;">${escapeHtml(payload.contactEmail)}</td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#9a9aa6;">Project</td>
            <td style="padding:8px 0; color:#f5f5f7;">${escapeHtml(payload.project.name)} <span style="color:#9a9aa6;">(${escapeHtml(payload.project.id)})</span></td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#9a9aa6;">Website</td>
            <td style="padding:8px 0; color:#f5f5f7;">${escapeHtml(payload.websiteUrl || "Not provided")}</td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#9a9aa6;">Requested Tier</td>
            <td style="padding:8px 0; color:#26bbff; font-weight:600;">${escapeHtml(payload.requestedTier.toUpperCase())}</td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#9a9aa6;">Requested RPM</td>
            <td style="padding:8px 0; color:#f5f5f7;">${payload.requestedRpm.toLocaleString()} req / min</td>
          </tr>
          <tr>
            <td style="padding:8px 0; color:#9a9aa6;">Expected Monthly Volume</td>
            <td style="padding:8px 0; color:#f5f5f7;">${payload.expectedMonthlyRequests.toLocaleString()} req / month</td>
          </tr>
        </table>
        <div style="background:#101014; border:1px solid #26262c; border-radius:8px; padding:16px;">
          <p style="margin:0 0 8px; font-size:12px; color:#9a9aa6; text-transform:uppercase;">Use Case Description</p>
          <p style="margin:0; font-size:14px; line-height:1.5; white-space:pre-wrap; color:#f5f5f7;">${escapeHtml(payload.useCase)}</p>
        </div>
      </div>
    </div>
  `;

  try {
    if (!env.EMAIL || typeof env.EMAIL.send !== "function") {
      return { status: "logged_local" };
    }

    const result = await env.EMAIL.send({
      to: adminEmail,
      from: { email: fromEmail, name: fromName },
      replyTo: payload.contactEmail,
      subject,
      html,
      text,
    });

    return { status: "sent", messageId: result.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn("Cloudflare Email Sending warning (saved in D1):", message);
    return { status: "logged_local", error: message };
  }
}
