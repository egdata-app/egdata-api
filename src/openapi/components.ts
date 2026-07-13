import type { OpenAPIV3 } from "openapi-types";

const stringDate: OpenAPIV3.SchemaObject = {
  type: "string",
  format: "date-time",
};

const flexibleObject = (
  description: string,
  properties: Record<
    string,
    OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject
  >,
): OpenAPIV3.SchemaObject => ({
  type: "object",
  description,
  additionalProperties: true,
  properties,
});

const changelogValue: OpenAPIV3.SchemaObject = {
  description:
    "Parsed changelog value. May be an object, array, boolean, number, string, or null.",
  nullable: true,
};

export const commonParameters = {
  country: {
    name: "country",
    in: "query",
    required: false,
    description:
      "ISO country code used to resolve an Epic Games Store pricing region. Defaults to the EGDATA_COUNTRY cookie, then US.",
    schema: {
      type: "string",
      minLength: 2,
      maxLength: 2,
      example: "US",
    },
  },
  locale: {
    name: "locale",
    in: "query",
    required: false,
    description:
      "Exact BCP-47-style locale used to overlay localized public offer text fields. Defaults to en-US.",
    schema: {
      type: "string",
      example: "es-ES",
    },
  },
  limit: {
    name: "limit",
    in: "query",
    required: false,
    description:
      "Maximum number of records to return. Most list endpoints cap this server-side.",
    schema: {
      type: "integer",
      minimum: 1,
      example: 10,
    },
  },
  page: {
    name: "page",
    in: "query",
    required: false,
    description: "One-based page number.",
    schema: {
      type: "integer",
      minimum: 1,
      default: 1,
    },
  },
  offerId: {
    name: "id",
    in: "path",
    required: true,
    description: "Epic offer identifier.",
    schema: {
      type: "string",
      example: "09176f4ff7564bbbb499bbe20bd6348f",
    },
  },
  itemId: {
    name: "id",
    in: "path",
    required: true,
    description: "Epic item identifier.",
    schema: {
      type: "string",
    },
  },
  sandboxId: {
    name: "sandboxId",
    in: "path",
    required: true,
    description: "Epic namespace or sandbox identifier.",
    schema: {
      type: "string",
      example: "fn",
    },
  },
  collection: {
    name: "collection",
    in: "path",
    required: true,
    description: "egdata collection identifier.",
    schema: {
      type: "string",
    },
  },
  sellerId: {
    name: "id",
    in: "path",
    required: true,
    description: "Seller identifier.",
    schema: {
      type: "string",
    },
  },
  region: {
    name: "region",
    in: "query",
    required: false,
    description:
      "Epic pricing region code. When present it takes precedence over country on routes that support both.",
    schema: {
      type: "string",
      example: "US",
    },
  },
  since: {
    name: "since",
    in: "query",
    required: false,
    description: "Only return records at or after this timestamp.",
    schema: {
      ...stringDate,
    },
  },
  verified: {
    name: "verified",
    in: "query",
    required: false,
    description: "Filter reviews by verified ownership status.",
    schema: {
      type: "string",
      enum: ["true", "false"],
    },
  },
  entitlementType: {
    name: "entitlementType",
    in: "query",
    required: false,
    description:
      "Comma-separated entitlement types for sandbox item filtering.",
    schema: {
      type: "string",
      example: "EXECUTABLE,DLC",
    },
  },
  status: {
    name: "status",
    in: "query",
    required: false,
    description: "Comma-separated item statuses for sandbox item filtering.",
    schema: {
      type: "string",
      example: "ACTIVE",
    },
  },
  platforms: {
    name: "platforms",
    in: "query",
    required: false,
    description: "Comma-separated platforms for sandbox item filtering.",
    schema: {
      type: "string",
      example: "Windows,Mac",
    },
  },
  platform: {
    name: "platform",
    in: "query",
    required: false,
    description:
      "Comma-separated platforms for sandbox asset or build filtering.",
    schema: {
      type: "string",
      example: "Windows",
    },
  },
  title: {
    name: "title",
    in: "query",
    required: false,
    description: "Case-insensitive title filter.",
    schema: {
      type: "string",
      example: "Fortnite",
    },
  },
  sandboxOfferType: {
    name: "offerType",
    in: "query",
    required: false,
    description: "Comma-separated offer types for sandbox offer filtering.",
    schema: {
      type: "string",
      example: "BASE_GAME,DLC",
    },
  },
} satisfies Record<string, OpenAPIV3.ParameterObject>;

export const components: OpenAPIV3.ComponentsObject = {
  securitySchemes: {
    EpicSession: {
      type: "apiKey",
      in: "cookie",
      name: "session",
      description: "egdata.app browser session backed by Epic authentication.",
    },
    ApiKey: {
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
      description: "Endpoint-specific API key.",
    },
  },
  parameters: commonParameters,
  schemas: {
    ErrorResponse: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: {
          type: "string",
        },
        error: {
          oneOf: [
            { type: "string" },
            {
              type: "object",
              additionalProperties: true,
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
          ],
        },
      },
    },
    HealthResponse: {
      type: "object",
      additionalProperties: false,
      required: ["status", "services"],
      properties: {
        status: {
          type: "string",
          enum: ["ok", "error"],
        },
        services: {
          type: "object",
          additionalProperties: false,
          properties: {
            redis: { $ref: "#/components/schemas/ServiceHealth" },
            mongodb: { $ref: "#/components/schemas/ServiceHealth" },
          },
        },
      },
    },
    ServiceHealth: {
      type: "object",
      additionalProperties: false,
      required: ["status", "latency"],
      properties: {
        status: {
          type: "string",
          enum: ["ok", "error"],
        },
        latency: {
          type: "number",
          nullable: true,
        },
      },
    },
    Region: flexibleObject("Epic Games Store region metadata.", {
      code: {
        type: "string",
        example: "US",
      },
      currency: {
        type: "string",
        example: "USD",
      },
      countries: {
        type: "array",
        items: { type: "string" },
      },
    }),
    RegionLookupResponse: {
      type: "object",
      additionalProperties: false,
      required: ["region"],
      properties: {
        region: { $ref: "#/components/schemas/Region" },
      },
    },
    CountryMap: {
      type: "object",
      description:
        "Map of ISO country codes to display names and region metadata.",
      additionalProperties: true,
    },
    Offer: flexibleObject("Public Epic Games Store offer DTO.", {
      id: { type: "string" },
      namespace: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      description: { type: "string", nullable: true },
      longDescription: { type: "string", nullable: true },
      offerType: { type: "string", nullable: true },
      developerDisplayName: { type: "string", nullable: true },
      publisherDisplayName: { type: "string", nullable: true },
      seller: { $ref: "#/components/schemas/SellerSummary" },
      tags: {
        type: "array",
        nullable: true,
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
      offerMappings: {
        type: "array",
        nullable: true,
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
      productSlug: { type: "string", nullable: true },
      urlSlug: { type: "string", nullable: true },
      url: { type: "string", nullable: true },
      keyImages: {
        type: "array",
        items: { $ref: "#/components/schemas/Image" },
      },
      price: {
        allOf: [{ $ref: "#/components/schemas/Price" }],
        nullable: true,
      },
      releaseDate: {
        ...stringDate,
        nullable: true,
      },
      lastModifiedDate: {
        ...stringDate,
        nullable: true,
      },
      locale: {
        type: "string",
        description: "Requested locale applied to this offer response.",
        example: "es-ES",
      },
      localeStatus: {
        type: "string",
        description:
          "Whether this offer is canonical en-US data, localized with an exact locale record, or fell back to canonical text.",
        enum: ["canonical", "localized", "fallback"],
      },
      canonicalLocale: {
        type: "string",
        nullable: true,
        description:
          "Canonical source locale, present on non-canonical responses.",
        example: "en-US",
      },
      localization: {
        allOf: [{ $ref: "#/components/schemas/OfferLocalizationMetadata" }],
        nullable: true,
      },
    }),
    OfferLocalizationMetadata: {
      type: "object",
      description:
        "Metadata from the exact offer localization record used for this response.",
      additionalProperties: true,
      properties: {
        source: { type: "string", nullable: true },
        fetchedAt: {
          ...stringDate,
          nullable: true,
        },
        sourceUpdatedAt: {
          ...stringDate,
          nullable: true,
        },
      },
    },
    Giveaway: flexibleObject("Free-game promotion metadata.", {
      id: { type: "string", nullable: true },
      offerId: { type: "string" },
      platform: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      namespace: { type: "string", nullable: true },
      startDate: stringDate,
      endDate: stringDate,
      historical: {
        type: "array",
        nullable: true,
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    }),
    FreeGameOffer: {
      allOf: [
        { $ref: "#/components/schemas/Offer" },
        {
          type: "object",
          additionalProperties: true,
          required: ["countriesBlacklist", "giveaway"],
          properties: {
            countriesBlacklist: {
              type: "array",
              items: { type: "string" },
            },
            giveaway: { $ref: "#/components/schemas/Giveaway" },
            price: {
              allOf: [{ $ref: "#/components/schemas/Price" }],
              nullable: true,
            },
          },
        },
      ],
    },
    OfferListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["elements", "page", "limit", "total"],
      properties: {
        elements: {
          type: "array",
          items: { $ref: "#/components/schemas/Offer" },
        },
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    SearchResponse: {
      type: "object",
      additionalProperties: false,
      required: ["total", "offers", "page", "limit", "meta"],
      properties: {
        total: { type: "integer" },
        offers: {
          type: "array",
          items: { $ref: "#/components/schemas/Offer" },
        },
        page: { type: "integer" },
        limit: { type: "integer" },
        aggregations: {
          type: "object",
          additionalProperties: true,
        },
        meta: {
          type: "object",
          additionalProperties: true,
          properties: {
            ms: { type: "number" },
            timed_out: { type: "boolean" },
            cached: { type: "boolean" },
          },
        },
      },
    },
    NaturalLanguageSearchBody: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 500,
          description: "Natural-language description of the desired offers.",
          example: "open world co-op survival games",
        },
        topK: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          default: 10,
          description: "Maximum number of Vectorize neighbors to hydrate.",
        },
      },
    },
    NaturalLanguageSearchMatch: {
      type: "object",
      additionalProperties: false,
      required: ["score", "offer"],
      properties: {
        score: {
          type: "number",
          description: "Similarity score returned by Cloudflare Vectorize.",
        },
        offer: { $ref: "#/components/schemas/Offer" },
      },
    },
    NaturalLanguageSearchResponse: {
      type: "object",
      additionalProperties: false,
      required: ["query", "count", "matches"],
      properties: {
        query: { type: "string" },
        count: {
          type: "integer",
          description:
            "Number of Vectorize matches that still resolve to Mongo offer documents.",
        },
        matches: {
          type: "array",
          items: {
            $ref: "#/components/schemas/NaturalLanguageSearchMatch",
          },
        },
      },
    },
    SearchBody: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        offerType: { type: "string" },
        tags: {
          type: "array",
          items: { type: "string" },
        },
        customAttributes: {
          type: "array",
          items: { type: "string" },
        },
        categories: {
          type: "array",
          items: { type: "string" },
        },
        seller: { type: "string" },
        sortBy: {
          type: "string",
          enum: [
            "releaseDate",
            "lastModifiedDate",
            "effectiveDate",
            "creationDate",
            "viewableDate",
            "pcReleaseDate",
            "upcoming",
            "priceAsc",
            "priceDesc",
            "price",
            "discount",
            "discountPercent",
            "giveawayDate",
          ],
        },
        sortDir: {
          type: "string",
          enum: ["asc", "desc"],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
        },
        page: {
          type: "integer",
          minimum: 1,
        },
        refundType: { type: "string" },
        isCodeRedemptionOnly: { type: "boolean" },
        price: {
          type: "object",
          additionalProperties: false,
          properties: {
            min: { type: "number" },
            max: { type: "number" },
          },
        },
        onSale: { type: "boolean" },
        developerDisplayName: { type: "string" },
        publisherDisplayName: { type: "string" },
        spt: { type: "boolean" },
        excludeBlockchain: { type: "boolean" },
        pastGiveaways: { type: "boolean" },
        isLowestPrice: { type: "boolean" },
        isLowestPriceEver: { type: "boolean" },
      },
    },
    Item: flexibleObject("Public Epic Games Store item DTO.", {
      id: { type: "string" },
      namespace: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      keyImages: {
        type: "array",
        items: { $ref: "#/components/schemas/Image" },
      },
      releaseInfo: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    }),
    ItemListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["elements", "page", "limit", "total"],
      properties: {
        elements: {
          type: "array",
          items: { $ref: "#/components/schemas/Item" },
        },
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    Asset: flexibleObject("Epic asset or generated virtual asset.", {
      artifactId: { type: "string" },
      itemId: { type: "string", nullable: true },
      namespace: { type: "string", nullable: true },
      platform: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      downloadSizeBytes: { type: "number", nullable: true },
      installedSizeBytes: { type: "number", nullable: true },
      updatedAt: {
        ...stringDate,
        nullable: true,
      },
    }),
    ManifestHealth: {
      type: "object",
      additionalProperties: false,
      required: [
        "status",
        "canonicalHash",
        "sourceHash",
        "parserVersion",
        "processedAt",
        "fileCount",
        "fileBytes",
        "errorCode",
      ],
      properties: {
        status: {
          type: "string",
          enum: [
            "processing",
            "verified",
            "invalid",
            "unavailable",
            "failed",
            "legacy_unverified",
          ],
        },
        canonicalHash: { type: "string", nullable: true },
        sourceHash: { type: "string" },
        parserVersion: { type: "string", nullable: true },
        processedAt: { ...stringDate, nullable: true },
        fileCount: { type: "integer", nullable: true },
        fileBytes: { type: "number", nullable: true },
        errorCode: { type: "string", nullable: true },
      },
    },
    Build: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "_id",
        "appName",
        "buildVersion",
        "labelName",
        "platform",
        "hash",
        "technologies",
        "manifest",
      ],
      properties: {
        id: { type: "string" },
        _id: { type: "string" },
        appName: { type: "string" },
        labelName: { type: "string" },
        platform: { type: "string" },
        buildVersion: { type: "string" },
        hash: { type: "string" },
        firstSeenAt: { ...stringDate, nullable: true },
        lastSeenAt: { ...stringDate, nullable: true },
        createdAt: { ...stringDate, nullable: true },
        updatedAt: { ...stringDate, nullable: true },
        downloadSizeBytes: { type: "number", nullable: true },
        installedSizeBytes: { type: "number", nullable: true },
        technologies: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        manifest: { $ref: "#/components/schemas/ManifestHealth" },
        comparable: { type: "boolean" },
        sameStream: { type: "boolean" },
        item: {
          allOf: [{ $ref: "#/components/schemas/Item" }],
          nullable: true,
        },
      },
    },
    BuildFileSnapshot: {
      type: "object",
      additionalProperties: false,
      required: ["fileName", "fileHash", "fileSize"],
      properties: {
        fileName: { type: "string" },
        fileHash: { type: "string" },
        fileSize: { type: "number" },
        mimeType: { type: "string", nullable: true },
        installTags: { type: "array", items: { type: "string" } },
        symlinkTarget: { type: "string", nullable: true },
        fileMetaFlags: { type: "integer", nullable: true },
      },
    },
    BuildFileChange: {
      type: "object",
      additionalProperties: false,
      required: ["path", "status", "before", "after", "sizeDeltaBytes"],
      properties: {
        path: { type: "string" },
        status: {
          type: "string",
          enum: ["added", "removed", "modified", "unchanged"],
        },
        before: {
          allOf: [{ $ref: "#/components/schemas/BuildFileSnapshot" }],
          nullable: true,
        },
        after: {
          allOf: [{ $ref: "#/components/schemas/BuildFileSnapshot" }],
          nullable: true,
        },
        sizeDeltaBytes: { type: "number" },
      },
    },
    BuildHistoryResponse: {
      type: "object",
      additionalProperties: false,
      required: ["data", "previousComparableBuildId", "page", "limit", "total"],
      properties: {
        data: { type: "array", items: { $ref: "#/components/schemas/Build" } },
        previousComparableBuildId: { type: "string", nullable: true },
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    BuildComparisonResponse: {
      type: "object",
      additionalProperties: false,
      required: [
        "base",
        "target",
        "comparisonScope",
        "summary",
        "changes",
        "warnings",
        "page",
        "limit",
        "total",
      ],
      properties: {
        base: { $ref: "#/components/schemas/Build" },
        target: { $ref: "#/components/schemas/Build" },
        comparisonScope: {
          type: "string",
          enum: ["same_stream", "cross_stream"],
        },
        summary: { type: "object", additionalProperties: true },
        changes: {
          type: "array",
          items: { $ref: "#/components/schemas/BuildFileChange" },
        },
        warnings: { type: "array", items: { type: "string" } },
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    AchievementSet: flexibleObject("Epic achievement set for a sandbox.", {
      sandboxId: { type: "string" },
      achievements: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: true,
        },
      },
    }),
    Review: flexibleObject("Public user review for an offer.", {
      id: { type: "string" },
      rating: { type: "number" },
      title: { type: "string" },
      content: { type: "string" },
      tags: {
        type: "array",
        items: { type: "string" },
      },
      recommended: { type: "boolean" },
      verified: { type: "boolean" },
      createdAt: stringDate,
      updatedAt: stringDate,
      user: {
        type: "object",
        nullable: true,
        additionalProperties: true,
      },
    }),
    ReviewListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["elements", "page", "total", "limit"],
      properties: {
        elements: {
          type: "array",
          items: { $ref: "#/components/schemas/Review" },
        },
        page: { type: "integer" },
        total: { type: "integer" },
        limit: { type: "integer" },
      },
    },
    ReviewSummary: {
      type: "object",
      additionalProperties: false,
      required: [
        "totalReviews",
        "recommendedPercentage",
        "notRecommendedPercentage",
      ],
      properties: {
        overallScore: { type: "number" },
        averageRating: { type: "number" },
        recommendedPercentage: { type: "number" },
        notRecommendedPercentage: { type: "number" },
        totalReviews: { type: "integer" },
      },
    },
    Sandbox: flexibleObject("Epic namespace/sandbox metadata.", {
      _id: { type: "string" },
      id: { type: "string" },
      namespace: { type: "string" },
      title: { type: "string", nullable: true },
      displayName: { type: "string", nullable: true },
      updated: {
        ...stringDate,
        nullable: true,
      },
    }),
    SandboxListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["elements", "page", "limit", "count"],
      properties: {
        elements: {
          type: "array",
          items: { $ref: "#/components/schemas/Sandbox" },
        },
        page: { type: "integer" },
        limit: { type: "integer" },
        count: { type: "integer" },
      },
    },
    SandboxStatsResponse: {
      type: "object",
      additionalProperties: false,
      required: ["offers", "items", "assets", "builds", "achievements"],
      properties: {
        offers: { type: "integer" },
        items: { type: "integer" },
        assets: { type: "integer" },
        builds: { type: "integer" },
        achievements: { type: "integer" },
      },
    },
    ChangelogSearchResponse: {
      type: "object",
      additionalProperties: true,
      required: ["hits", "estimatedTotalHits"],
      properties: {
        hits: {
          type: "array",
          items: { $ref: "#/components/schemas/ChangelogEntry" },
        },
        estimatedTotalHits: { type: "integer" },
        processingTimeMs: { type: "number" },
        query: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" },
      },
    },
    ChangelogChange: flexibleObject("Single field-level changelog delta.", {
      changeType: { type: "string", nullable: true },
      action: { type: "string", nullable: true },
      type: { type: "string", nullable: true },
      field: { type: "string", nullable: true },
      oldValue: changelogValue,
      newValue: changelogValue,
      oldValueRaw: {
        description:
          "Raw OpenSearch value retained for compatibility when present.",
        nullable: true,
      },
      newValueRaw: {
        description:
          "Raw OpenSearch value retained for compatibility when present.",
        nullable: true,
      },
    }),
    ChangelogContext: flexibleObject(
      "Best-effort context document for a changelog entry. Null when enrichment is unavailable.",
      {
        id: { type: "string", nullable: true },
        artifactId: { type: "string", nullable: true },
        appName: { type: "string", nullable: true },
        buildVersion: { type: "string", nullable: true },
        title: { type: "string", nullable: true },
        namespace: { type: "string", nullable: true },
      },
    ),
    ChangelogMetadata: {
      type: "object",
      additionalProperties: true,
      properties: {
        contextType: {
          type: "string",
          nullable: true,
          description:
            "Kind of document that changed, such as offer, item, asset, product-home, or build.",
        },
        contextId: {
          type: "string",
          nullable: true,
          description:
            "Identifier used to resolve the changed document or context.",
        },
        context: {
          allOf: [{ $ref: "#/components/schemas/ChangelogContext" }],
          nullable: true,
        },
        changes: {
          type: "array",
          items: { $ref: "#/components/schemas/ChangelogChange" },
        },
      },
    },
    Price: flexibleObject("Regional offer price from the price engine.", {
      offerId: { type: "string" },
      region: { type: "string" },
      price: {
        type: "object",
        additionalProperties: true,
        properties: {
          currencyCode: { type: "string" },
          originalPrice: { type: "number" },
          discountPrice: { type: "number" },
          discount: { type: "number" },
        },
      },
      updatedAt: stringDate,
    }),
    SellerSummary: flexibleObject("Seller metadata.", {
      id: { type: "string" },
      name: { type: "string" },
    }),
    SellerListResponse: {
      type: "object",
      additionalProperties: false,
      properties: {
        elements: {
          type: "array",
          items: { $ref: "#/components/schemas/SellerSummary" },
        },
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    Image: flexibleObject("Epic image asset reference.", {
      type: { type: "string" },
      url: { type: "string", format: "uri" },
      width: { type: "integer" },
      height: { type: "integer" },
    }),
    FreeGamesResponse: {
      type: "array",
      description:
        "Current and upcoming Epic free game promotions, enriched with giveaway and regional price data.",
      items: {
        $ref: "#/components/schemas/FreeGameOffer",
      },
    },
    ChangelogEntry: flexibleObject(
      "Change record for an offer, item, asset, or build.",
      {
        _id: { type: "string" },
        timestamp: stringDate,
        metadata: {
          $ref: "#/components/schemas/ChangelogMetadata",
        },
        document: {
          description:
            "Best-effort document associated with search results. Null when enrichment is unavailable.",
          nullable: true,
          oneOf: [
            { $ref: "#/components/schemas/Offer" },
            { $ref: "#/components/schemas/Item" },
            { $ref: "#/components/schemas/Asset" },
            { $ref: "#/components/schemas/Build" },
            {
              type: "object",
              additionalProperties: true,
            },
          ],
        },
      },
    ),
    StatsResponse: {
      type: "object",
      description: "Aggregate site and catalog statistics.",
      additionalProperties: true,
    },
    MessageResponse: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string" },
      },
    },
    BooleanLookupResponse: {
      type: "object",
      additionalProperties: true,
    },
  },
};

export const jsonContent = (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
): OpenAPIV3.MediaTypeObject => ({
  schema,
});
