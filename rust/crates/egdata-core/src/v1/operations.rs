//! Static metadata registry for all 154 `/v1` API operations.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::sync::OnceLock;

/// Permission scope evaluated before quota admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum V1Scope {
    #[serde(rename = "catalog:read")]
    CatalogRead,
    #[serde(rename = "offers:read")]
    OffersRead,
    #[serde(rename = "items:read")]
    ItemsRead,
    #[serde(rename = "search:read")]
    SearchRead,
    #[serde(rename = "profiles:read")]
    ProfilesRead,
    #[serde(rename = "stats:read")]
    StatsRead,
    #[serde(rename = "builds:read")]
    BuildsRead,
}

impl V1Scope {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CatalogRead => "catalog:read",
            Self::OffersRead => "offers:read",
            Self::ItemsRead => "items:read",
            Self::SearchRead => "search:read",
            Self::ProfilesRead => "profiles:read",
            Self::StatsRead => "stats:read",
            Self::BuildsRead => "builds:read",
        }
    }
}

/// Expensive-operation quota policy retained from the legacy API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum V1ExpensivePolicy {
    #[serde(rename = "offers-list")]
    OffersList,
    #[serde(rename = "search")]
    Search,
    #[serde(rename = "heavy")]
    Heavy,
    #[serde(rename = "bulk")]
    Bulk,
}

impl V1ExpensivePolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OffersList => "offers-list",
            Self::Search => "search",
            Self::Heavy => "heavy",
            Self::Bulk => "bulk",
        }
    }
}

/// HTTP method supported by `/v1` operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum V1HttpMethod {
    Get,
    Post,
}

impl V1HttpMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

/// Authentication requirement for a `/v1` operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum V1AuthMode {
    Public,
    Key,
}

/// Response encoding category for a `/v1` operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum V1ResponseKind {
    Json,
    Image,
    Xml,
    Text,
    Ndjson,
    Redirect,
}

/// Parameter location in an HTTP request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum V1ParameterLocation {
    Path,
    Query,
    Header,
}

/// OpenAPI parameter descriptor for a `/v1` operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V1Parameter {
    pub name: String,
    #[serde(rename = "in")]
    pub location: V1ParameterLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<bool>,
    pub description: String,
    pub schema: Value,
}

/// OpenAPI request body descriptor for a `/v1` operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V1RequestBody {
    pub required: bool,
    pub description: String,
    pub schema: Value,
}

/// Full static metadata entry for a `/v1` operation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V1OperationMetadata {
    pub operation_id: String,
    pub method: V1HttpMethod,
    pub path: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub scope: V1Scope,
    pub auth: V1AuthMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_kind: Option<V1ResponseKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paginated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expensive_policy: Option<V1ExpensivePolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<V1Parameter>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_body: Option<V1RequestBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy: Option<Vec<String>>,
}

fn path_parameter(name: &str, description: &str) -> V1Parameter {
    V1Parameter {
        name: name.to_string(),
        location: V1ParameterLocation::Path,
        required: Some(true),
        description: description.to_string(),
        schema: json!({ "type": "string" }),
    }
}

fn query_parameter(
    name: &str,
    description: &str,
    schema: Value,
    required: Option<bool>,
) -> V1Parameter {
    V1Parameter {
        name: name.to_string(),
        location: V1ParameterLocation::Query,
        required,
        description: description.to_string(),
        schema,
    }
}

fn query_str(name: &str, description: &str) -> V1Parameter {
    query_parameter(name, description, json!({ "type": "string" }), Some(false))
}

fn cursor_parameter() -> V1Parameter {
    V1Parameter {
        name: "cursor".to_string(),
        location: V1ParameterLocation::Query,
        required: None,
        description: "Opaque forward cursor returned as `meta.pagination.nextCursor`. Cursors expire after 24 hours and are bound to the operation, filters, ordering, country, locale, and page size.".to_string(),
        schema: json!({ "type": "string" }),
    }
}

fn limit_parameter(maximum: u32) -> V1Parameter {
    V1Parameter {
        name: "limit".to_string(),
        location: V1ParameterLocation::Query,
        required: None,
        description: format!("Page size. Defaults to 20; maximum {maximum}."),
        schema: json!({ "type": "integer", "minimum": 1, "maximum": maximum, "default": 20 }),
    }
}

fn country_parameter() -> V1Parameter {
    V1Parameter {
        name: "country".to_string(),
        location: V1ParameterLocation::Query,
        required: None,
        description: "ISO 3166-1 alpha-2 pricing country. Defaults to US; cookies are never used."
            .to_string(),
        schema: json!({ "type": "string", "pattern": "^[A-Z]{2}$", "default": "US" }),
    }
}

fn locale_parameter() -> V1Parameter {
    V1Parameter {
        name: "locale".to_string(),
        location: V1ParameterLocation::Query,
        required: None,
        description: "BCP 47 locale for localized text. Defaults to en-US; cookies are never used."
            .to_string(),
        schema: json!({ "type": "string", "default": "en-US" }),
    }
}

fn op(
    operation_id: &str,
    method: V1HttpMethod,
    path: &str,
    summary: &str,
    tags: &[&str],
    scope: V1Scope,
    auth: V1AuthMode,
) -> V1OperationMetadata {
    V1OperationMetadata {
        operation_id: operation_id.to_string(),
        method,
        path: path.to_string(),
        summary: summary.to_string(),
        description: None,
        tags: tags.iter().map(|s| (*s).to_string()).collect(),
        scope,
        auth,
        response_kind: None,
        paginated: None,
        expensive_policy: None,
        parameters: None,
        request_body: None,
        response_description: None,
        legacy: None,
    }
}

impl V1OperationMetadata {
    fn desc(mut self, text: &str) -> Self {
        self.description = Some(text.to_string());
        self
    }
    fn kind(mut self, kind: V1ResponseKind) -> Self {
        self.response_kind = Some(kind);
        self
    }
    fn page(mut self) -> Self {
        self.paginated = Some(true);
        self
    }
    fn policy(mut self, policy: V1ExpensivePolicy) -> Self {
        self.expensive_policy = Some(policy);
        self
    }
    fn params(mut self, params: Vec<V1Parameter>) -> Self {
        self.parameters = Some(params);
        self
    }
    fn body(mut self, required: bool, description: &str, schema: Value) -> Self {
        self.request_body = Some(V1RequestBody {
            required,
            description: description.to_string(),
            schema,
        });
        self
    }
    fn resp_desc(mut self, text: &str) -> Self {
        self.response_description = Some(text.to_string());
        self
    }
    fn leg(mut self, paths: &[&str]) -> Self {
        self.legacy = Some(paths.iter().map(|s| (*s).to_string()).collect());
        self
    }
}

fn system_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("getHealth", V1HttpMethod::Get, "/v1/health", "Service health", &["System"], V1Scope::CatalogRead, V1AuthMode::Public)
            .desc("Reports Redis and MongoDB connectivity. This endpoint is public and does not require an API key.")
            .leg(&["/health"]),
        op("getV1OpenApi", V1HttpMethod::Get, "/v1/open-api.json", "Version 1 OpenAPI document", &["System"], V1Scope::CatalogRead, V1AuthMode::Public)
            .desc("Machine-readable OpenAPI 3.0 contract for the versioned public API. The legacy contract remains at /open-api.json.")
            .leg(&["/open-api.json"]),
    ]
}

fn catalog_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("listCountries", V1HttpMethod::Get, "/v1/countries", "List pricing countries", &["Regions"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the ISO 3166-1 alpha-2 countries supported by the pricing API. This is a bounded reference list and is not paginated.")
            .leg(&["/countries"]),
        op("listRegions", V1HttpMethod::Get, "/v1/regions", "List Epic pricing regions", &["Regions"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns every Epic pricing region, its currency, description, and member countries. Bounded reference data, not paginated.")
            .leg(&["/regions"]),
        op("getRegion", V1HttpMethod::Get, "/v1/region", "Resolve a country's pricing region", &["Regions"], V1Scope::CatalogRead, V1AuthMode::Key)
            .params(vec![country_parameter()])
            .leg(&["/region"]),
        op("getLatestGames", V1HttpMethod::Get, "/v1/latest-games", "Latest catalog additions", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the 25 most recently created base games, DLC, and add-ons with current regional prices.")
            .params(vec![country_parameter(), locale_parameter()])
            .leg(&["/latest-games"]),
        op("getFeaturedGames", V1HttpMethod::Get, "/v1/featured", "Featured storefront games", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .params(vec![country_parameter(), locale_parameter()])
            .leg(&["/featured"]),
        op("autocomplete", V1HttpMethod::Get, "/v1/autocomplete", "Offer title autocomplete", &["Catalog", "Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .policy(V1ExpensivePolicy::Search)
            .params(vec![
                query_parameter("query", "Title prefix or terms to complete.", json!({ "type": "string", "minLength": 1 }), Some(true)),
                query_parameter("limit", "Maximum suggestions (1-10).", json!({ "type": "integer", "minimum": 1, "maximum": 10, "default": 10 }), Some(false)),
                locale_parameter(),
            ])
            .leg(&["/autocomplete"]),
        op("listSales", V1HttpMethod::Get, "/v1/sales", "Currently discounted offers", &["Catalog", "Prices"], V1Scope::CatalogRead, V1AuthMode::Key)
            .page()
            .params(vec![country_parameter(), locale_parameter(), limit_parameter(30), cursor_parameter()])
            .leg(&["/sales"]),
        op("listActiveSales", V1HttpMethod::Get, "/v1/active-sales", "Active promotional events", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns promotional tag groups whose regional prices are currently discounted, with up to three representative offers each.")
            .page()
            .params(vec![country_parameter(), locale_parameter(), limit_parameter(50), cursor_parameter()])
            .leg(&["/active-sales"]),
        op("getBaseGame", V1HttpMethod::Get, "/v1/base-game/{namespace}", "Resolve a namespace's base game", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .params(vec![path_parameter("namespace", "Epic namespace."), country_parameter(), locale_parameter()])
            .leg(&["/base-game/{namespace}"]),
        op("getOfferBySlug", V1HttpMethod::Get, "/v1/offer-by-slug/{slug}", "Resolve an offer slug", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .params(vec![path_parameter("slug", "Page slug from offer mappings.")])
            .leg(&["/offer-by-slug/{slug}"]),
        op("listItemsFromOffer", V1HttpMethod::Get, "/v1/items-from-offer/{id}", "List items linked to an offer", &["Catalog", "Items"], V1Scope::CatalogRead, V1AuthMode::Key)
            .params(vec![path_parameter("id", "Offer ID.")])
            .leg(&["/items-from-offer/{id}"]),
        op("listTags", V1HttpMethod::Get, "/v1/tags", "List catalog tags", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Bounded reference data. Use the optional group filter for a single tag group.")
            .params(vec![query_str("group", "Tag group name, such as genre or event.")])
            .leg(&["/tags"]),
        op("listChangelog", V1HttpMethod::Get, "/v1/changelog", "Recent catalog changes", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .page()
            .params(vec![limit_parameter(50), cursor_parameter()])
            .leg(&["/changelog"]),
        op("listChangelist", V1HttpMethod::Get, "/v1/changelist", "Recent catalog changes with context", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Compatibility alias for /v1/changelog. Returns the same keyset-paginated change feed.")
            .page()
            .params(vec![limit_parameter(50), cursor_parameter()])
            .leg(&["/changelist"]),
        op("getChangelogEntry", V1HttpMethod::Get, "/v1/changelist/{id}", "Get a catalog change", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .params(vec![path_parameter("id", "Changelog document ID.")])
            .leg(&["/changelist/{id}"]),
        op("hydrateCatalog", V1HttpMethod::Post, "/v1/catalog/hydrate", "Hydrate a bounded catalog graph", &["Catalog"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Read-only bulk cache-warming protocol. Returns one NDJSON line per requested root in input order. Unknown records are omitted unless they changed. Responses are never shared-cached.")
            .policy(V1ExpensivePolicy::Bulk)
            .kind(V1ResponseKind::Ndjson)
            .body(
                true,
                "Schema version 2 hydration request with at most 25 identifiers and 5,000 known record hashes.",
                json!({
                    "type": "object",
                    "required": ["schemaVersion", "identifiers", "knownRoots", "knownRecords"],
                    "additionalProperties": false,
                    "properties": {
                        "schemaVersion": { "type": "integer", "enum": [2] },
                        "identifiers": { "type": "array", "minItems": 1, "maxItems": 25, "items": { "type": "object", "additionalProperties": true } },
                        "knownRoots": { "type": "array", "maxItems": 25, "items": { "type": "object", "additionalProperties": true } },
                        "knownRecords": { "type": "array", "maxItems": 5000, "items": { "type": "object", "additionalProperties": true } }
                    }
                }),
            )
            .leg(&["/catalog/hydrate"]),
    ]
}

fn offers_operations() -> Vec<V1OperationMetadata> {
    let offer_list_params = || {
        vec![
            country_parameter(),
            locale_parameter(),
            limit_parameter(100),
            cursor_parameter(),
        ]
    };
    vec![
        op("listOffers", V1HttpMethod::Get, "/v1/offers", "List offers", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Live keyset-paginated offer list ordered by last modification time. Catalog changes can move records during traversal; cursors are bound to the filter set and expire after 24 hours.")
            .page()
            .policy(V1ExpensivePolicy::OffersList)
            .params(offer_list_params())
            .leg(&["/offers"]),
        op("getOffer", V1HttpMethod::Get, "/v1/offers/{id}", "Get an offer", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .params(vec![path_parameter("id", "Offer ID."), country_parameter(), locale_parameter()])
            .leg(&["/offers/{id}"]),
        op("listOfferEvents", V1HttpMethod::Get, "/v1/offers/events", "List active offer events", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .leg(&["/offers/events"]),
        op("getOfferEvent", V1HttpMethod::Get, "/v1/offers/events/{id}", "Get offers in an event", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .page()
            .params(vec![path_parameter("id", "Event tag ID."), country_parameter(), locale_parameter(), limit_parameter(50), cursor_parameter()])
            .leg(&["/offers/events/{id}"]),
        op("listUpcomingOffers", V1HttpMethod::Get, "/v1/offers/upcoming", "List upcoming offers", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .page()
            .params(vec![country_parameter(), locale_parameter(), limit_parameter(50), cursor_parameter()])
            .leg(&["/offers/upcoming"]),
        op("listOfferGenres", V1HttpMethod::Get, "/v1/offers/genres", "List storefront genres", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .params(vec![locale_parameter()])
            .leg(&["/offers/genres"]),
        op("listTopWishlisted", V1HttpMethod::Get, "/v1/offers/top-wishlisted", "Top wishlisted offers", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .page()
            .params(vec![locale_parameter(), limit_parameter(10), cursor_parameter()])
            .leg(&["/offers/top-wishlisted"]),
        op("listTopSellers", V1HttpMethod::Get, "/v1/offers/top-sellers", "Top selling offers", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .page()
            .params(vec![locale_parameter(), limit_parameter(10), cursor_parameter()])
            .leg(&["/offers/top-sellers"]),
        op("listFeaturedDiscounts", V1HttpMethod::Get, "/v1/offers/featured-discounts", "Featured discounted offers", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .params(vec![country_parameter(), locale_parameter()])
            .leg(&["/offers/featured-discounts"]),
        op("listLatestAchievements", V1HttpMethod::Get, "/v1/offers/latest-achievements", "Offers with newly tracked achievements", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .params(vec![country_parameter(), locale_parameter()])
            .leg(&["/offers/latest-achievements"]),
        op("listLatestReleased", V1HttpMethod::Get, "/v1/offers/latest-released", "Recently released offers", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .page()
            .params(vec![country_parameter(), locale_parameter(), limit_parameter(50), cursor_parameter()])
            .leg(&["/offers/latest-released"]),
        op("checkOfferSlugs", V1HttpMethod::Post, "/v1/offers/slugs", "Resolve multiple offer slugs", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .body(
                true,
                "Up to 100 slugs to resolve.",
                json!({
                    "type": "object",
                    "required": ["slugs"],
                    "additionalProperties": false,
                    "properties": {
                        "slugs": { "type": "array", "maxItems": 100, "items": { "type": "string", "minLength": 1, "maxLength": 300 } }
                    }
                }),
            )
            .leg(&["/offers/slugs"]),
        op("checkOfferExistence", V1HttpMethod::Post, "/v1/offers/exists", "Check multiple offer IDs", &["Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .body(
                true,
                "Up to 200 offer IDs.",
                json!({
                    "type": "object",
                    "required": ["offers"],
                    "additionalProperties": false,
                    "properties": {
                        "offers": { "type": "array", "maxItems": 200, "items": { "type": "string", "minLength": 1, "maxLength": 100 } }
                    }
                }),
            )
            .leg(&["/offers/exists"]),
    ]
}

fn offer_details_operations() -> Vec<V1OperationMetadata> {
    let offer_id = || path_parameter("id", "Offer ID.");
    let offer_with_regional = || vec![offer_id(), country_parameter(), locale_parameter()];
    vec![
        op("getOfferFranchises", V1HttpMethod::Get, "/v1/offers/{id}/franchises", "Franchises containing an offer", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the franchises whose offer list includes this offer. Franchises whose offers all belong to the same namespace are omitted.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/franchises"]),
        op("getOfferFeatures", V1HttpMethod::Get, "/v1/offers/{id}/features", "Offer gameplay features", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Derives launcher, gameplay features, and Epic feature flags from the offer's tags and the custom attributes of its items.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/features"]),
        op("getOfferAssets", V1HttpMethod::Get, "/v1/offers/{id}/assets", "Offer assets", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the assets belonging to the items of this offer, including sub-items and items linked by offer ID.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/assets"]),
        op("getOfferItems", V1HttpMethod::Get, "/v1/offers/{id}/items", "Offer items", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the items referenced by the offer, its sub-items, and any item that links back to the offer.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/items"]),
        op("listOfferChangelog", V1HttpMethod::Get, "/v1/offers/{id}/changelog", "Offer change log", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Keyset-paginated change history for the offer, its items, and its assets, newest first. Each entry includes the changed document. Cursors expire after 24 hours and are bound to the filter set.")
            .page()
            .params(vec![
                offer_id(),
                query_parameter("query", "Full-text search across changelog entries.", json!({ "type": "string", "maxLength": 200 }), Some(false)),
                query_parameter("type", "Only return changes of this change type.", json!({ "type": "string", "maxLength": 100 }), Some(false)),
                query_parameter("field", "Only return changes to this field.", json!({ "type": "string", "maxLength": 200 }), Some(false)),
                limit_parameter(50),
                cursor_parameter(),
            ])
            .leg(&["/offers/{id}/changelog"]),
        op("getOfferChangelogStats", V1HttpMethod::Get, "/v1/offers/{id}/changelog/stats", "Offer change log statistics", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Aggregates the offer's change log between two ISO 8601 timestamps into daily counts, weekday counts, change-type counts, and changed-field counts. Invalid or missing timestamps return 400.")
            .params(vec![
                offer_id(),
                query_parameter("from", "Start of the range, inclusive, as an ISO 8601 timestamp.", json!({ "type": "string", "format": "date-time" }), Some(true)),
                query_parameter("to", "End of the range, inclusive, as an ISO 8601 timestamp.", json!({ "type": "string", "format": "date-time" }), Some(true)),
            ])
            .leg(&["/offers/{id}/changelog/stats"]),
        op("getOfferAchievements", V1HttpMethod::Get, "/v1/offers/{id}/achievements", "Offer achievements", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the achievement sets tracked for the offer's sandbox. Base games and add-ons use different achievement sets.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/achievements"]),
        op("getRelatedOffers", V1HttpMethod::Get, "/v1/offers/{id}/related", "Related offers", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns up to 25 offers from the same namespace with current regional prices. Bounded and not paginated.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/related"]),
        op("getOfferMappings", V1HttpMethod::Get, "/v1/offers/{id}/mappings", "Offer store mappings", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/mappings"]),
        op("getOfferMedia", V1HttpMethod::Get, "/v1/offers/{id}/media", "Offer media", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/media"]),
        op("getOfferSuggestions", V1HttpMethod::Get, "/v1/offers/{id}/suggestions", "Suggested offers", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns up to 25 offers sharing genres with this offer, excluding the same namespace, with current regional prices. Bounded and not paginated.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/suggestions"]),
        op("getOfferAgeRating", V1HttpMethod::Get, "/v1/offers/{id}/age-rating", "Offer age rating", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns every age rating stored for the offer's sandbox, or only the rating system that applies to the requested country when `single=true`. Missing rating data returns 404.")
            .params(vec![
                offer_id(),
                country_parameter(),
                query_parameter("single", "Return only the rating system that applies to the requested country.", json!({ "type": "boolean", "default": false }), Some(false)),
            ])
            .leg(&["/offers/{id}/age-rating"]),
        op("getOfferGiveaways", V1HttpMethod::Get, "/v1/offers/{id}/giveaways", "Offer giveaways", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns every giveaway promotion recorded for this offer, most recent first.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/giveaways"]),
        op("getOfferRatings", V1HttpMethod::Get, "/v1/offers/{id}/ratings", "Offer player ratings", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the Epic player-rating document for the offer's product.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/ratings"]),
        op("getOfferTops", V1HttpMethod::Get, "/v1/offers/{id}/tops", "Offer chart positions", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns a map of collection ID to the offer's current position in that chart.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/tops"]),
        op("getOfferPolls", V1HttpMethod::Get, "/v1/offers/{id}/polls", "Offer rating poll", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the rating poll for the offer's sandbox as `{ poll }`. When no poll exists, `poll` is null instead of an empty body.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/polls"]),
        op("getOfferHltb", V1HttpMethod::Get, "/v1/offers/{id}/hltb", "Offer HowLongToBeat data", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns HowLongToBeat estimates for the offer. Offers without a matched HowLongToBeat entry return 404.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/hltb"]),
        op("getOfferCollection", V1HttpMethod::Get, "/v1/offers/{id}/collection", "Offers in the offer's collection", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the offers referenced by this offer's collection attributes with current regional prices. Offers that are not part of a collection return 404.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/collection"]),
        op("getOfferCollectionEntry", V1HttpMethod::Get, "/v1/offers/{id}/collections/{collection}", "Offer position in a collection", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the offer's chart entry in one collection, including the collection name.")
            .params(vec![offer_id(), path_parameter("collection", "Collection ID as used by the Epic storefront.")])
            .leg(&["/offers/{id}/collections/{collection}"]),
        op("getOfferBundle", V1HttpMethod::Get, "/v1/offers/{id}/bundle", "Bundle contents", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the offers inside a bundle with their regional prices, the bundle price, and the summed contents price. Non-bundle offers return 404.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/bundle"]),
        op("listBundlesContainingOffer", V1HttpMethod::Get, "/v1/offers/{id}/in-bundle", "Bundles containing an offer", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns up to one entry per bundle that contains this offer, with the bundle offer and its regional price.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/in-bundle"]),
        op("getOfferHasPrepurchase", V1HttpMethod::Get, "/v1/offers/{id}/has-prepurchase", "Offer has a prepurchase edition", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Reports whether another base game in the same namespace is available for prepurchase. Always returns an object with `hasPrepurchase`, plus the prepurchase `offer` when one exists.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/has-prepurchase"]),
        op("getOfferHasRegular", V1HttpMethod::Get, "/v1/offers/{id}/has-regular", "Offer has a regular edition", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("For a prepurchase base game, reports whether a regular (non-prepurchase) base game exists in the same namespace. Always returns an object with `isPrepurchase`, plus the regular `offer` when one exists.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/has-regular"]),
        op("getOfferGenres", V1HttpMethod::Get, "/v1/offers/{id}/genres", "Offer genres", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the active storefront genre tags attached to the offer.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/genres"]),
        op("getOfferTechnologies", V1HttpMethod::Get, "/v1/offers/{id}/technologies", "Offer technologies", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the deduplicated technologies reported by the latest build of each asset belonging to the offer.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/technologies"]),
        op("getOfferBuilds", V1HttpMethod::Get, "/v1/offers/{id}/builds", "Offer builds", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns up to 50 recently updated builds for the offer's assets, including manifest and size summaries.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/builds"]),
        op("getOfferIgdb", V1HttpMethod::Get, "/v1/offers/{id}/igdb", "Offer IGDB data", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/igdb"]),
        op("getOfferOverview", V1HttpMethod::Get, "/v1/offers/{id}/overview", "Offer overview", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Combines the localized offer, current price, media, IGDB data, features, age rating, giveaways, poll, genres, and technologies in a single response.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/overview"]),
        op("getOfferPrice", V1HttpMethod::Get, "/v1/offers/{id}/price", "Current offer price", &["Prices"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the latest regional price for the offer. Offers that are not priced in the requested country return 404.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/price"]),
        op("listOfferPriceHistory", V1HttpMethod::Get, "/v1/offers/{id}/price-history", "Offer price history", &["Prices"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Keyset-paginated historical prices for one region, newest first, ordered by `date` and `_id` descending. When neither `country` nor `region` is given, the response is an object keyed by pricing region instead (bounded by the region list and not paginated).")
            .page()
            .params(vec![
                offer_id(),
                country_parameter(),
                query_str("region", "Epic pricing region code. Takes precedence over `country`."),
                query_parameter("since", "Only return price snapshots changed at or after this ISO 8601 timestamp.", json!({ "type": "string", "format": "date-time" }), Some(false)),
                locale_parameter(),
                limit_parameter(100),
                cursor_parameter(),
            ])
            .leg(&["/offers/{id}/price-history"]),
        op("getOfferPriceFairness", V1HttpMethod::Get, "/v1/offers/{id}/price/fairness", "Offer price fairness score", &["Prices"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the regional pricing fairness score computed for the offer in the requested country.")
            .params(vec![offer_id(), country_parameter()])
            .leg(&["/offers/{id}/price/fairness"]),
        op("getOfferRegionalPrice", V1HttpMethod::Get, "/v1/offers/{id}/regional-price", "Regional price comparison", &["Prices"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the current price, historical minimum and maximum, and USD equivalents. With `country` the response is a single object; without it the response is a map keyed by pricing region.")
            .params(vec![offer_id(), country_parameter()])
            .leg(&["/offers/{id}/regional-price"]),
        op("getOfferPriceStats", V1HttpMethod::Get, "/v1/offers/{id}/price-stats", "Offer price statistics", &["Prices"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the current price, the lowest discounted price ever recorded, and the most recent discounted price for the requested region.")
            .params(offer_with_regional())
            .leg(&["/offers/{id}/price-stats"]),
        op("getOfferRequirements", V1HttpMethod::Get, "/v1/offers/{id}/requirements", "Offer system requirements", &["Offer Details"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the normalized Windows and macOS minimum and recommended requirements, following a validated DLC parent when applicable.")
            .params(vec![offer_id()])
            .leg(&["/offers/{id}/requirements"]),
        op("listOfferReviews", V1HttpMethod::Get, "/v1/offers/{id}/reviews", "Offer reviews", &["Offer Reviews"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Keyset-paginated public reviews for the offer, newest first. Reviews are not personalized: no user identity is read from the request, and cursors are bound to the `verified` filter.")
            .page()
            .params(vec![
                offer_id(),
                query_parameter("verified", "Only return reviews from verified owners when true, or unverified reviews when false.", json!({ "type": "boolean" }), Some(false)),
                limit_parameter(25),
                cursor_parameter(),
            ])
            .leg(&["/offers/{id}/reviews"]),
        op("getOfferReviewsSummary", V1HttpMethod::Get, "/v1/offers/{id}/reviews-summary", "Offer review summary", &["Offer Reviews"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Aggregates the offer's public reviews into an average score and recommendation percentages.")
            .params(vec![
                offer_id(),
                query_parameter("verified", "Only aggregate verified-owner reviews when true, or unverified reviews when false.", json!({ "type": "boolean" }), Some(false)),
            ])
            .leg(&["/offers/{id}/reviews-summary"]),
    ]
}

fn search_operations() -> Vec<V1OperationMetadata> {
    let search_params = vec![
        query_str(
            "title",
            "Free-text title, developer, publisher, tag, or description query.",
        ),
        query_str("offerType", "Exact Epic offer type."),
        query_str("tags", "Comma-separated tag IDs (all must match)."),
        query_str("categories", "Comma-separated categories (any must match)."),
        query_str(
            "customAttributes",
            "Comma-separated custom attribute values.",
        ),
        query_str("technologies", "Comma-separated build technologies."),
        query_str("seller", "Seller ID."),
        query_str("developerDisplayName", "Exact developer display name."),
        query_str("publisherDisplayName", "Exact publisher display name."),
        query_str("refundType", "Exact refund type."),
        query_parameter(
            "isCodeRedemptionOnly",
            "Filter code-redemption-only offers.",
            json!({ "type": "boolean" }),
            Some(false),
        ),
        query_parameter(
            "excludeBlockchain",
            "Exclude blockchain offers.",
            json!({ "type": "boolean" }),
            Some(false),
        ),
        query_parameter(
            "onSale",
            "Only discounted offers.",
            json!({ "type": "boolean" }),
            Some(false),
        ),
        query_parameter(
            "pastGiveaways",
            "Only offers with giveaway history.",
            json!({ "type": "boolean" }),
            Some(false),
        ),
        query_parameter(
            "isLowestPrice",
            "Only offers at their lowest observed US price.",
            json!({ "type": "boolean" }),
            Some(false),
        ),
        query_parameter(
            "isLowestPriceEver",
            "Only offers at their historical lowest US price.",
            json!({ "type": "boolean" }),
            Some(false),
        ),
        query_parameter(
            "priceMin",
            "Minimum discount price in minor units.",
            json!({ "type": "integer", "minimum": 0 }),
            Some(false),
        ),
        query_parameter(
            "priceMax",
            "Maximum discount price in minor units.",
            json!({ "type": "integer", "minimum": 0 }),
            Some(false),
        ),
        query_parameter(
            "sortBy",
            "Primary sort field.",
            json!({
                "type": "string",
                "enum": [
                    "releaseDate", "lastModifiedDate", "effectiveDate", "creationDate",
                    "viewableDate", "pcReleaseDate", "upcoming", "priceAsc", "priceDesc",
                    "price", "discount", "discountPercent", "priceUpdatedAt", "giveawayDate"
                ]
            }),
            Some(false),
        ),
        query_parameter(
            "sortDir",
            "Sort direction.",
            json!({ "type": "string", "enum": ["asc", "desc"] }),
            Some(false),
        ),
        query_parameter(
            "facets",
            "Facet detail level.",
            json!({ "type": "string", "enum": ["full", "minimal", "none"], "default": "full" }),
            Some(false),
        ),
        country_parameter(),
        locale_parameter(),
        limit_parameter(100),
        cursor_parameter(),
    ];

    vec![
        op("searchOffers", V1HttpMethod::Get, "/v1/search", "Search offers", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .desc("OpenSearch-backed offer search. Pagination uses `search_after`; cursors are bound to the normalized filters, ordering, country, locale, and page size. `meta.result.total` is deliberately omitted for live cursor traversal.")
            .page()
            .policy(V1ExpensivePolicy::Search)
            .params(search_params)
            .leg(&["/search/v2/search"]),
        op("searchOffersRedirect", V1HttpMethod::Post, "/v1/search", "Normalize search filters to a cacheable GET request", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .desc("Validates a JSON filter document and returns a bodyless 303 redirect to the equivalent GET URL. No search is executed and no result body is returned.")
            .policy(V1ExpensivePolicy::Search)
            .kind(V1ResponseKind::Redirect)
            .body(
                true,
                "Search filters to normalize.",
                json!({
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "title": { "type": "string", "maxLength": 500 },
                        "offerType": { "type": "string" },
                        "tags": { "type": "array", "items": { "type": "string" } },
                        "categories": { "type": "array", "items": { "type": "string" } },
                        "customAttributes": { "type": "array", "items": { "type": "string" } },
                        "technologies": { "type": "array", "items": { "type": "string" } },
                        "seller": { "type": "string" },
                        "developerDisplayName": { "type": "string" },
                        "publisherDisplayName": { "type": "string" },
                        "refundType": { "type": "string" },
                        "isCodeRedemptionOnly": { "type": "boolean" },
                        "excludeBlockchain": { "type": "boolean" },
                        "onSale": { "type": "boolean" },
                        "pastGiveaways": { "type": "boolean" },
                        "isLowestPrice": { "type": "boolean" },
                        "isLowestPriceEver": { "type": "boolean" },
                        "sortBy": { "type": "string" },
                        "sortDir": { "type": "string", "enum": ["asc", "desc"] },
                        "facets": { "type": "string", "enum": ["full", "minimal", "none"] },
                        "price": {
                            "type": "object",
                            "additionalProperties": false,
                            "properties": {
                                "min": { "type": "number", "minimum": 0 },
                                "max": { "type": "number", "minimum": 0 }
                            }
                        },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 20 },
                        "country": { "type": "string" },
                        "locale": { "type": "string" }
                    }
                }),
            )
            .leg(&["/search/v2/search"]),
        op("listSearchTags", V1HttpMethod::Get, "/v1/search/tags", "List active search tags", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .leg(&["/search/tags"]),
        op("listSearchOfferTypes", V1HttpMethod::Get, "/v1/search/offer-types", "List offer types with counts", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .leg(&["/search/offer-types"]),
        op("listSearchDevelopers", V1HttpMethod::Get, "/v1/search/developers", "List developers with offer counts", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .params(vec![
                query_str("query", "Case-insensitive developer name filter."),
                query_parameter("limit", "Maximum entries (1-500).", json!({ "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }), Some(false)),
            ])
            .leg(&["/search/developers"]),
        op("listSearchPublishers", V1HttpMethod::Get, "/v1/search/publishers", "List publishers with offer counts", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .params(vec![
                query_str("query", "Case-insensitive publisher name filter."),
                query_parameter("limit", "Maximum entries (1-500).", json!({ "type": "integer", "minimum": 1, "maximum": 500, "default": 100 }), Some(false)),
            ])
            .leg(&["/search/publishers"]),
        op("searchChangelog", V1HttpMethod::Get, "/v1/search/changelog", "Search catalog changes", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .page()
            .policy(V1ExpensivePolicy::Search)
            .params(vec![
                query_str("query", "Free-text changelog query."),
                query_str("type", "Context type filter."),
                query_str("id", "Context ID filter."),
                limit_parameter(50),
                cursor_parameter(),
            ])
            .leg(&["/search/changelog"]),
        op("naturalLanguageSearch", V1HttpMethod::Post, "/v1/search/natural-language", "Natural-language offer search", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .policy(V1ExpensivePolicy::Heavy)
            .body(
                true,
                "Natural-language query and optional result count.",
                json!({
                    "type": "object",
                    "required": ["query"],
                    "additionalProperties": false,
                    "properties": {
                        "query": { "type": "string", "minLength": 1, "maxLength": 500 },
                        "topK": { "type": "integer", "minimum": 1, "maximum": 50, "default": 10 }
                    }
                }),
            )
            .leg(&["/search/natural-language"]),
        op("getSearchQuery", V1HttpMethod::Get, "/v1/search/{id}", "Get a cached search query", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .params(vec![path_parameter("id", "Search query ID.")])
            .leg(&["/search/{id}"]),
        op("getSearchQueryCount", V1HttpMethod::Get, "/v1/search/{id}/count", "Count and facet a cached search query", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![path_parameter("id", "Search query ID."), country_parameter()])
            .leg(&["/search/{id}/count"]),
    ]
}

fn multisearch_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("multisearchOffers", V1HttpMethod::Get, "/v1/multisearch/offers", "Cross-catalog offer search", &["Search"], V1Scope::SearchRead, V1AuthMode::Key)
            .desc("OpenSearch offer search with legacy multisearch filters. Cursor pagination uses search_after.")
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                query_str("query", "Free-text query or Epic Store URL."),
                query_str("offerType", "Exact offer type."),
                query_str("tags", "Comma-separated tag IDs."),
                query_str("categories", "Comma-separated categories."),
                query_str("customAttributes", "Comma-separated custom attributes."),
                query_str("seller", "Seller ID."),
                query_str("developerDisplayName", "Developer display name."),
                query_str("publisherDisplayName", "Publisher display name."),
                query_str("refundType", "Refund type."),
                query_parameter("isCodeRedemptionOnly", "Filter code-redemption-only offers.", json!({ "type": "boolean" }), Some(false)),
                query_parameter("excludeBlockchain", "Exclude blockchain offers.", json!({ "type": "boolean" }), Some(false)),
                query_parameter("pastGiveaways", "Only offers with giveaway history.", json!({ "type": "boolean" }), Some(false)),
                query_parameter("onSale", "Only discounted offers.", json!({ "type": "boolean" }), Some(false)),
                query_parameter("isLowestPrice", "Only lowest-price offers.", json!({ "type": "boolean" }), Some(false)),
                query_parameter("isLowestPriceEver", "Only historical-lowest offers.", json!({ "type": "boolean" }), Some(false)),
                query_parameter("priceMin", "Minimum discount price.", json!({ "type": "integer" }), Some(false)),
                query_parameter("priceMax", "Maximum discount price.", json!({ "type": "integer" }), Some(false)),
                query_str("sortBy", "Sort field."),
                query_parameter("sortDir", "Sort direction.", json!({ "type": "string", "enum": ["asc", "desc"] }), Some(false)),
                country_parameter(),
                locale_parameter(),
                limit_parameter(100),
                cursor_parameter(),
            ])
            .leg(&["/multisearch/offers"]),
        op("multisearchItems", V1HttpMethod::Get, "/v1/multisearch/items", "Cross-catalog item search", &["Search", "Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                query_str("query", "Free-text item query."),
                query_str("type", "Entitlement type filter."),
                limit_parameter(100),
                cursor_parameter(),
            ])
            .leg(&["/multisearch/items"]),
        op("multisearchSellers", V1HttpMethod::Get, "/v1/multisearch/sellers", "Cross-catalog seller search", &["Search", "Sellers"], V1Scope::SearchRead, V1AuthMode::Key)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                query_str("query", "Seller name query."),
                query_parameter("limit", "Maximum sellers (1-100).", json!({ "type": "integer", "minimum": 1, "maximum": 100, "default": 20 }), Some(false)),
            ])
            .leg(&["/multisearch/sellers"]),
    ]
}

fn native_operations() -> Vec<V1OperationMetadata> {
    let sitemap_page = || {
        query_parameter(
            "page",
            "1-based sitemap page. Omit to receive the sitemap index.",
            json!({ "type": "integer", "minimum": 1 }),
            Some(false),
        )
    };
    vec![
        op("getRobots", V1HttpMethod::Get, "/v1/robots.txt", "Crawler policy", &["Native"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Native text/plain robots policy for API consumers. Sitemap and share-image paths remain crawlable; catalog data remains disallowed.")
            .kind(V1ResponseKind::Text)
            .leg(&["/robots.txt"]),
        op("getSitemap", V1HttpMethod::Get, "/v1/sitemap.xml", "Offer sitemap", &["Native"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Native XML sitemap for website offer pages. Omit `page` for the index. Sitemaps are crawler interfaces and retain page-based paging.")
            .kind(V1ResponseKind::Xml)
            .params(vec![sitemap_page()])
            .leg(&["/sitemap.xml"]),
        op("getItemsSitemap", V1HttpMethod::Get, "/v1/items-sitemap.xml", "Item sitemap", &["Native"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Native XML sitemap for website item pages.")
            .kind(V1ResponseKind::Xml)
            .params(vec![sitemap_page()])
            .leg(&["/items-sitemap.xml"]),
        op("getItemsSitemapAlias", V1HttpMethod::Get, "/v1/items/sitemap.xml", "Item sitemap (legacy alias)", &["Native"], V1Scope::CatalogRead, V1AuthMode::Key)
            .kind(V1ResponseKind::Xml)
            .params(vec![sitemap_page()])
            .leg(&["/items/sitemap.xml"]),
        op("getPromotionsSitemap", V1HttpMethod::Get, "/v1/promotions-sitemap.xml", "Promotion sitemap", &["Native"], V1Scope::CatalogRead, V1AuthMode::Key)
            .kind(V1ResponseKind::Xml)
            .leg(&["/promotions-sitemap.xml"]),
        op("getProfilesSitemap", V1HttpMethod::Get, "/v1/profiles/sitemap.xml", "Public profile sitemap", &["Native"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .kind(V1ResponseKind::Xml)
            .leg(&["/profiles/sitemap.xml"]),
        op("getSandboxesSitemap", V1HttpMethod::Get, "/v1/sandboxes/sitemap.xml", "Sandbox sitemap", &["Native"], V1Scope::CatalogRead, V1AuthMode::Key)
            .kind(V1ResponseKind::Xml)
            .params(vec![sitemap_page()])
            .leg(&["/sandboxes/sitemap.xml"]),
    ]
}

fn og_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("getOfferOg", V1HttpMethod::Get, "/v1/offers/{id}/og", "Offer share image (PNG)", &["Native", "Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Native 1200×630 PNG share image. The response is not JSON-wrapped.")
            .kind(V1ResponseKind::Image)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![path_parameter("id", "Offer ID."), country_parameter()])
            .leg(&["/offers/{id}/og"]),
        op("getOfferOgWebp", V1HttpMethod::Get, "/v1/offers/{id}/og.webp", "Offer share image (WebP)", &["Native", "Offers"], V1Scope::OffersRead, V1AuthMode::Key)
            .kind(V1ResponseKind::Image)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![path_parameter("id", "Offer ID."), country_parameter()])
            .leg(&["/offers/{id}/og.webp"]),
        op("getSandboxOg", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/og", "Sandbox share image (PNG)", &["Native", "Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .kind(V1ResponseKind::Image)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![path_parameter("sandboxId", "Sandbox ID.")])
            .leg(&["/sandboxes/{sandboxId}/og"]),
        op("getSandboxOgWebp", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/og.webp", "Sandbox share image (WebP)", &["Native", "Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .kind(V1ResponseKind::Image)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![path_parameter("sandboxId", "Sandbox ID.")])
            .leg(&["/sandboxes/{sandboxId}/og.webp"]),
        op("getFreeGamesOg", V1HttpMethod::Get, "/v1/free-games/og", "Free games share image", &["Native", "Free Games"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Compatibility redirect to the canonical native free-games image. Existing image URLs remain available for embeds and crawlers.")
            .kind(V1ResponseKind::Redirect)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![country_parameter()])
            .leg(&["/free-games/og"]),
        op("getGameAwardsOg", V1HttpMethod::Get, "/v1/game-awards/og", "The Game Awards share image", &["Native", "Game Awards"], V1Scope::StatsRead, V1AuthMode::Key)
            .desc("Compatibility redirect to the canonical native Game Awards image.")
            .kind(V1ResponseKind::Redirect)
            .policy(V1ExpensivePolicy::Heavy)
            .leg(&["/game-awards/og"]),
        op("getCollectionWeekOg", V1HttpMethod::Get, "/v1/collections/{slug}/{week}/og", "Weekly collection share image", &["Native", "Collections"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Compatibility redirect to the canonical native weekly collection image.")
            .kind(V1ResponseKind::Redirect)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                path_parameter("slug", "Collection slug."),
                path_parameter("week", "ISO week in YYYY-Www form."),
                country_parameter(),
            ])
            .leg(&["/collections/{slug}/{week}/og"]),
    ]
}

fn items_operations() -> Vec<V1OperationMetadata> {
    let bulk_items_schema = || {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["items"],
            "properties": {
                "items": {
                    "type": "array",
                    "maxItems": 100,
                    "items": { "type": "string", "minLength": 1, "maxLength": 200 }
                }
            }
        })
    };
    vec![
        op("listItems", V1HttpMethod::Get, "/v1/items", "List catalog items", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Returns catalog items ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker; items without a modification date sort last. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.")
            .page()
            .params(vec![cursor_parameter(), limit_parameter(100)])
            .leg(&["/items"]),
        op("getItem", V1HttpMethod::Get, "/v1/items/{id}", "Get an item", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Returns one catalog item. The catalog `id` is preferred; legacy `_id` values also resolve.")
            .params(vec![path_parameter("id", "Item identifier. The catalog `id` is preferred; legacy `_id` values also resolve.")])
            .leg(&["/items/{id}"]),
        op("getItemAssets", V1HttpMethod::Get, "/v1/items/{id}/assets", "List item assets", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Returns the asset records whose `itemId` matches the item identifier.")
            .params(vec![path_parameter("id", "Item catalog id.")])
            .resp_desc("Array of serialized asset documents.")
            .leg(&["/items/{id}/assets"]),
        op("getItemBuilds", V1HttpMethod::Get, "/v1/items/{id}/builds", "List item builds", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Returns build summaries for every app referenced by the item's release info, including manifest status, platform, and size metadata.")
            .params(vec![path_parameter("id", "Item catalog id.")])
            .resp_desc("Array of build summaries with ISO 8601 timestamps.")
            .leg(&["/items/{id}/builds"]),
        op("getItemChangelog", V1HttpMethod::Get, "/v1/items/{id}/changelog", "List item changelog entries", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Returns changelog entries for the item, its assets, and its builds as `{ metadata, timestamp, document }` rows ordered by `timestamp` descending with `_id` descending as a stable tie-breaker. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.")
            .page()
            .params(vec![path_parameter("id", "Item catalog id."), cursor_parameter(), limit_parameter(100)])
            .resp_desc("Array of changelog entries shaped as `{ metadata, timestamp, document }`.")
            .leg(&["/items/{id}/changelog"]),
        op("getItemOffer", V1HttpMethod::Get, "/v1/items/{id}/offer", "Get the current base-game offer for an item", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Selects the current base-game offer for the item, preferring offers that are not pre-purchases, and returns it with the current regional price. Offers are filtered by country eligibility before selection.")
            .params(vec![path_parameter("id", "Item catalog id."), country_parameter(), locale_parameter()])
            .leg(&["/items/{id}/offer"]),
        op("getItemsBulk", V1HttpMethod::Post, "/v1/items/bulk", "Get multiple items", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Resolves up to 100 item identifiers in one request. Found items are returned in input order, and identifiers that do not resolve are listed in `meta.missing`.")
            .body(true, "Item identifiers to resolve. At most 100 unique identifiers are accepted per request.", bulk_items_schema())
            .resp_desc("Array of serialized items in input order; unresolved identifiers are listed in `meta.missing`.")
            .leg(&["/items/bulk"]),
        op("getOffersForItemsBulk", V1HttpMethod::Post, "/v1/items/bulk/offers", "Get the best current offer for multiple items", &["Items"], V1Scope::ItemsRead, V1AuthMode::Key)
            .desc("Resolves up to 100 item identifiers and returns one offer per item, combining direct item links with `offersubitems` mappings and ranking base games ahead of other offer types and released offers ahead of pre-purchases. Country-ineligible offers are skipped.")
            .params(vec![country_parameter(), locale_parameter()])
            .body(true, "Item identifiers to resolve. At most 100 unique identifiers are accepted per request.", bulk_items_schema())
            .resp_desc("Object keyed by each input item identifier; every value is a serialized offer or null.")
            .leg(&["/items/bulk/offers"]),
    ]
}

fn sellers_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("listSellers", V1HttpMethod::Get, "/v1/sellers", "List sellers", &["Sellers"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns the bounded reference list of sellers referenced by at least one offer, sorted by display name. The list is not paginated; `meta.truncated` reports whether the safety cap was reached.")
            .resp_desc("Bounded array of serialized sellers.")
            .leg(&["/sellers"]),
        op("listSellerOffers", V1HttpMethod::Get, "/v1/sellers/{id}", "List offers for a seller", &["Sellers"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns a cursor-paginated list of the seller's offers with the current regional price attached, ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker. Use `offerType` to restrict the offer type and `ignoredSandboxes` to exclude namespaces.")
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                path_parameter("id", "Seller identifier (`seller.id` on offers)."),
                cursor_parameter(),
                limit_parameter(100),
                country_parameter(),
                locale_parameter(),
                query_parameter("offerType", "Restrict results to an exact Epic offer type, for example `BASE_GAME` or `DLC`.", json!({ "type": "string", "maxLength": 64 }), Some(false)),
                query_parameter("ignoredSandboxes", "Comma-separated namespace identifiers whose offers must be excluded.", json!({ "type": "string" }), Some(false)),
            ])
            .leg(&["/sellers/{id}"]),
        op("getSellerCoverOffers", V1HttpMethod::Get, "/v1/sellers/{id}/cover", "Get cover offers for a seller", &["Sellers"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns up to five offers from the top-sellers collection for the seller, falling back to the seller's most recently modified offers. Each offer carries the current regional price and the response carries localization metadata.")
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                path_parameter("id", "Seller identifier (`seller.id` on offers)."),
                country_parameter(),
                locale_parameter(),
            ])
            .resp_desc("Up to five serialized offers with current regional prices.")
            .leg(&["/sellers/{id}/cover"]),
        op("getSellerStats", V1HttpMethod::Get, "/v1/sellers/{id}/stats", "Get seller statistics", &["Sellers"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns offer, item, game, and free-game counts for the seller, together with the serialized seller record.")
            .params(vec![path_parameter("id", "Seller document `_id`.")])
            .resp_desc("Object with `offers`, `items`, `games`, `freegames`, and `seller`.")
            .leg(&["/sellers/{id}/stats"]),
    ]
}

fn sandboxes_operations() -> Vec<V1OperationMetadata> {
    let sb = || path_parameter("sandboxId", "Epic namespace identifier of the sandbox.");
    let title_p = || {
        query_parameter(
            "title",
            "Literal, case-insensitive substring matched against the record title.",
            json!({ "type": "string", "maxLength": 200 }),
            Some(false),
        )
    };
    vec![
        op("listSandboxes", V1HttpMethod::Get, "/v1/sandboxes", "List sandboxes", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the known Epic namespaces (sandboxes) ordered by namespace identifier (`_id`) ascending. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.")
            .page()
            .params(vec![cursor_parameter(), limit_parameter(100)])
            .resp_desc("Cursor page of serialized namespace documents.")
            .leg(&["/sandboxes"]),
        op("getSandbox", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}", "Get a sandbox", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the stored sandbox record, falling back to the corresponding namespace record when no sandbox document exists. Sandboxes from the list operation are always retrievable.")
            .params(vec![sb()])
            .leg(&["/sandboxes/{sandboxId}"]),
        op("listSandboxItems", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/items", "List items in a sandbox", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns catalog items whose namespace matches the sandbox, ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker; items without a modification date sort last.")
            .page()
            .params(vec![
                sb(),
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("entitlementType", "Comma-separated entitlement types, for example `EXECUTABLE` or `ENTITLEMENT`.", json!({ "type": "string", "maxLength": 500 }), Some(false)),
                query_parameter("status", "Comma-separated item statuses, for example `ACTIVE`.", json!({ "type": "string", "maxLength": 500 }), Some(false)),
                query_parameter("platforms", "Comma-separated release platforms; an item matches when at least one release entry uses one of them.", json!({ "type": "string", "maxLength": 500 }), Some(false)),
                title_p(),
            ])
            .resp_desc("Cursor page of serialized catalog items.")
            .leg(&["/sandboxes/{sandboxId}/items"]),
        op("listSandboxOffers", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/offers", "List offers in a sandbox", &["Sandboxes"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns offers whose namespace matches the sandbox, ordered by `lastModifiedDate` descending with `id` ascending as a stable tie-breaker. Each offer is localized for the requested locale and carries the current price for the country's Epic pricing region when one is stored.")
            .page()
            .params(vec![
                sb(),
                cursor_parameter(),
                limit_parameter(100),
                country_parameter(),
                locale_parameter(),
                query_parameter("offerType", "Comma-separated Epic offer types, for example `BASE_GAME` or `DLC`.", json!({ "type": "string", "maxLength": 500 }), Some(false)),
                title_p(),
            ])
            .resp_desc("Cursor page of serialized offers with localized text and current regional prices.")
            .leg(&["/sandboxes/{sandboxId}/offers"]),
        op("listSandboxAssets", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/assets", "List assets in a sandbox", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns stored asset records merged with synthetic assets generated from item release info that has no stored artifact, ordered by `updatedAt` descending with `artifactId` and then `platform` ascending. Synthetic assets report zero sizes, the source item title, and a deterministic `_id` so cursors stay stable.")
            .page()
            .params(vec![
                sb(),
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("platform", "Comma-separated asset platforms. Matching is exact and case-sensitive.", json!({ "type": "string", "maxLength": 500 }), Some(false)),
            ])
            .resp_desc("Cursor page of serialized real and synthetic assets.")
            .leg(&["/sandboxes/{sandboxId}/assets"]),
        op("getSandboxBaseGame", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/base-game", "Get the base game for a sandbox", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the released base-game offer for the sandbox with its current regional price and localized text. When no released base game exists it falls back to a pre-purchase base game, then to an executable item, which is returned with `isItem: true`.")
            .params(vec![sb(), country_parameter(), locale_parameter()])
            .resp_desc("Serialized offer with `price`, or a serialized item with `isItem: true`.")
            .leg(&["/sandboxes/{sandboxId}/base-game"]),
        op("listSandboxAchievements", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/achievements", "List achievement sets for a sandbox", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns every achievement set stored for the sandbox. The bounded reference response is not paginated.")
            .params(vec![sb()])
            .resp_desc("Array of serialized achievement sets.")
            .leg(&["/sandboxes/{sandboxId}/achievements"]),
        op("getSandboxChangelog", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/changelog", "List changelog entries for a sandbox", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns changelog entries for the sandbox, its offers, its items, their assets, and their builds as `{ hits }`, ordered by `timestamp` descending with `_id` descending as a stable tie-breaker. Each hit carries the resolved context document in `metadata.context`. Totals are not calculated; use `meta.pagination.hasMore`.")
            .page()
            .params(vec![sb(), cursor_parameter(), limit_parameter(100)])
            .resp_desc("Object with a `hits` array of changelog entries including `metadata.context`.")
            .leg(&["/sandboxes/{sandboxId}/changelog"]),
        op("listSandboxBuilds", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/builds", "List builds for a sandbox", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns build summaries for every build app referenced by the sandbox's items, ordered by `updatedAt` descending with `_id` descending as a stable tie-breaker. Use `platform` to restrict the items whose release info is considered.")
            .page()
            .params(vec![
                sb(),
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("platform", "Comma-separated release platforms used to restrict the sandbox items.", json!({ "type": "string", "maxLength": 500 }), Some(false)),
            ])
            .resp_desc("Cursor page of serialized build summaries.")
            .leg(&["/sandboxes/{sandboxId}/builds"]),
        op("getSandboxStats", V1HttpMethod::Get, "/v1/sandboxes/{sandboxId}/stats", "Get sandbox statistics", &["Sandboxes"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns offer, item, asset, build, and achievement counts for the sandbox. The asset count includes synthetic assets generated from release info without a stored artifact.")
            .params(vec![sb()])
            .resp_desc("Object with `offers`, `items`, `assets`, `builds`, and `achievements` counts.")
            .leg(&["/sandboxes/{sandboxId}/stats"]),
    ]
}

fn builds_operations() -> Vec<V1OperationMetadata> {
    let dir_p = |desc: &str| {
        query_parameter(
            "dir",
            desc,
            json!({ "type": "string", "enum": ["asc", "desc"], "default": "asc" }),
            Some(false),
        )
    };
    let q_p = || {
        query_parameter(
            "q",
            "Literal, case-insensitive file path search. Regular-expression characters are matched literally.",
            json!({ "type": "string", "maxLength": 200 }),
            Some(false),
        )
    };
    let ext_p = || {
        query_parameter(
            "extension",
            "Comma-separated file extensions without leading dots, for example `pak,dll`. At most 20 distinct extensions are accepted.",
            json!({ "type": "string", "maxLength": 500 }),
            Some(false),
        )
    };
    vec![
        op("listBuilds", V1HttpMethod::Get, "/v1/builds", "List observed builds", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Returns observed builds ordered by the requested timestamp field with `_id` as a tie-breaker in the same direction and missing timestamps last. Each entry is a build summary with the matching executable catalog item when one is known.")
            .page()
            .params(vec![
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("sortBy", "Timestamp field used for ordering. Defaults to `createdAt`.", json!({ "type": "string", "enum": ["createdAt", "updatedAt", "firstSeenAt"], "default": "createdAt" }), Some(false)),
                query_parameter("sortDir", "Sort direction. Defaults to `desc`.", json!({ "type": "string", "enum": ["asc", "desc"], "default": "desc" }), Some(false)),
            ])
            .resp_desc("Cursor page of build summaries, each with the matching catalog item or `null`.")
            .leg(&["/builds"]),
        op("getBuild", V1HttpMethod::Get, "/v1/builds/{id}", "Get a sanitized build snapshot", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Returns one build summary with manifest status, sizes, technologies, and stored size fallbacks from the matching platform asset. Raw manifest locations are never returned.")
            .params(vec![path_parameter("id", "Build document identifier.")])
            .leg(&["/builds/{id}"]),
        op("getBuildHistory", V1HttpMethod::Get, "/v1/builds/{id}/history", "List comparison candidates for a build", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Returns chronological observations for the same label stream or platform as the build, ordered by `firstSeenAt` descending, `createdAt` descending, and `_id` descending. Each entry reports whether it has a comparable stored snapshot and whether it belongs to the same stream; `meta.previousComparableBuildId` identifies the previous comparable snapshot.")
            .page()
            .params(vec![
                path_parameter("id", "Build document identifier."),
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("scope", "Candidate scope. Defaults to `stream`.", json!({ "type": "string", "enum": ["stream", "platform"], "default": "stream" }), Some(false)),
            ])
            .resp_desc("Cursor page of build summaries with `comparable` and `sameStream`, plus `meta.previousComparableBuildId`.")
            .leg(&["/builds/{id}/history"]),
        op("compareBuilds", V1HttpMethod::Get, "/v1/builds/{targetId}/compare/{baseId}", "Compare two stored build snapshots", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Compares immutable file snapshots by full path, ordered by `fileName` in the requested direction with an opaque `fileName` cursor. Responding requires streaming both stored snapshots so the summary, top files, and top directories are complete; the page size is bounded, the scan is not. Full-download deltas are not patch-download estimates.")
            .page()
            .params(vec![
                path_parameter("targetId", "Build document identifier of the target build."),
                path_parameter("baseId", "Build document identifier of the base build."),
                cursor_parameter(),
                limit_parameter(100),
                dir_p("Path order. Defaults to `asc`."),
                query_parameter("status", "Comma-separated change statuses. Defaults to `added,modified,removed`.", json!({ "type": "string", "pattern": "^(added|removed|modified|unchanged)(,(added|removed|modified|unchanged))*$" }), Some(false)),
                q_p(),
                ext_p(),
            ])
            .resp_desc("Comparison summary, warnings, and a cursor page of `changes`.")
            .leg(&["/builds/{targetId}/compare/{baseId}"]),
        op("listBuildFiles", V1HttpMethod::Get, "/v1/builds/{id}/files", "List files in a build snapshot", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Returns file snapshot records ordered by `depth`, `fileName`, or `fileSize` with a `fileName` tie-breaker, filtered by literal path search and extension. Items without the sort value use the natural BSON null order for the requested direction.")
            .page()
            .params(vec![
                path_parameter("id", "Build document identifier."),
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("sort", "Sort field. Defaults to `depth`.", json!({ "type": "string", "enum": ["depth", "fileName", "fileSize"], "default": "depth" }), Some(false)),
                dir_p("Sort direction. Defaults to `asc`."),
                q_p(),
                ext_p(),
            ])
            .resp_desc("Cursor page of file records plus `meta.manifestStatus`.")
            .leg(&["/builds/{id}/files"]),
        op("getBuildTree", V1HttpMethod::Get, "/v1/builds/{id}/tree", "Expand one directory of a build file tree", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Returns only the immediate child files and directories of the requested manifest directory, ordered by node type and then name. Expand a directory by passing the `path` returned for that node. Pass `meta.pagination.nextCursor` as `cursor` to fetch the next page.")
            .page()
            .params(vec![
                path_parameter("id", "Build document identifier."),
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("path", "Relative directory to expand, using forward slashes. Omit for the build root.", json!({ "type": "string", "maxLength": 500 }), Some(false)),
            ])
            .resp_desc("Cursor page of `directory` and `file` nodes plus `meta.path` and `meta.manifestStatus`.")
            .leg(&["/builds/{id}/tree"]),
        op("listBuildItems", V1HttpMethod::Get, "/v1/builds/{id}/items", "List catalog items associated with a build", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Returns catalog items whose release info references the build app name, ordered by catalog `id` ascending.")
            .page()
            .params(vec![path_parameter("id", "Build document identifier."), cursor_parameter(), limit_parameter(100)])
            .resp_desc("Cursor page of serialized catalog items.")
            .leg(&["/builds/{id}/items"]),
        op("getBuildInstallOptions", V1HttpMethod::Get, "/v1/builds/{id}/install-options", "Summarize install tags in a build", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Returns a bounded map keyed by install tag, with file counts and total bytes. The map is not paginated; `meta.truncated` reports whether the safety cap was reached.")
            .params(vec![path_parameter("id", "Build document identifier.")])
            .resp_desc("Object keyed by install tag with `{ files, size }` values and `meta.truncated`.")
            .leg(&["/builds/{id}/install-options"]),
        op("resolveLauncherRecords", V1HttpMethod::Post, "/v1/builds/resolve-launcher-records", "Resolve parsed Windows manifests to launcher metadata", &["Builds"], V1Scope::BuildsRead, V1AuthMode::Key)
            .desc("Resolves bounded, path-free metadata from parsed Windows manifests. Results preserve request order and echo each `requestId` with its per-candidate status. Ambiguous catalog, asset, and parent relationships are reported as `ambiguous` instead of guessing.")
            .policy(V1ExpensivePolicy::Bulk)
            .body(
                true,
                "Up to 100 parsed Windows manifest candidates. Only bounded metadata is accepted; manifest bytes and local file paths are rejected.",
                json!({
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["candidates"],
                    "properties": {
                        "candidates": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 100,
                            "items": {
                                "type": "object",
                                "additionalProperties": false,
                                "required": ["requestId", "buildAppName", "buildVersion", "platform"],
                                "properties": {
                                    "requestId": {
                                        "type": "string", "minLength": 1, "maxLength": 128,
                                        "description": "Caller correlation value. Every candidate in one request must use a unique `requestId`."
                                    },
                                    "buildAppName": { "type": "string", "minLength": 1, "maxLength": 256, "description": "Application name parsed from the manifest." },
                                    "buildVersion": { "type": "string", "maxLength": 512, "description": "Build version parsed from the manifest." },
                                    "platform": { "type": "string", "enum": ["Windows"], "description": "Only Windows manifests are resolvable." },
                                    "catalogHint": {
                                        "type": "object",
                                        "additionalProperties": false,
                                        "required": ["artifactId", "catalogItemId", "catalogNamespace"],
                                        "properties": {
                                            "artifactId": { "type": "string", "minLength": 1, "maxLength": 256 },
                                            "catalogItemId": { "type": "string", "minLength": 1, "maxLength": 256 },
                                            "catalogNamespace": { "type": "string", "minLength": 1, "maxLength": 256 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }),
            )
            .resp_desc("Object with a `results` array holding one resolved record or status per candidate, in request order.")
            .leg(&["/builds/resolve-launcher-records"]),
    ]
}

fn free_games_operations() -> Vec<V1OperationMetadata> {
    let offer_types = [
        "IN_GAME_PURCHASE",
        "BASE_GAME",
        "EXPERIENCE",
        "UNLOCKABLE",
        "ADD_ON",
        "Bundle",
        "CONSUMABLE",
        "WALLET",
        "OTHERS",
        "DEMO",
        "DLC",
        "VIRTUAL_CURRENCY",
        "BUNDLE",
        "DIGITAL_EXTRA",
        "EDITION",
    ];
    let sort_fields = [
        "giveawayDate",
        "releaseDate",
        "lastModifiedDate",
        "effectiveDate",
        "creationDate",
        "viewableDate",
        "pcReleaseDate",
        "upcoming",
        "price",
        "giveaway.endDate",
        "price.price.discountPrice",
    ];
    vec![
        op("listFreeGames", V1HttpMethod::Get, "/v1/free-games", "Current free games", &["Free Games"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns current and announced giveaways from the desktop free-games catalog and the mobile freebies feed. Offer documents are expanded and localized, and every entry carries `giveaway` metadata (including the full desktop giveaway history), the current regional price, and the items unlocked by the offer. Cookies are never used.")
            .params(vec![country_parameter(), locale_parameter()])
            .resp_desc("`data` is an array of expanded offers with `giveaway`, `items`, and `price`; entries whose offer document is missing contain `giveaway` only.")
            .leg(&["/free-games"]),
        op("listFreeGamesHistory", V1HttpMethod::Get, "/v1/free-games/history", "Free game history", &["Free Games"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Cursor-paginated giveaway history ordered by `endDate` descending and then `id` descending. Each entry contains the giveaway record, the expanded localized offer, and the current regional price. Cursors are bound to the filter set, ordering, country, locale, and page size, and expire after 24 hours.")
            .page()
            .params(vec![country_parameter(), locale_parameter(), limit_parameter(25), cursor_parameter()])
            .resp_desc("`data` is the page of expanded offers; `meta.pagination` carries `limit`, `hasMore`, `nextCursor`, and `total`.")
            .leg(&["/free-games/history"]),
        op("searchFreeGames", V1HttpMethod::Get, "/v1/free-games/search", "Search free games", &["Free Games"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Searches the `egdata.offers` OpenSearch index for offers with giveaway entries, using the legacy title, offer type, tag, and category filters. Pagination uses `search_after` instead of offsets, so cursors stay stable while the index changes. Results default to `lastModifiedDate` descending with `id.keyword` ascending as a unique tie-breaker. `meta.pagination.total` and `meta.result.total` report the exact OpenSearch hit count.")
            .page()
            .policy(V1ExpensivePolicy::Search)
            .params(vec![
                query_parameter("title", "Full-text query matched against title, description, and offer ID.", json!({ "type": "string", "maxLength": 200 }), Some(false)),
                query_parameter("offerType", "Restrict results to one Epic offer type.", json!({ "type": "string", "enum": offer_types }), Some(false)),
                query_str("tags", "Comma-separated tag IDs. An offer must contain every supplied tag."),
                query_str("categories", "Comma-separated category names. An offer must contain every supplied category."),
                query_parameter("sortBy", "Sort field. `giveawayDate` maps to `freeEntries.endDate`; `price` maps to the selected region's discount price.", json!({ "type": "string", "enum": sort_fields, "default": "lastModifiedDate" }), Some(false)),
                query_parameter("sortDir", "Sort direction.", json!({ "type": "string", "enum": ["asc", "desc"], "default": "desc" }), Some(false)),
                country_parameter(),
                locale_parameter(),
                limit_parameter(50),
                cursor_parameter(),
            ])
            .resp_desc("`data` is the page of localized offers; `meta.pagination` carries `limit`, `hasMore`, `nextCursor`, and `total`, and `meta.result` carries the hit total, the total relation, `timedOut`, and `tookMs`.")
            .leg(&["/free-games/search"]),
        op("getFreeGamesStats", V1HttpMethod::Get, "/v1/free-games/stats", "Free game statistics", &["Free Games"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns giveaway totals, distinct seller counts, repeated giveaways, and the summed value of all recorded giveaways for the selected pricing region. When no price rows exist the value object is still returned with zero amounts and nullable currency codes instead of failing.")
            .params(vec![country_parameter(), locale_parameter()])
            .resp_desc("`data.totalValue.currencyCode`, `data.totalValue.basePayoutCurrencyCode`, and `data.totalValue.payoutCurrencyExchangeRate` are null when no priced giveaway exists.")
            .leg(&["/free-games/stats"]),
        op("listMobileFreeGames", V1HttpMethod::Get, "/v1/free-games/mobile", "Current mobile free games", &["Free Games"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the mobile freebies that are active now, expanded with the localized offer, the normalized giveaway record, and the current regional price. Entries without a matching offer document are omitted.")
            .params(vec![country_parameter(), locale_parameter()])
            .leg(&["/free-games/mobile"]),
        op("listFreeGameSellers", V1HttpMethod::Get, "/v1/free-games/sellers", "Free game sellers", &["Free Games"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns every seller that has appeared in the giveaway catalog, with the number of distinct giveaways attributed to it, ordered by that count descending. The aggregate is global and does not depend on a pricing country.")
            .params(vec![])
            .leg(&["/free-games/sellers"]),
    ]
}

fn promotions_operations() -> Vec<V1OperationMetadata> {
    let sort_fields = [
        "releaseDate",
        "lastModifiedDate",
        "effectiveDate",
        "creationDate",
        "viewableDate",
        "pcReleaseDate",
        "upcoming",
        "price",
    ];
    vec![
        op("listPromotions", V1HttpMethod::Get, "/v1/promotions", "Active promotions", &["Promotions"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns a bounded list of active event tags ordered by their number of referenced offers. The legacy endpoint returned every active event; v1 caps the list with `limit` and never uses cookies.")
            .params(vec![limit_parameter(100)])
            .resp_desc("`data` is an array of event tag documents with `id`, `name`, `referenceCount`, and status metadata.")
            .leg(&["/promotions"]),
        op("listPromotionOffers", V1HttpMethod::Get, "/v1/promotions/{id}", "Offers in a promotion", &["Promotions"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Cursor-paginated offers carrying the promotion's event tag. Results are ordered by `sortBy` and `sortDir` with the offer ID ascending as a unique tie-breaker, defaulting to `lastModifiedDate` descending. `price` sorting uses the current price engine row for the selected region. `q` filters titles case-insensitively. Cursors are bound to the promotion, query, ordering, country, locale, and page size.")
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                path_parameter("id", "Promotion event tag ID."),
                query_parameter("q", "Case-insensitive title filter.", json!({ "type": "string", "maxLength": 200 }), Some(false)),
                query_parameter("sortBy", "Sort field.", json!({ "type": "string", "enum": sort_fields, "default": "lastModifiedDate" }), Some(false)),
                query_parameter("sortDir", "Sort direction.", json!({ "type": "string", "enum": ["asc", "desc"], "default": "desc" }), Some(false)),
                country_parameter(),
                locale_parameter(),
                limit_parameter(50),
                cursor_parameter(),
            ])
            .resp_desc("`data` is the page of expanded localized offers; `meta.title` is the event name, `meta.start` is 0 on the first page (null afterwards, because cursors do not expose offsets), and `meta.pagination` carries `limit`, `hasMore`, `nextCursor`, and `total`.")
            .leg(&["/promotions/{id}"]),
        op("getPromotionCover", V1HttpMethod::Get, "/v1/promotions/{id}/cover", "Promotion cover offer", &["Promotions"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the localized base-game offer from the first namespace referenced by the promotion. This is the offer metadata the legacy endpoint returned; it is not a rendered image. OG image routes remain outside v1.")
            .params(vec![path_parameter("id", "Promotion event tag ID."), locale_parameter()])
            .resp_desc("`data` is the expanded localized base-game offer used as the promotion cover.")
            .leg(&["/promotions/{id}/cover"]),
    ]
}

fn collections_operations() -> Vec<V1OperationMetadata> {
    let week_param = V1Parameter {
        name: "week".to_string(),
        location: V1ParameterLocation::Path,
        required: Some(true),
        description: "ISO week in `YYYYWNN` format, for example `2025W31`. Weeks start on Monday in UTC; `end` is exclusive.".to_string(),
        schema: json!({ "type": "string", "pattern": "^\\d{4}W\\d{2}$" }),
    };
    vec![
        op("getCollection", V1HttpMethod::Get, "/v1/collections/{slug}", "Get a collection", &["Collections"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Cursor-paginated collection positions ordered by `position` ascending with the offer ID as a unique tie-breaker. Positions with a non-positive position are excluded. `country` selects the pricing region and `locale` localizes offer text; cookies are never used. Cursors are bound to the collection, ordering, country, locale, and page size.")
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![path_parameter("slug", "Collection slug."), country_parameter(), locale_parameter(), limit_parameter(100), cursor_parameter()])
            .resp_desc("`data` is the page of expanded localized offers with `position`, `previousPosition`, and the source position document in `metadata`; `meta` carries `title`, `updatedAt`, and `pagination`.")
            .leg(&["/collections/{slug}"]),
        op("getCollectionWeek", V1HttpMethod::Get, "/v1/collections/{slug}/{week}", "Get a collection for one ISO week", &["Collections"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Cursor-paginated positions for one ISO week. Each offer is represented by its most recent in-week position; only entries with a positive position are included. The `week` path parameter must match `YYYYWNN` and name a real ISO week, otherwise the endpoint returns a 400 problem instead of the legacy 500. Cursors are bound to the collection, week, ordering, country, locale, and page size.")
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![path_parameter("slug", "Collection slug."), week_param, country_parameter(), locale_parameter(), limit_parameter(100), cursor_parameter()])
            .resp_desc("`data` is the page of expanded localized offers with week position metadata; `meta` carries `title`, `updatedAt`, `start`, `end`, and `pagination`.")
            .leg(&["/collections/{slug}/{week}"]),
    ]
}

fn profiles_operations() -> Vec<V1OperationMetadata> {
    let account_id = || path_parameter("id", "Epic account ID.");
    let sandbox_id = || path_parameter("sandboxId", "Epic sandbox ID (the base-game namespace).");
    vec![
        op("listProfileLeaderboard", V1HttpMethod::Get, "/v1/profiles/leaderboard", "Profile XP leaderboard", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Ranks public Epic player profiles by the achievement XP stored for every sandbox they have played. Ties share the same `rank`; entries are ordered by `rank` ascending and then `accountId` ascending. `data` is the leaderboard array and `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`.")
            .kind(V1ResponseKind::Json)
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![cursor_parameter(), limit_parameter(100)])
            .resp_desc("`data` is an array of entries with `rank`, `accountId`, `displayName`, `xpEarned`, `achievementsWon`, `awardsEarned`, and `awardsByType`.")
            .leg(&["/profiles/leaderboard"]),
        op("getProfile", V1HttpMethod::Get, "/v1/profiles/{id}", "Get a player profile", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Returns the public Epic profile, the linked Discord account metadata egdata stores, the profile creation date, the review count, and a per-sandbox achievement summary. Private self-profile and mutation endpoints are not part of v1.")
            .kind(V1ResponseKind::Json)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![account_id()])
            .resp_desc("`data` contains `epicAccountId`, `displayName`, `avatar`, `linkedAccounts`, `creationDate`, `reviews`, and an `achievements` summary with one entry per sandbox that has a base-game offer.")
            .leg(&["/profiles/{id}"]),
        op("listProfileAchievements", V1HttpMethod::Get, "/v1/profiles/{id}/achievements", "List unlocked profile achievements", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Lists the profile's unlocked achievements, joined with the achievement-set metadata and the owning base-game or DLC offer. Ordered by unlock date descending, with `sandboxId` and `achievementName` as unique tie-breakers. `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`.")
            .kind(V1ResponseKind::Json)
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![account_id(), cursor_parameter(), limit_parameter(100)])
            .resp_desc("`data.achievements` is the page of unlocked achievements (achievement-set fields plus `unlocked`, `unlockDate`, and `offer`); `data.count` is the total number of distinct unlocked achievements.")
            .leg(&["/profiles/{id}/achievements"]),
        op("getProfileAchievements", V1HttpMethod::Get, "/v1/profiles/{id}/achievements/{sandboxId}", "Get profile achievements for one sandbox", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Returns the stored player achievement records for one sandbox together with the achievement-set metadata referenced by those records. Empty arrays are returned when the profile has no recorded achievements for the sandbox.")
            .kind(V1ResponseKind::Json)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![account_id(), sandbox_id()])
            .resp_desc("`data.playerAchievements` and `data.sandboxAchievements` preserve the legacy field names.")
            .leg(&["/profiles/{id}/achievements/{sandboxId}"]),
        op("listProfileRareAchievements", V1HttpMethod::Get, "/v1/profiles/{id}/rare-achievements", "List rarest unlocked profile achievements", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Returns the 25 rarest unlocked achievements across all of the profile's games, ordered by `completedPercent` ascending. Each entry includes the matching base-game offer when one is available. This collection is bounded and not paginated.")
            .kind(V1ResponseKind::Json)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![account_id()])
            .resp_desc("`data` is an array of achievement-set fields plus `sandboxId`, `achievementSetId`, `unlocked`, `unlockDate`, and an optional `offer` object.")
            .leg(&["/profiles/{id}/rare-achievements"]),
        op("getProfileRareAchievements", V1HttpMethod::Get, "/v1/profiles/{id}/rare-achievements/{sandboxId}", "Get rarest profile achievements for one sandbox", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Returns up to three of the rarest unlocked achievements for one sandbox, ordered by `completedPercent` ascending. This collection is bounded and not paginated.")
            .kind(V1ResponseKind::Json)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![account_id(), sandbox_id()])
            .resp_desc("`data` is an array of achievement-set fields plus `sandboxId`, `achievementSetId`, `unlocked`, and `unlockDate`.")
            .leg(&["/profiles/{id}/rare-achievements/{sandboxId}"]),
        op("getProfileInformation", V1HttpMethod::Get, "/v1/profiles/{id}/information", "Get profile details and statistics", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Returns the public Epic profile together with aggregate achievement statistics (games played, unlocked achievements, awards, total XP, reviews), the donation details stored for the account, and whether a Discord account is linked. This resource is not paginated.")
            .kind(V1ResponseKind::Json)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![account_id()])
            .resp_desc("`data` contains `epicAccountId`, `displayName`, `avatar`, `linkedAccounts`, `creationDate`, `stats` (`totalGames`, `totalAchievements`, `totalPlayerAwards`, `totalXP`, `reviewsCount`), `donations`, and `discord`.")
            .leg(&["/profiles/{id}/information"]),
        op("listProfileGames", V1HttpMethod::Get, "/v1/profiles/{id}/games", "List profile games", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Returns one achievement-completion summary per sandbox the profile has played, ordered by the selected `sort` with `sandboxId` as the unique tie-breaker. Use `filter` (`all`, `completed`, `near-platinum`, `in-progress`, or `platinum`) or `platinum=true` to narrow results. `meta.pagination` carries `limit`, `hasMore`, and `nextCursor`; the legacy `page` parameter is replaced by the cursor.")
            .kind(V1ResponseKind::Json)
            .page()
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![
                account_id(),
                cursor_parameter(),
                limit_parameter(100),
                query_parameter("sort", "Ordering of the games: `completion` (default), `alphabetical`, `xp`, or `achievements`.", json!({ "type": "string", "enum": ["completion", "alphabetical", "xp", "achievements"], "default": "completion" }), Some(false)),
                query_parameter("filter", "Optional completion filter: `all` (default), `completed`, `near-platinum`, `in-progress`, or `platinum`.", json!({ "type": "string", "enum": ["all", "completed", "near-platinum", "in-progress", "platinum"], "default": "all" }), Some(false)),
                query_parameter("platinum", "When true (and `filter` is omitted or `all`), only games with at least one platinum award are returned.", json!({ "type": "boolean", "default": false }), Some(false)),
            ])
            .resp_desc("`data.achievements` is the page of per-sandbox summaries with `sandboxId`, `totalUnlocked`, `totalXP`, `productAchievements`, `completionPercentage`, `baseOfferForSandbox`, and `product`. The key keeps the legacy name.")
            .leg(&["/profiles/{id}/games"]),
        op("getProfileRandomGame", V1HttpMethod::Get, "/v1/profiles/{id}/random-game", "Get a random owned game", &["Profiles"], V1Scope::ProfilesRead, V1AuthMode::Key)
            .desc("Returns the full offer for a game the profile has achievement data for. When `sandbox` is supplied, that game is returned instead of a random one. This resource is bounded and not paginated.")
            .kind(V1ResponseKind::Json)
            .policy(V1ExpensivePolicy::Heavy)
            .params(vec![account_id(), query_str("sandbox", "Optional sandbox ID. Returns that game instead of a random one.")])
            .resp_desc("`data` is the serialized offer document, including `id`, `namespace`, `title`, `productSlug`, and `keyImages`.")
            .leg(&["/profiles/{id}/random-game"]),
    ]
}

fn stats_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("getStats", V1HttpMethod::Get, "/v1/stats", "Catalog totals", &["Stats"], V1Scope::StatsRead, V1AuthMode::Key)
            .desc("Returns total document counts for offers, items, tags, assets, price-engine rows, changelogs, sandboxes, and products, plus the number of offers and items created in the current year. Counts are cached for one hour.")
            .kind(V1ResponseKind::Json)
            .params(vec![])
            .leg(&["/stats"]),
        op("getMonthlyReleaseStats", V1HttpMethod::Get, "/v1/stats/releases/monthly", "Monthly base-game releases", &["Stats"], V1Scope::StatsRead, V1AuthMode::Key)
            .desc("Returns the number of base-game releases per month since the Epic Games Store launch in December 2018. Pre-purchases and code-redemption-only offers are excluded. Results are cached for one day.")
            .kind(V1ResponseKind::Json)
            .params(vec![])
            .leg(&["/stats/releases/monthly"]),
        op("getYearlyReleaseStats", V1HttpMethod::Get, "/v1/stats/releases/yearly", "Yearly base-game releases", &["Stats"], V1Scope::StatsRead, V1AuthMode::Key)
            .desc("Returns the number of base-game releases per year since the Epic Games Store launch in December 2018. Pre-purchases and code-redemption-only offers are excluded. Results are cached for one day.")
            .kind(V1ResponseKind::Json)
            .params(vec![])
            .leg(&["/stats/releases/yearly"]),
        op("getMonthlyCreationStats", V1HttpMethod::Get, "/v1/stats/creations/monthly", "Monthly base-game creations", &["Stats"], V1Scope::StatsRead, V1AuthMode::Key)
            .desc("Returns the number of base-game offers created per month since December 2018. Pre-purchases and code-redemption-only offers are excluded. Results are cached for one day.")
            .kind(V1ResponseKind::Json)
            .params(vec![])
            .leg(&["/stats/creations/monthly"]),
        op("getYearlyCreationStats", V1HttpMethod::Get, "/v1/stats/creations/yearly", "Yearly base-game creations", &["Stats"], V1Scope::StatsRead, V1AuthMode::Key)
            .desc("Returns the number of base-game offers created per year since December 2018. Pre-purchases and code-redemption-only offers are excluded. Results are cached for one day.")
            .kind(V1ResponseKind::Json)
            .params(vec![])
            .leg(&["/stats/creations/yearly"]),
        op("getHomepageStats", V1HttpMethod::Get, "/v1/stats/homepage", "Homepage counters", &["Stats"], V1Scope::StatsRead, V1AuthMode::Key)
            .desc("Returns the counters shown on the egdata homepage: tracked offers, price changes observed in the last 72 hours, active discounts, and current giveaways. Counts are resolved for the Epic pricing region that contains `country`. Cookies are never used; `country` defaults to US.")
            .kind(V1ResponseKind::Json)
            .params(vec![country_parameter()])
            .leg(&["/stats/homepage"]),
    ]
}

fn franchises_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("getFranchise", V1HttpMethod::Get, "/v1/franchises/{slug}", "Get a franchise", &["Franchises"], V1Scope::OffersRead, V1AuthMode::Key)
            .desc("Returns a franchise and a cursor-paginated page of its offers, ordered by `releaseDate` descending with the offer `id` ascending as tie-breaker. Offers are localized with `locale` and priced for the Epic pricing region that contains `country`. The `stats` object aggregates achievements and time-to-beat data over every offer in the franchise, not only the returned page. Cookies are never used.")
            .kind(V1ResponseKind::Json)
            .page()
            .params(vec![
                path_parameter("slug", "Franchise slug, as used by `/franchises/{slug}`."),
                country_parameter(),
                locale_parameter(),
                cursor_parameter(),
                limit_parameter(100),
            ])
            .leg(&["/franchises/{slug}"]),
    ]
}

fn game_awards_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("getGameAwards", V1HttpMethod::Get, "/v1/game-awards", "The Game Awards modules", &["Game Awards"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Returns the storefront modules for The Game Awards event, each with its localized and expanded offers and current regional price. Modules are ordered by `moduleIndex`; modules without referenced offers are omitted. OG image generation remains outside v1.")
            .params(vec![country_parameter(), locale_parameter()])
            .resp_desc("`data` is an array of modules with `title`, `moduleIndex`, `moduleType`, and serialized `offers`.")
            .leg(&["/game-awards"]),
    ]
}

fn assets_operations() -> Vec<V1OperationMetadata> {
    vec![
        op("getAsset", V1HttpMethod::Get, "/v1/assets/{id}", "Get an asset", &["Assets"], V1Scope::CatalogRead, V1AuthMode::Key)
            .desc("Looks up a single catalog asset by its Epic Games artifact ID and returns the serialized asset document. Returns `404` when no asset matches.")
            .kind(V1ResponseKind::Json)
            .params(vec![path_parameter("id", "Epic Games artifact ID of the asset.")])
            .leg(&["/assets/{id}"]),
    ]
}

/// Returns the complete static slice of all 154 `/v1` operations.
pub fn v1_operations() -> &'static [V1OperationMetadata] {
    static OPERATIONS: OnceLock<Vec<V1OperationMetadata>> = OnceLock::new();
    OPERATIONS.get_or_init(|| {
        let mut ops = Vec::with_capacity(154);
        ops.extend(system_operations());
        ops.extend(catalog_operations());
        ops.extend(offers_operations());
        ops.extend(offer_details_operations());
        ops.extend(search_operations());
        ops.extend(multisearch_operations());
        ops.extend(native_operations());
        ops.extend(og_operations());
        ops.extend(items_operations());
        ops.extend(sellers_operations());
        ops.extend(sandboxes_operations());
        ops.extend(builds_operations());
        ops.extend(free_games_operations());
        ops.extend(promotions_operations());
        ops.extend(collections_operations());
        ops.extend(profiles_operations());
        ops.extend(stats_operations());
        ops.extend(franchises_operations());
        ops.extend(game_awards_operations());
        ops.extend(assets_operations());

        let mut ids = HashSet::new();
        let mut keys = HashSet::new();
        for entry in &ops {
            assert!(
                ids.insert(entry.operation_id.as_str()),
                "Duplicate v1 operationId: {}",
                entry.operation_id
            );
            let key = format!("{} {}", entry.method.as_str(), entry.path);
            assert!(keys.insert(key.clone()), "Duplicate v1 operation: {key}");
        }
        ops
    })
}

/// Maps each legacy route pattern to the `/v1` operation IDs that replace it.
pub fn v1_operations_by_legacy_path() -> BTreeMap<String, Vec<String>> {
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for entry in v1_operations() {
        for legacy in entry.legacy.iter().flatten() {
            map.entry(legacy.clone())
                .or_default()
                .push(entry.operation_id.clone());
        }
    }
    map
}

/// Returns all `/v1` operations excluding `image` and `xml` response kinds.
pub fn v1_public_operations() -> Vec<&'static V1OperationMetadata> {
    v1_operations()
        .iter()
        .filter(|op| {
            !matches!(
                op.response_kind,
                Some(V1ResponseKind::Image) | Some(V1ResponseKind::Xml)
            )
        })
        .collect()
}

/// Finds a `/v1` operation by its stable `operationId`.
pub fn find_operation(operation_id: &str) -> Option<&'static V1OperationMetadata> {
    v1_operations()
        .iter()
        .find(|entry| entry.operation_id == operation_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_154_operations_registered_and_unique() {
        let all = v1_operations();
        assert_eq!(all.len(), 154);

        let public = v1_public_operations();
        // 6 XML + 4 Image = 10 excluded -> 144 public operations
        assert_eq!(public.len(), 144);

        let legacy_map = v1_operations_by_legacy_path();
        assert_eq!(
            legacy_map.get("/search/v2/search").unwrap(),
            &vec![
                "searchOffers".to_string(),
                "searchOffersRedirect".to_string()
            ]
        );
        assert_eq!(
            legacy_map.get("/offers").unwrap(),
            &vec!["listOffers".to_string()]
        );

        let get_offer = find_operation("getOffer").unwrap();
        assert_eq!(get_offer.path, "/v1/offers/{id}");
        assert_eq!(get_offer.scope.as_str(), "offers:read");
        assert_eq!(get_offer.method.as_str(), "GET");
        assert_eq!(find_operation("nonExistent"), None);

        let hydrate = find_operation("hydrateCatalog").unwrap();
        assert_eq!(hydrate.method.as_str(), "POST");
        assert_eq!(hydrate.expensive_policy.unwrap().as_str(), "bulk");

        // Exercise all enum string helpers
        for scope in [
            V1Scope::CatalogRead,
            V1Scope::OffersRead,
            V1Scope::ItemsRead,
            V1Scope::SearchRead,
            V1Scope::ProfilesRead,
            V1Scope::StatsRead,
            V1Scope::BuildsRead,
        ] {
            assert!(!scope.as_str().is_empty());
        }
        for policy in [
            V1ExpensivePolicy::OffersList,
            V1ExpensivePolicy::Search,
            V1ExpensivePolicy::Heavy,
            V1ExpensivePolicy::Bulk,
        ] {
            assert!(!policy.as_str().is_empty());
        }
    }
}
