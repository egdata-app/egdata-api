//! Pagination parsing, page trimming, and MongoDB keyset filter helpers for `/v1`.

use bson::{Bson, Document, doc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::errors::{ProblemError, bad_request};

pub const DEFAULT_PAGE_LIMIT: u32 = 20;
pub const MAX_PAGE_LIMIT: u32 = 100;
pub const DEFAULT_MAX_LIMIT: u32 = MAX_PAGE_LIMIT;

/// Parses a positive integer `limit` parameter bounded by `maximum`.
pub fn parse_limit(raw: Option<&str>, maximum: u32) -> Result<u32, ProblemError> {
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Ok(DEFAULT_PAGE_LIMIT);
    };
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(bad_request(
            "INVALID_LIMIT",
            format!("The `limit` parameter must be an integer between 1 and {maximum}."),
            None,
        ));
    }
    let value: u64 = raw.parse().map_err(|_| {
        bad_request(
            "INVALID_LIMIT",
            format!("The `limit` parameter must be an integer between 1 and {maximum}."),
            None,
        )
    })?;
    if value < 1 || value > u64::from(maximum) {
        return Err(bad_request(
            "INVALID_LIMIT",
            format!("The `limit` parameter must be an integer between 1 and {maximum}."),
            None,
        ));
    }
    Ok(value as u32)
}

/// Parsed cursor pagination query parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pagination {
    pub limit: u32,
    pub cursor: Option<String>,
}

/// Parses `limit` and `cursor` query parameters with length validation.
pub fn parse_pagination(
    limit_raw: Option<&str>,
    cursor_raw: Option<&str>,
    maximum: u32,
) -> Result<Pagination, ProblemError> {
    let limit = parse_limit(limit_raw, maximum)?;
    let cursor = cursor_raw
        .map(super::trim_js_whitespace)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(ref token) = cursor
        && token.encode_utf16().count() > 4096
    {
        return Err(bad_request(
            "INVALID_CURSOR",
            "The cursor is too long.",
            None,
        ));
    }
    Ok(Pagination { limit, cursor })
}

/// Convenience helper for parsing pagination from a query parameter map.
pub fn parse_pagination_map(
    query: &BTreeMap<String, String>,
    maximum: u32,
) -> Result<Pagination, ProblemError> {
    parse_pagination(
        query.get("limit").map(String::as_str),
        query.get("cursor").map(String::as_str),
        maximum,
    )
}

/// Standard `/v1` `meta.pagination` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub limit: u32,
    pub has_more: bool,
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub total: serde_json::Value,
}

impl PageMeta {
    pub fn with_total(mut self, total: impl Into<serde_json::Value>) -> Self {
        self.total = total.into();
        self
    }
}

/// Constructs a `PageMeta` struct.
pub fn page_meta(limit: u32, has_more: bool, next_cursor: Option<String>) -> PageMeta {
    PageMeta {
        limit,
        has_more,
        next_cursor,
        total: serde_json::Value::Null,
    }
}

/// Result of fetching `limit + 1` rows and trimming to `limit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrimmedPage<T> {
    pub items: Vec<T>,
    pub has_more: bool,
}

/// Fetches `limit + 1` docs for an "is there another page" check, then trims.
pub fn trim_page<T>(mut rows: Vec<T>, limit: usize) -> TrimmedPage<T> {
    if rows.len() > limit {
        rows.truncate(limit);
        TrimmedPage {
            items: rows,
            has_more: true,
        }
    } else {
        TrimmedPage {
            items: rows,
            has_more: false,
        }
    }
}

/// Sort direction for MongoDB sort specifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortDirection {
    Asc = 1,
    Desc = -1,
}

/// Explicit null ordering in a keyset sort field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NullsOrder {
    First,
    Last,
}

/// Keyset sort field descriptor used to build MongoDB filters and sort specs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MongoSortField {
    pub field: String,
    pub direction: SortDirection,
    pub nulls: NullsOrder,
}

impl MongoSortField {
    pub fn new(field: impl Into<String>, direction: SortDirection, nulls: NullsOrder) -> Self {
        Self {
            field: field.into(),
            direction,
            nulls,
        }
    }
}

// The Node driver writes undefined query operands as BSON null after the
// keyset builder has decided whether the JavaScript value strictly equals null.
fn query_operand(value: &Bson) -> &Bson {
    if matches!(value, Bson::Undefined) {
        &Bson::Null
    } else {
        value
    }
}

fn equal_condition(field: &str, value: &Bson) -> Document {
    if matches!(value, Bson::Null) {
        doc! { field: Bson::Null }
    } else {
        doc! { field: { "$eq": query_operand(value).clone() } }
    }
}

/// Builds the lexicographic "after this tuple" filter for a MongoDB keyset scan.
///
/// Null/missing ordering is explicit so a cursor can never skip or repeat
/// documents containing null sort values.
pub fn mongo_keyset_filter(
    sort: &[MongoSortField],
    last: &[Bson],
) -> Result<Document, ProblemError> {
    if sort.is_empty() || sort.len() != last.len() {
        return Err(bad_request(
            "INVALID_CURSOR",
            "The cursor sort tuple is invalid.",
            None,
        ));
    }

    let mut clauses: Vec<Document> = Vec::new();

    for (index, entry) in sort.iter().enumerate() {
        let field = entry.field.as_str();
        let value = &last[index];
        let comparison = match entry.direction {
            SortDirection::Desc => "$lt",
            SortDirection::Asc => "$gt",
        };
        let mut alternatives: Vec<Document> = Vec::new();

        if matches!(value, Bson::Null) {
            if entry.nulls == NullsOrder::First {
                // Every non-null value sorts after the null group.
                alternatives.push(doc! { field: { "$ne": Bson::Null } });
            }
        } else {
            alternatives.push(doc! { field: { comparison: query_operand(value).clone() } });
            if entry.nulls == NullsOrder::Last {
                // Nulls sort after every non-null value in this direction.
                alternatives.push(doc! { field: Bson::Null });
            }
        }

        let prefix: Vec<Document> = (0..index)
            .map(|prior| equal_condition(&sort[prior].field, &last[prior]))
            .collect();

        for alternative in alternatives {
            if prefix.is_empty() {
                clauses.push(alternative);
            } else {
                let mut and_terms = prefix.clone();
                and_terms.push(alternative);
                clauses.push(doc! { "$and": and_terms });
            }
        }
    }

    if clauses.is_empty() {
        // The final tuple has nothing after it; return an impossible filter.
        return Ok(doc! { "_id": { "$exists": false } });
    }

    if clauses.len() == 1 {
        Ok(clauses.into_iter().next().unwrap_or_default())
    } else {
        Ok(doc! { "$or": clauses })
    }
}

/// Builds an ordered MongoDB sort document from keyset sort fields.
pub fn mongo_sort_spec(sort: &[MongoSortField]) -> Document {
    let mut spec = Document::new();
    for entry in sort {
        spec.insert(entry.field.clone(), entry.direction as i32);
    }
    spec
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_limit() {
        assert_eq!(parse_limit(None, MAX_PAGE_LIMIT).unwrap(), 20);
        assert_eq!(parse_limit(Some(""), MAX_PAGE_LIMIT).unwrap(), 20);
        assert_eq!(parse_limit(Some("1"), MAX_PAGE_LIMIT).unwrap(), 1);
        assert_eq!(parse_limit(Some("100"), MAX_PAGE_LIMIT).unwrap(), 100);

        for invalid in ["0", "-1", "101", "abc", " 10", "99999999999999999999999"] {
            let err = parse_limit(Some(invalid), MAX_PAGE_LIMIT).unwrap_err();
            assert_eq!(err.code, "INVALID_LIMIT");
        }
    }

    #[test]
    fn test_parse_pagination_and_meta_and_trim() {
        let mut q = BTreeMap::new();
        q.insert("limit".into(), "15".into());
        q.insert("cursor".into(), "  tok  ".into());
        let p = parse_pagination_map(&q, MAX_PAGE_LIMIT).unwrap();
        assert_eq!(p.limit, 15);
        assert_eq!(p.cursor.as_deref(), Some("tok"));
        let multibyte = "Ω".repeat(4096);
        assert_eq!(
            parse_pagination(
                None,
                Some(&format!("\u{feff}{multibyte}\u{feff}")),
                MAX_PAGE_LIMIT
            )
            .unwrap()
            .cursor,
            Some(multibyte)
        );

        let long = "a".repeat(4097);
        let err = parse_pagination(None, Some(&long), MAX_PAGE_LIMIT).unwrap_err();
        assert_eq!(err.code, "INVALID_CURSOR");
        assert_eq!(
            parse_pagination(Some("0"), None, MAX_PAGE_LIMIT)
                .unwrap_err()
                .code,
            "INVALID_LIMIT"
        );

        let meta = page_meta(15, true, Some("next".into()));
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["limit"], 15);
        assert_eq!(json["hasMore"], true);
        assert_eq!(json["nextCursor"], "next");
        assert_eq!(json.get("total"), Some(&serde_json::Value::Null));
        assert_eq!(meta.with_total(0).total, 0);

        let trimmed = trim_page(vec![1, 2, 3], 2);
        assert_eq!(trimmed.items, vec![1, 2]);
        assert!(trimmed.has_more);

        let exact = trim_page(vec![1, 2], 2);
        assert_eq!(exact.items, vec![1, 2]);
        assert!(!exact.has_more);
    }

    #[test]
    fn test_mongo_keyset_filter_and_sort_spec() {
        let sort = vec![
            MongoSortField::new("lastModifiedDate", SortDirection::Desc, NullsOrder::Last),
            MongoSortField::new("id", SortDirection::Asc, NullsOrder::First),
        ];

        assert_eq!(
            mongo_sort_spec(&sort),
            doc! { "lastModifiedDate": -1, "id": 1 }
        );

        // Mismatched tuple length or empty sort
        assert_eq!(
            mongo_keyset_filter(&[], &[]).unwrap_err().code,
            "INVALID_CURSOR"
        );
        assert_eq!(
            mongo_keyset_filter(&sort, &[Bson::Int32(1)])
                .unwrap_err()
                .code,
            "INVALID_CURSOR"
        );

        // Non-null first (nulls last), non-null second (nulls first)
        let f1 = mongo_keyset_filter(
            &sort,
            &[
                Bson::String("2025-01-01".into()),
                Bson::String("abc".into()),
            ],
        )
        .unwrap();
        assert_eq!(
            f1,
            doc! {
                "$or": [
                    { "lastModifiedDate": { "$lt": "2025-01-01" } },
                    { "lastModifiedDate": Bson::Null },
                    { "$and": [ { "lastModifiedDate": { "$eq": "2025-01-01" } }, { "id": { "$gt": "abc" } } ] }
                ]
            }
        );

        // Null first (nulls last -> no alternative for field 0), non-null second
        let f2 = mongo_keyset_filter(&sort, &[Bson::Null, Bson::String("abc".into())]).unwrap();
        assert_eq!(
            f2,
            doc! {
                "$and": [
                    { "lastModifiedDate": Bson::Null },
                    { "id": { "$gt": "abc" } }
                ]
            }
        );

        // Null first (nulls first -> $ne: null), null second (nulls last -> no alternative)
        let sort_nulls_first = vec![
            MongoSortField::new("a", SortDirection::Asc, NullsOrder::First),
            MongoSortField::new("b", SortDirection::Desc, NullsOrder::Last),
        ];
        let f3 = mongo_keyset_filter(&sort_nulls_first, &[Bson::Null, Bson::Null]).unwrap();
        assert_eq!(f3, doc! { "a": { "$ne": Bson::Null } });

        // All null with nulls last -> impossible filter
        let single_nulls_last = vec![MongoSortField::new(
            "a",
            SortDirection::Desc,
            NullsOrder::Last,
        )];
        let f4 = mongo_keyset_filter(&single_nulls_last, &[Bson::Null]).unwrap();
        assert_eq!(f4, doc! { "_id": { "$exists": false } });
        let missing =
            mongo_keyset_filter(&sort, &[Bson::Undefined, Bson::String("a".into())]).unwrap();
        assert_eq!(
            missing,
            doc! {
                "$or": [
                    {"lastModifiedDate":{"$lt":Bson::Null}},
                    {"lastModifiedDate":Bson::Null},
                    {"$and":[{"lastModifiedDate":{"$eq":Bson::Null}},{"id":{"$gt":"a"}}]}
                ]
            }
        );
    }
}
