import {
  type DashboardSeoMetadata,
  HOMEPAGE_DESCRIPTION,
  HOMEPAGE_OG_ALT,
  HOMEPAGE_TITLE,
  isCrawlableDashboardPath,
  resolveDashboardSeo,
} from "../src/lib/seo.js";

export {
  type DashboardSeoMetadata,
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
Allow: /og-image.png
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

  if (seo.includeOg && seo.ogUrl && seo.ogImageUrl) {
    lines.push(
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="egdata Developer Portal" />`,
      `<meta property="og:title" content="${escapeHtml(seo.title)}" />`,
      `<meta property="og:description" content="${escapeHtml(seo.description)}" />`,
      `<meta property="og:url" content="${escapeHtml(seo.ogUrl)}" />`,
      `<meta property="og:image" content="${escapeHtml(seo.ogImageUrl)}" />`,
      `<meta property="og:image:type" content="image/png" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${escapeHtml(HOMEPAGE_OG_ALT)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${escapeHtml(seo.title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(seo.description)}" />`,
      `<meta name="twitter:image" content="${escapeHtml(seo.ogImageUrl)}" />`,
      `<meta name="twitter:image:alt" content="${escapeHtml(HOMEPAGE_OG_ALT)}" />`,
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
  const headMatch = /<head\b[^>]*>[\s\S]*?<\/head>/i.exec(html);
  if (!headMatch) return html;

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
