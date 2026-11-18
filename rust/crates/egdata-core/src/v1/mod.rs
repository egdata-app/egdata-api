//! Shared `/v1` API contracts, cursor tokens, pagination, query validation, serialization, and operation registry.

pub mod cursor;
pub mod errors;
pub mod iso_date;
pub mod operations;
pub mod pagination;
pub mod query;
pub mod serialization;

pub use cursor::{
    CursorBinding, CursorSortTuple, CursorSortValue, decode_cursor, decode_cursor_with,
    encode_cursor, encode_cursor_with, encode_cursor_with_filter_order, normalize_filters,
};
pub use errors::{
    PROBLEM_CONTENT_TYPE, ProblemDetail, ProblemError, ProblemIssue, ValidationIssue, bad_request,
    issues_to_problem_issues, not_found, problem_type, service_unavailable, status_title,
    unsupported_media_type,
};
pub use operations::{
    V1AuthMode, V1ExpensivePolicy, V1HttpMethod, V1OperationMetadata, V1Parameter,
    V1ParameterLocation, V1RequestBody, V1ResponseKind, V1Scope, find_operation, v1_operations,
    v1_operations_by_legacy_path, v1_public_operations,
};
pub use pagination::{
    DEFAULT_MAX_LIMIT, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, MongoSortField, NullsOrder, PageMeta,
    Pagination, SortDirection, TrimmedPage, mongo_keyset_filter, mongo_sort_spec, page_meta,
    parse_limit, parse_pagination, parse_pagination_map, trim_page,
};
pub use query::{
    COUNTRIES, CountryAndRegion, REGIONS, RegionDefinition, RegionalParams, SearchV2Facets,
    SearchV2Input, SearchV2PriceRange, SearchV2SortBy, SearchV2SortDir, canonical_country,
    canonical_locale, country_and_region, parse_boolean, parse_csv, parse_integer,
    parse_strict_query, region_for_country, regional_params, require_id_param,
    require_json_content_type, trim_js_whitespace,
};
pub use serialization::{
    DATE_FIELDS, ITEM_FIELDS, OFFER_FIELDS, PRICE_AMOUNT_FIELDS, attributes_to_object,
    bson_to_serialized_json, currency_precision, date_value, iso_or_null, localization_meta,
    serialize_item, serialize_offer, serialize_price, serialize_seller, serialize_value, string_id,
};
