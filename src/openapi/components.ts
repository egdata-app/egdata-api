import type { OpenAPIV3 } from "openapi-types";

const stringDate: OpenAPIV3.SchemaObject = {
  type: "string",
  format: "date-time",
};

const flexibleObject = (
  description: string,
  properties: Record<string, OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject>,
): OpenAPIV3.SchemaObject => ({
  type: "object",
  description,
  additionalProperties: true,
  properties,
});

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
  limit: {
    name: "limit",
    in: "query",
    required: false,
    description: "Maximum number of records to return. Most list endpoints cap this server-side.",
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
  sellerId: {
    name: "id",
    in: "path",
    required: true,
    description: "Seller identifier.",
    schema: {
      type: "string",
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
          type: "string",
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
      description: "Map of ISO country codes to display names and region metadata.",
      additionalProperties: true,
    },
    Offer: flexibleObject("Public Epic Games Store offer DTO.", {
      id: { type: "string" },
      namespace: { type: "string", nullable: true },
      title: { type: "string", nullable: true },
      description: { type: "string", nullable: true },
      offerType: { type: "string", nullable: true },
      seller: { $ref: "#/components/schemas/SellerSummary" },
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
    }),
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
        allOf: [{ $ref: "#/components/schemas/Offer" }],
      },
    },
    ChangelogEntry: flexibleObject("Change record for an offer, item, asset, or build.", {
      _id: { type: "string" },
      timestamp: stringDate,
      metadata: {
        type: "object",
        additionalProperties: true,
      },
    }),
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
