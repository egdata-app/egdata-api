import { Hono } from "hono";
import { opensearch } from "../clients/opensearch.js";
import { attributesToObject } from "../utils/attributes-to-object.js";
import { orderOffersObject } from "../utils/order-offers-object.js";

const app = new Hono();

app.get("/", (c) => {
  return c.json({ message: "Hello, World!" });
});

app.get("/offers", async (c) => {
  let { query } = c.req.query();

  if (query?.includes("store.epicgames.com")) {
    const isUrl = URL.canParse(query);
    if (isUrl) {
      const url = new URL(query);
      const slug = url.pathname.split("/").pop();
      query = slug || query;
    }
  }

  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [
    { bool: { must_not: { term: { "namespace.keyword": "ue" } } } },
  ];

  if (query) {
    must.push({
      bool: {
        should: [
          // Broad search with fuzzy matching
          {
            multi_match: {
              query,
              fields: [
                "title^4",
                "title.synonym^3",
                "developerDisplayName^2",
                "publisherDisplayName^2",
                "tags.name",
                "description",
              ],
              type: "best_fields",
              fuzziness: "AUTO",
              operator: "and",
            },
          },
          // Phrase boost for exact phrasing
          {
            match_phrase: {
              title: {
                query,
                boost: 10,
                slop: 2,
              },
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }

  const response = await opensearch.search({
    index: "egdata.offers",
    body: {
      query: { bool: { must, filter } },
      sort: [{ lastModifiedDate: { order: "desc" } }],
    },
  });

  const hits = response.body.hits.hits.map((hit) => {
    const source = hit._source || {};
    return {
      ...source,
      _id: hit._id,
    };
  });

  const total = response.body.hits.total;
  const estimatedTotalHits =
    typeof total === "number" ? total : total?.value ?? 0;

  return c.json({
    hits,
    estimatedTotalHits,
    processingTimeMs: response.body.took,
    query: query || "",
  });
});

app.get("/items", async (c) => {
  const { query, type: entitlementType } = c.req.query();

  const must: Array<Record<string, unknown>> = [];
  const filter: Array<Record<string, unknown>> = [
    { bool: { must_not: { term: { "namespace.keyword": "ue" } } } },
  ];

  if (query) {
    must.push({
      multi_match: {
        query,
        fields: ["title^2", "description", "id"],
      },
    });
  }

  if (entitlementType) {
    filter.push({ term: { "entitlementType.keyword": entitlementType } });
  }

  const response = await opensearch.search({
    index: "egdata.items",
    body: {
      query: { bool: { must, filter } },
      sort: [{ lastModifiedDate: { order: "desc" } }],
    },
  });

  const hits = response.body.hits.hits.map((hit) => {
    const source = hit._source || {};
    return {
      ...source,
      _id: hit._id,
      customAttributes: source.customAttributes
        ? attributesToObject(source.customAttributes as never)
        : {},
    };
  });

  const total = response.body.hits.total;
  const estimatedTotalHits =
    typeof total === "number" ? total : total?.value ?? 0;

  return c.json({
    hits,
    estimatedTotalHits,
    processingTimeMs: response.body.took,
    query: query || "",
  });
});

app.get("/sellers", async (c) => {
  const { query } = c.req.query();

  const must: Array<Record<string, unknown>> = [];

  if (query) {
    must.push({
      multi_match: {
        query,
        fields: ["name^2", "id"],
      },
    });
  }

  const response = await opensearch.search({
    index: "egdata.sellers",
    body: {
      query: must.length > 0 ? { bool: { must } } : { match_all: {} },
      sort: [{ updatedAt: { order: "desc" } }],
    },
  });

  const hits = response.body.hits.hits.map((hit) => {
    const source = hit._source || {};
    return {
      ...source,
      _id: hit._id,
    };
  });

  const total = response.body.hits.total;
  const estimatedTotalHits =
    typeof total === "number" ? total : total?.value ?? 0;

  return c.json({
    hits,
    estimatedTotalHits,
    processingTimeMs: response.body.took,
    query: query || "",
  });
});

export default app;
