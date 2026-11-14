import {
  type DashboardSeoMetadata,
  getDashboardSocialMetaTags,
  HOMEPAGE_DESCRIPTION,
  HOMEPAGE_OG_ALT,
  HOMEPAGE_TITLE,
  isCrawlableDashboardPath,
  resolveDashboardSeo,
} from "../src/lib/seo.js";

export {
  type DashboardSeoMetadata,
  getDashboardSocialMetaTags,
  HOMEPAGE_DESCRIPTION,
  HOMEPAGE_OG_ALT,
  HOMEPAGE_TITLE,
  isCrawlableDashboardPath,
  resolveDashboardSeo,
};

export const ROBOTS_TXT = `User-agent: *
Disallow: /
Allow: /$
Allow: /docs$
Allow: /docs/
Allow: /problems$
Allow: /problems/
Allow: /assets/
Allow: /og-image.png$
Allow: /_dashboard/api/auth/session$
Allow: /_dashboard/reference/history$
Allow: /proxy/v1/open-api.json$
`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderSeoHeadTags(seo: DashboardSeoMetadata): string {
  const lines = [
    `<title>${escapeHtml(seo.title)}</title>`,
    `<meta name="description" content="${escapeHtml(seo.description)}" />`,
    `<meta name="robots" content="${seo.robots}" />`,
  ];

  if (seo.canonicalUrl) {
    lines.push(
      `<link rel="canonical" href="${escapeHtml(seo.canonicalUrl)}" />`,
    );
  }

  for (const tag of getDashboardSocialMetaTags(seo)) {
    if (!tag.content) continue;
    lines.push(
      `<meta ${tag.attribute}="${tag.key}" content="${escapeHtml(tag.content)}" />`,
    );
  }

  return lines.map((line) => `    ${line}`).join("\n");
}

function stripManagedSeoTags(headHtml: string): string {
  return headHtml
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/gi, "")
    .replace(
      /<meta\b[^>]*\b(?:name|property)=["'](?:description|robots|og:[^"']+|twitter:[^"']+)["'][^>]*>\s*/gi,
      "",
    )
    .replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>\s*/gi, "");
}

export function applyDashboardSeoHtml(
  html: string,
  pathname: string,
  origin: string,
): string {
  const headMatch = html.match(/<head\b[^>]*>[\s\S]*?<\/head>/i);
  if (!headMatch || headMatch.index === undefined) return html;

  const seo = resolveDashboardSeo(pathname, origin);
  const originalHead = headMatch[0];
  const closingIndex = originalHead.toLowerCase().lastIndexOf("</head>");
  if (closingIndex === -1) return html;

  const innerWithoutClosing = stripManagedSeoTags(
    originalHead.slice(0, closingIndex),
  );
  const injectedTags = renderSeoHeadTags(seo);
  const updatedHead = `${innerWithoutClosing.replace(/\s*$/, "")}\n${injectedTags}\n  </head>`;

  return (
    html.slice(0, headMatch.index) +
    updatedHead +
    html.slice(headMatch.index + originalHead.length)
  );
}
