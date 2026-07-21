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
    CatalogImage: {
      type: "object",
      additionalProperties: false,
      required: ["type", "url"],
      properties: {
        type: { type: "string", maxLength: 512 },
        url: { type: "string", maxLength: 4096 },
        md5: { type: "string", maxLength: 256 },
      },
    },
    CatalogTag: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", maxLength: 256 },
        name: { type: "string", maxLength: 512 },
      },
    },
    CatalogCustomAttribute: {
      type: "object",
      additionalProperties: false,
      required: ["key", "value"],
      properties: {
        key: { type: "string", maxLength: 256 },
        value: { type: "string", maxLength: 65536 },
        type: { type: "string", maxLength: 256 },
      },
    },
    CatalogOfferRecord: {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "namespace",
        "id",
        "title",
        "keyImages",
        "tags",
        "categories",
        "customAttributes",
        "countriesBlacklist",
        "countriesWhitelist",
        "offerMappings",
      ],
      properties: {
        type: { type: "string", enum: ["offer"] },
        namespace: { type: "string", maxLength: 256 },
        id: { type: "string", maxLength: 256 },
        title: { type: "string", maxLength: 512 },
        description: { type: "string", maxLength: 65536 },
        longDescription: { type: "string", maxLength: 65536 },
        offerType: { type: "string", maxLength: 256 },
        seller: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name"],
          properties: {
            id: { type: "string", maxLength: 256 },
            name: { type: "string", maxLength: 512 },
          },
        },
        developerDisplayName: { type: "string", maxLength: 512 },
        publisherDisplayName: { type: "string", maxLength: 512 },
        productSlug: { type: "string", maxLength: 4096 },
        urlSlug: { type: "string", maxLength: 4096 },
        url: { type: "string", maxLength: 4096 },
        keyImages: {
          type: "array",
          items: { $ref: "#/components/schemas/CatalogImage" },
        },
        tags: {
          type: "array",
          items: { $ref: "#/components/schemas/CatalogTag" },
        },
        categories: { type: "array", items: { type: "string" } },
        customAttributes: {
          type: "array",
          items: {
            $ref: "#/components/schemas/CatalogCustomAttribute",
          },
        },
        effectiveDate: { type: "string", format: "date-time" },
        creationDate: { type: "string", format: "date-time" },
        lastModifiedDate: { type: "string", format: "date-time" },
        releaseDate: { type: "string", format: "date-time" },
        pcReleaseDate: { type: "string", format: "date-time" },
        viewableDate: { type: "string", format: "date-time" },
        prePurchase: { type: "boolean" },
        isCodeRedemptionOnly: { type: "boolean" },
        countriesBlacklist: { type: "array", items: { type: "string" } },
        countriesWhitelist: { type: "array", items: { type: "string" } },
        refundType: { type: "string", maxLength: 256 },
        offerMappings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pageSlug", "pageType"],
            properties: {
              pageSlug: { type: "string", maxLength: 4096 },
              pageType: { type: "string", maxLength: 256 },
            },
          },
        },
      },
    },
    CatalogItemRecord: {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "namespace",
        "id",
        "title",
        "keyImages",
        "categories",
        "customAttributes",
        "eulaIds",
        "installModes",
      ],
      properties: {
        type: { type: "string", enum: ["item"] },
        namespace: { type: "string", maxLength: 256 },
        id: { type: "string", maxLength: 256 },
        title: { type: "string", maxLength: 512 },
        description: { type: "string", maxLength: 65536 },
        longDescription: { type: "string", maxLength: 65536 },
        technicalDetails: { type: "string", maxLength: 65536 },
        status: { type: "string", maxLength: 256 },
        entitlementName: { type: "string", maxLength: 256 },
        entitlementType: { type: "string", maxLength: 256 },
        itemType: { type: "string", maxLength: 256 },
        keyImages: {
          type: "array",
          items: { $ref: "#/components/schemas/CatalogImage" },
        },
        categories: { type: "array", items: { type: "string" } },
        customAttributes: {
          type: "array",
          items: {
            $ref: "#/components/schemas/CatalogCustomAttribute",
          },
        },
        creationDate: { type: "string", format: "date-time" },
        lastModifiedDate: { type: "string", format: "date-time" },
        developer: { type: "string", maxLength: 512 },
        developerId: { type: "string", maxLength: 256 },
        eulaIds: { type: "array", items: { type: "string" } },
        installModes: { type: "array", items: { type: "string" } },
        endOfSupport: { type: "boolean" },
        selfRefundable: { type: "boolean" },
        applicationId: { type: "string", maxLength: 256 },
        unsearchable: { type: "boolean" },
        requiresSecureAccount: { type: "boolean" },
        entitlementStartDate: { type: "string", format: "date-time" },
        entitlementEndDate: { type: "string", format: "date-time" },
        useCount: { type: "number", minimum: 0 },
        primaryOfferNamespace: { type: "string", maxLength: 256 },
        primaryOfferId: { type: "string", maxLength: 256 },
      },
    },
    CatalogAssetRecord: {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "namespace",
        "artifactId",
        "platform",
        "itemNamespace",
        "itemId",
      ],
      properties: {
        type: { type: "string", enum: ["asset"] },
        namespace: { type: "string", maxLength: 256 },
        artifactId: { type: "string", maxLength: 256 },
        platform: { type: "string", maxLength: 256 },
        itemNamespace: { type: "string", maxLength: 256 },
        itemId: { type: "string", maxLength: 256 },
        downloadSizeBytes: { type: "number", minimum: 0 },
        installedSizeBytes: { type: "number", minimum: 0 },
        primaryOfferNamespace: { type: "string", maxLength: 256 },
        primaryOfferId: { type: "string", maxLength: 256 },
      },
    },
    CatalogReleaseAppRecord: {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "namespace",
        "appId",
        "platform",
        "itemNamespace",
        "itemId",
      ],
      properties: {
        type: { type: "string", enum: ["release-app"] },
        namespace: { type: "string", maxLength: 256 },
        appId: { type: "string", maxLength: 256 },
        platform: { type: "string", maxLength: 256 },
        itemNamespace: { type: "string", maxLength: 256 },
        itemId: { type: "string", maxLength: 256 },
        releaseId: { type: "string", maxLength: 256 },
        primaryOfferNamespace: { type: "string", maxLength: 256 },
        primaryOfferId: { type: "string", maxLength: 256 },
      },
    },
    CatalogOfferItemRecord: {
      type: "object",
      additionalProperties: false,
      required: [
        "type",
        "offerNamespace",
        "offerId",
        "itemNamespace",
        "itemId",
        "sources",
        "isPrimary",
      ],
      properties: {
        type: { type: "string", enum: ["offer-item"] },
        offerNamespace: { type: "string", maxLength: 256 },
        offerId: { type: "string", maxLength: 256 },
        itemNamespace: { type: "string", maxLength: 256 },
        itemId: { type: "string", maxLength: 256 },
        sources: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: {
            type: "string",
            enum: ["direct", "subitem", "linked"],
          },
        },
        isPrimary: { type: "boolean" },
      },
    },
    CatalogRecord: {
      oneOf: [
        { $ref: "#/components/schemas/CatalogOfferRecord" },
        { $ref: "#/components/schemas/CatalogItemRecord" },
        { $ref: "#/components/schemas/CatalogAssetRecord" },
        { $ref: "#/components/schemas/CatalogReleaseAppRecord" },
        { $ref: "#/components/schemas/CatalogOfferItemRecord" },
      ],
      discriminator: { propertyName: "type" },
    },
    CatalogHydrationIdentifier: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "namespace", "id"],
          properties: {
            type: { type: "string", enum: ["item"] },
            namespace: { type: "string", maxLength: 256 },
            id: { type: "string", maxLength: 256 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "namespace", "artifactId", "platform"],
          properties: {
            type: { type: "string", enum: ["asset"] },
            namespace: { type: "string", maxLength: 256 },
            artifactId: { type: "string", maxLength: 256 },
            platform: { type: "string", maxLength: 64 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "namespace", "appId", "platform"],
          properties: {
            type: { type: "string", enum: ["release-app"] },
            namespace: { type: "string", maxLength: 256 },
            appId: { type: "string", maxLength: 256 },
            platform: { type: "string", maxLength: 64 },
          },
        },
      ],
      discriminator: { propertyName: "type" },
    },
    CatalogHydrationRequest: {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "identifiers", "knownRoots", "knownRecords"],
      properties: {
        schemaVersion: { type: "integer", enum: [2] },
        identifiers: {
          type: "array",
          minItems: 1,
          maxItems: 25,
          items: { $ref: "#/components/schemas/CatalogHydrationIdentifier" },
        },
        knownRoots: {
          type: "array",
          maxItems: 25,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["rootKey", "graphHash"],
            properties: {
              rootKey: { type: "string", maxLength: 4096 },
              graphHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
          },
        },
        knownRecords: {
          type: "array",
          maxItems: 5000,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["recordKey", "sha256"],
            properties: {
              recordKey: { type: "string", maxLength: 4096 },
              sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
          },
        },
      },
    },
    CatalogHydrationRootResult: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: [
            "schemaVersion",
            "rootKey",
            "identifier",
            "hydratedAt",
            "status",
            "graphHash",
          ],
          properties: {
            schemaVersion: { type: "integer", enum: [2] },
            rootKey: { type: "string", maxLength: 4096 },
            identifier: {
              $ref: "#/components/schemas/CatalogHydrationIdentifier",
            },
            hydratedAt: { type: "string", format: "date-time" },
            status: { type: "string", enum: ["unchanged"] },
            graphHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "schemaVersion",
            "rootKey",
            "identifier",
            "hydratedAt",
            "status",
          ],
          properties: {
            schemaVersion: { type: "integer", enum: [2] },
            rootKey: { type: "string", maxLength: 4096 },
            identifier: {
              $ref: "#/components/schemas/CatalogHydrationIdentifier",
            },
            hydratedAt: { type: "string", format: "date-time" },
            status: { type: "string", enum: ["not-found"] },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "schemaVersion",
            "rootKey",
            "identifier",
            "hydratedAt",
            "status",
            "graphHash",
            "recordKeys",
            "records",
          ],
          properties: {
            schemaVersion: { type: "integer", enum: [2] },
            rootKey: { type: "string", maxLength: 4096 },
            identifier: {
              $ref: "#/components/schemas/CatalogHydrationIdentifier",
            },
            hydratedAt: { type: "string", format: "date-time" },
            status: { type: "string", enum: ["resolved"] },
            graphHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
            recordKeys: {
              type: "array",
              maxItems: 500,
              uniqueItems: true,
              items: { type: "string", maxLength: 4096 },
            },
            records: {
              type: "array",
              maxItems: 500,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["recordKey", "sha256", "record"],
                properties: {
                  recordKey: { type: "string", maxLength: 4096 },
                  sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
                  record: { $ref: "#/components/schemas/CatalogRecord" },
                },
              },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "schemaVersion",
            "rootKey",
            "identifier",
            "hydratedAt",
            "status",
            "error",
          ],
          properties: {
            schemaVersion: { type: "integer", enum: [2] },
            rootKey: { type: "string", maxLength: 4096 },
            identifier: {
              $ref: "#/components/schemas/CatalogHydrationIdentifier",
            },
            hydratedAt: { type: "string", format: "date-time" },
            status: { type: "string", enum: ["error"] },
            error: {
              type: "object",
              additionalProperties: false,
              required: ["code", "message"],
              properties: {
                code: { type: "string", maxLength: 128 },
                message: { type: "string", maxLength: 500 },
              },
            },
          },
        },
      ],
      discriminator: { propertyName: "status" },
    },
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
          description:
            "Field used to order results. `priceUpdatedAt` sorts by `prices.<selected region>.updatedAt`.",
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
            "priceUpdatedAt",
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
    BuildFile: {
      type: "object",
      additionalProperties: false,
      required: [
        "_id",
        "manifestHash",
        "appName",
        "buildVersion",
        "appLabel",
        "fileName",
        "fileHash",
        "fileSize",
      ],
      properties: {
        _id: { type: "string" },
        manifestHash: { type: "string" },
        manifestId: { type: "string" },
        snapshotVerification: { type: "string" },
        appName: { type: "string" },
        buildVersion: { type: "string" },
        appLabel: { type: "string" },
        fileName: { type: "string" },
        symlinkTarget: { type: "string", nullable: true },
        fileHash: { type: "string" },
        fileMetaFlags: { type: "integer", nullable: true },
        installTags: { type: "array", items: { type: "string" } },
        fileSize: { type: "number" },
        mimeType: { type: "string", nullable: true },
        depth: { type: "integer", nullable: true },
      },
    },
    BuildFileListResponse: {
      type: "object",
      additionalProperties: false,
      required: ["files", "manifestStatus", "page", "limit", "total"],
      properties: {
        files: {
          type: "array",
          items: { $ref: "#/components/schemas/BuildFile" },
        },
        manifestStatus: {
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
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    BuildFileTreeNode: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "name", "path", "fileCount", "totalSize"],
          properties: {
            type: { type: "string", enum: ["directory"] },
            name: { type: "string" },
            path: { type: "string" },
            fileCount: { type: "integer" },
            totalSize: { type: "number" },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "name", "path", "file"],
          properties: {
            type: { type: "string", enum: ["file"] },
            name: { type: "string" },
            path: { type: "string" },
            file: { $ref: "#/components/schemas/BuildFile" },
          },
        },
      ],
    },
    BuildFileTreeResponse: {
      type: "object",
      additionalProperties: false,
      required: ["path", "nodes", "manifestStatus", "page", "limit", "total"],
      properties: {
        path: {
          type: "string",
          description:
            "Directory that was expanded; an empty string is the build root.",
        },
        nodes: {
          type: "array",
          items: { $ref: "#/components/schemas/BuildFileTreeNode" },
        },
        manifestStatus: {
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
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    BuildItemsResponse: {
      type: "object",
      additionalProperties: false,
      required: ["data", "page", "limit", "total"],
      properties: {
        data: {
          type: "array",
          items: { $ref: "#/components/schemas/Item" },
        },
        page: { type: "integer" },
        limit: { type: "integer" },
        total: { type: "integer" },
      },
    },
    BuildInstallOptions: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["files", "size"],
        properties: {
          files: { type: "integer" },
          size: { type: "number" },
        },
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
    BuildComparisonSummary: {
      type: "object",
      additionalProperties: false,
      required: [
        "files",
        "fileBytes",
        "installedSizeBytes",
        "fullDownloadSizeBytes",
        "technologies",
        "installTags",
        "topFiles",
        "topDirectories",
      ],
      properties: {
        files: {
          type: "object",
          additionalProperties: false,
          required: ["added", "removed", "modified", "unchanged", "total"],
          properties: {
            added: { type: "integer" },
            removed: { type: "integer" },
            modified: { type: "integer" },
            unchanged: { type: "integer" },
            total: { type: "integer" },
          },
        },
        fileBytes: {
          type: "object",
          additionalProperties: false,
          required: [
            "base",
            "target",
            "delta",
            "added",
            "removed",
            "modifiedBase",
            "modifiedTarget",
          ],
          properties: {
            base: { type: "number" },
            target: { type: "number" },
            delta: { type: "number" },
            added: { type: "number" },
            removed: { type: "number" },
            modifiedBase: { type: "number" },
            modifiedTarget: { type: "number" },
          },
        },
        installedSizeBytes: {
          $ref: "#/components/schemas/BuildSizeDelta",
        },
        fullDownloadSizeBytes: {
          $ref: "#/components/schemas/BuildSizeDelta",
        },
        technologies: {
          $ref: "#/components/schemas/BuildTechnologyChanges",
        },
        installTags: {
          $ref: "#/components/schemas/BuildInstallTagChanges",
        },
        topFiles: {
          type: "array",
          items: { $ref: "#/components/schemas/BuildFileChange" },
        },
        topDirectories: {
          type: "array",
          items: { $ref: "#/components/schemas/BuildDirectoryChange" },
        },
      },
    },
    BuildSizeDelta: {
      type: "object",
      additionalProperties: false,
      required: ["base", "target", "delta"],
      properties: {
        base: { type: "number", nullable: true },
        target: { type: "number", nullable: true },
        delta: { type: "number", nullable: true },
      },
    },
    BuildTechnologyChanges: {
      type: "object",
      additionalProperties: false,
      required: ["added", "removed"],
      properties: {
        added: {
          type: "array",
          items: { $ref: "#/components/schemas/BuildTechnology" },
        },
        removed: {
          type: "array",
          items: { $ref: "#/components/schemas/BuildTechnology" },
        },
      },
    },
    BuildTechnology: {
      type: "object",
      additionalProperties: false,
      required: ["section", "technology"],
      properties: {
        section: { type: "string" },
        technology: { type: "string" },
      },
    },
    BuildInstallTagChanges: {
      type: "object",
      additionalProperties: false,
      required: ["added", "removed"],
      properties: {
        added: { type: "array", items: { type: "string" } },
        removed: { type: "array", items: { type: "string" } },
      },
    },
    BuildDirectoryChange: {
      type: "object",
      additionalProperties: false,
      required: ["path", "sizeDeltaBytes"],
      properties: {
        path: { type: "string" },
        sizeDeltaBytes: { type: "number" },
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
        summary: { $ref: "#/components/schemas/BuildComparisonSummary" },
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
