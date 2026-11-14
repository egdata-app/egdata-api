import { findDoc } from "./docs/entries";

export const HOMEPAGE_TITLE =
  "egdata Developer Portal — Epic Games Store API & Keys";
export const HOMEPAGE_DESCRIPTION =
  "Build with Epic Games Store data. Create API keys, configure endpoint permissions, inspect usage analytics, and explore the v1 API reference.";
export const HOMEPAGE_OG_ALT =
  "egdata Developer Portal — Build with Epic Games Store data, API keys, permissions, and usage analytics.";

export type DashboardSeoMetadata = {
  title: string;
  description: string;
  canonicalUrl: string | null;
  robots: "index, follow" | "noindex, nofollow";
  includeOg: boolean;
  ogImageUrl: string | null;
  ogUrl: string | null;
};

export type SocialMetaTag = {
  attribute: "property" | "name";
  key: string;
  content: string | null;
};

export function getDashboardSocialMetaTags(
  seo: DashboardSeoMetadata,
): SocialMetaTag[] {
  const active = Boolean(seo.includeOg && seo.ogUrl && seo.ogImageUrl);
  return [
    {
      attribute: "property",
      key: "og:type",
      content: active ? "website" : null,
    },
    {
      attribute: "property",
      key: "og:site_name",
      content: active ? "egdata Developer Portal" : null,
    },
    {
      attribute: "property",
      key: "og:title",
      content: active ? seo.title : null,
    },
    {
      attribute: "property",
      key: "og:description",
      content: active ? seo.description : null,
    },
    {
      attribute: "property",
      key: "og:url",
      content: active ? seo.ogUrl : null,
    },
    {
      attribute: "property",
      key: "og:image",
      content: active ? seo.ogImageUrl : null,
    },
    {
      attribute: "property",
      key: "og:image:type",
      content: active ? "image/png" : null,
    },
    {
      attribute: "property",
      key: "og:image:width",
      content: active ? "1200" : null,
    },
    {
      attribute: "property",
      key: "og:image:height",
      content: active ? "630" : null,
    },
    {
      attribute: "property",
      key: "og:image:alt",
      content: active ? HOMEPAGE_OG_ALT : null,
    },
    {
      attribute: "name",
      key: "twitter:card",
      content: active ? "summary_large_image" : null,
    },
    {
      attribute: "name",
      key: "twitter:title",
      content: active ? seo.title : null,
    },
    {
      attribute: "name",
      key: "twitter:description",
      content: active ? seo.description : null,
    },
    {
      attribute: "name",
      key: "twitter:image",
      content: active ? seo.ogImageUrl : null,
    },
    {
      attribute: "name",
      key: "twitter:image:alt",
      content: active ? HOMEPAGE_OG_ALT : null,
    },
  ];
}

export function isCrawlableDashboardPath(pathname: string): boolean {
  return (
    pathname === "/" ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/") ||
    pathname === "/problems" ||
    pathname.startsWith("/problems/")
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveDashboardSeo(
  pathname: string,
  origin: string,
): DashboardSeoMetadata {
  const cleanOrigin = origin.replace(/\/+$/, "");

  if (pathname === "/") {
    const homeUrl = `${cleanOrigin}/`;
    return {
      title: HOMEPAGE_TITLE,
      description: HOMEPAGE_DESCRIPTION,
      canonicalUrl: homeUrl,
      robots: "index, follow",
      includeOg: true,
      ogImageUrl: `${cleanOrigin}/og-image.png`,
      ogUrl: homeUrl,
    };
  }

  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    const normalizedPath = pathname.replace(/\/+$/, "") || "/docs";
    const rawSlug = normalizedPath.startsWith("/docs/")
      ? normalizedPath.slice("/docs/".length)
      : "";
    const slug = rawSlug ? safeDecode(rawSlug) : "";
    const entry = slug ? findDoc(slug) : undefined;

    let title = "API Reference — egdata Developer Portal";
    let description =
      "Browse deployed egdata v1 REST API operations, guides, problem codes, and change history.";

    if (entry) {
      title = `${entry.title} — egdata API Docs`;
      description = entry.description;
    } else if (slug) {
      title = `${slug} — API Reference | egdata Developer Portal`;
      description = `Inspect parameters, schemas, examples, and change history for ${slug} in the egdata v1 API.`;
    }

    return {
      title,
      description,
      canonicalUrl: new URL(normalizedPath, cleanOrigin).toString(),
      robots: "index, follow",
      includeOg: false,
      ogImageUrl: null,
      ogUrl: null,
    };
  }

  if (pathname === "/problems" || pathname.startsWith("/problems/")) {
    const normalizedPath = pathname.replace(/\/+$/, "") || "/problems";
    const rawSlug = normalizedPath.startsWith("/problems/")
      ? normalizedPath.slice("/problems/".length)
      : "";
    const slug = rawSlug ? safeDecode(rawSlug) : "";
    const entry = findDoc(slug || "problems");

    if (slug && !entry) {
      return {
        title: "Problem Not Found — egdata API Problems",
        description:
          "Stable v1 problem codes, HTTP statuses, and client recovery steps for the egdata API.",
        canonicalUrl: null,
        robots: "noindex, nofollow",
        includeOg: false,
        ogImageUrl: null,
        ogUrl: null,
      };
    }

    return {
      title: entry
        ? `${entry.title} — egdata API Problems`
        : "Problem Details Reference — egdata Developer Portal",
      description:
        entry?.description ??
        "Stable v1 problem codes, HTTP statuses, and client recovery steps for the egdata API.",
      canonicalUrl: new URL(normalizedPath, cleanOrigin).toString(),
      robots: "index, follow",
      includeOg: false,
      ogImageUrl: null,
      ogUrl: null,
    };
  }

  return {
    title: "egdata Developer Portal — API Keys & Usage",
    description:
      "Create API keys, manage access to Epic Games Store data, track usage, and request higher limits.",
    canonicalUrl: null,
    robots: "noindex, nofollow",
    includeOg: false,
    ogImageUrl: null,
    ogUrl: null,
  };
}
