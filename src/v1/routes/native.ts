import { Hono } from "hono";
import { z } from "zod";
import { db } from "../../db/index.js";
import { Item, Offer, TagModel } from "../../models/index.js";
import {
  getOfferSitemapEntries,
  OFFER_SITEMAP_PAGE_LIMIT,
} from "../../utils/offer-sitemap.js";
import { parseInteger, parseStrictQuery } from "../query.js";
import type { V1Variables } from "../request-context.js";
import { nativeResponse } from "../response.js";

const app = new Hono<{ Variables: V1Variables }>();

const XML_CACHE = "private, max-age=3600, stale-while-revalidate=604800";
const PAGE_SIZE = 1_000;

const v1Base = () =>
  (
    process.env.V1_PUBLIC_BASE_URL?.trim() || "https://api.egdata.app/v1"
  ).replace(/\/+$/, "");

const xml = (c: Parameters<typeof nativeResponse>[0], body: string) =>
  nativeResponse(c, body, {
    contentType: "application/xml; charset=utf-8",
    cacheControl: XML_CACHE,
  });

function sitemapIndex(urls: string[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((url) => `  <sitemap><loc>${url}</loc></sitemap>`).join("\n")}
</sitemapindex>`;
}

app.get("/robots.txt", (c) => {
  parseStrictQuery(c, {});
  const robots = `User-agent: *
Disallow: /
Allow: /v1/sitemap.xml
Allow: /v1/sitemap.xml?*
Allow: /v1/items-sitemap.xml
Allow: /v1/items-sitemap.xml?*
Allow: /v1/promotions-sitemap.xml
Allow: /v1/profiles/sitemap.xml
Allow: /v1/sandboxes/sitemap.xml
Allow: /v1/sandboxes/sitemap.xml?*
Allow: /v1/items/sitemap.xml
Allow: /v1/items/sitemap.xml?*
Allow: /v1/offers/*/og
Allow: /v1/sandboxes/*/og
`;
  return nativeResponse(c, robots, {
    contentType: "text/plain; charset=utf-8",
    cacheControl: XML_CACHE,
  });
});

app.get("/sitemap.xml", async (c) => {
  const query = parseStrictQuery(c, { page: z.string().optional() });
  const page = parseInteger(query.page, "page", { min: 1 });
  if (!page) {
    const count = await Offer.countDocuments();
    const pages = Math.ceil(count / OFFER_SITEMAP_PAGE_LIMIT);
    return xml(
      c,
      sitemapIndex(
        Array.from(
          { length: pages },
          (_, index) => `${v1Base()}/sitemap.xml?page=${index + 1}`,
        ),
      ),
    );
  }

  const offers = await Offer.find(
    {},
    { id: 1, lastModifiedDate: 1 },
    {
      limit: OFFER_SITEMAP_PAGE_LIMIT,
      skip: (page - 1) * OFFER_SITEMAP_PAGE_LIMIT,
      sort: { lastModifiedDate: -1 },
    },
  ).lean();

  const urls = offers.flatMap((offer) =>
    getOfferSitemapEntries(String(offer.id)).map((entry) => {
      const lastmod = offer.lastModifiedDate
        ? new Date(offer.lastModifiedDate).toISOString()
        : null;
      return `  <url>
    <loc>${entry.loc}</loc>
${entry.alternates
  .map(
    (alternate) =>
      `    <xhtml:link rel="alternate" hreflang="${alternate.hreflang}" href="${alternate.href}" />`,
  )
  .join("\n")}
${lastmod ? `    <lastmod>${lastmod}</lastmod>` : ""}
  </url>`;
    }),
  );

  return xml(
    c,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>`,
  );
});

async function itemSitemap(
  c: Parameters<typeof nativeResponse>[0],
  base: string,
) {
  const query = parseStrictQuery(c, { page: z.string().optional() });
  const page = parseInteger(query.page, "page", { min: 1 });
  if (!page) {
    const count = await Item.countDocuments();
    const pages = Math.ceil(count / PAGE_SIZE);
    return xml(
      c,
      sitemapIndex(
        Array.from(
          { length: pages },
          (_, index) => `${base}?page=${index + 1}`,
        ),
      ),
    );
  }

  const items = await Item.find(
    {},
    { id: 1, lastModifiedDate: 1 },
    {
      limit: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      sort: { lastModifiedDate: -1 },
    },
  ).lean();

  const urls = items.map((item) => {
    const lastmod = item.lastModifiedDate
      ? new Date(item.lastModifiedDate).toISOString()
      : null;
    return `  <url>
    <loc>https://egdata.app/items/${item.id}</loc>
${lastmod ? `    <lastmod>${lastmod}</lastmod>` : ""}
  </url>`;
  });

  return xml(
    c,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`,
  );
}

app.get("/items-sitemap.xml", (c) =>
  itemSitemap(c, `${v1Base()}/items-sitemap.xml`),
);
app.get("/items/sitemap.xml", (c) =>
  itemSitemap(c, `${v1Base()}/items/sitemap.xml`),
);

app.get("/promotions-sitemap.xml", async (c) => {
  parseStrictQuery(c, {});
  const tags = await TagModel.find({
    groupName: "event",
    referenceCount: { $gt: 0 },
  }).lean();
  const urls = tags.map(
    (tag) => `  <url><loc>https://egdata.app/promotions/${tag.id}</loc></url>`,
  );
  return xml(
    c,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`,
  );
});

app.get("/profiles/sitemap.xml", async (c) => {
  parseStrictQuery(c, {});
  const profiles = await db.db
    .collection<{ accountId?: string }>("epic")
    .find({})
    .toArray();
  const urls = profiles
    .filter((profile) => profile.accountId)
    .map(
      (profile) =>
        `  <url><loc>https://egdata.app/profile/${profile.accountId}</loc></url>`,
    );
  return xml(
    c,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`,
  );
});

app.get("/sandboxes/sitemap.xml", async (c) => {
  const query = parseStrictQuery(c, { page: z.string().optional() });
  const page = parseInteger(query.page, "page", { min: 1 });
  const collection = db.db.collection<Record<string, any>>("sandboxes");
  if (!page) {
    const count = await collection.countDocuments();
    const pages = Math.ceil(count / PAGE_SIZE);
    return xml(
      c,
      sitemapIndex(
        Array.from(
          { length: pages },
          (_, index) => `${v1Base()}/sandboxes/sitemap.xml?page=${index + 1}`,
        ),
      ),
    );
  }
  const sandboxes = await collection
    .find(
      {},
      {
        limit: PAGE_SIZE,
        skip: (page - 1) * PAGE_SIZE,
        sort: { lastModified: -1 },
      },
    )
    .toArray();
  const sections = ["/items", "/offers", "/assets", "/achievements"];
  const urls = sandboxes.flatMap((sandbox) => {
    const url = `https://egdata.app/sandboxes/${sandbox._id}`;
    const lastmod = sandbox.updated
      ? new Date(sandbox.updated).toISOString()
      : null;
    return [url, ...sections.map((section) => `${url}${section}`)].map(
      (location) =>
        `  <url><loc>${location}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`,
    );
  });
  return xml(
    c,
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`,
  );
});

export default app;
