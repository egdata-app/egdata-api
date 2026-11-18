//! Normalize the Hono/Apollo HTTP request before GraphQL parsing.
use super::{GRAPHQL_JSON, HttpError, JSON};
use axum::http::{HeaderMap, Method, header};
use egdata_graphql::persisted::PersistedQueryRequest;
use serde_json::Value;

pub(super) struct Operation {
    pub query: String,
    pub name: Option<String>,
    pub variables: Value,
}

fn header_value<'a>(headers: &'a HeaderMap, key: &str) -> Option<std::borrow::Cow<'a, str>> {
    // Fetch Headers combines repeated fields before Hono passes them to Apollo.
    let mut values = headers.get_all(key).iter().map(|value| {
        value
            .to_str()
            .map(std::borrow::Cow::Borrowed)
            .unwrap_or_else(|_| {
                std::borrow::Cow::Owned(value.as_bytes().iter().copied().map(char::from).collect())
            })
    });
    let mut combined = values.next()?;
    for value in values {
        combined.to_mut().push_str(", ");
        combined.to_mut().push_str(&value);
    }
    Some(combined)
}

pub(super) fn prevents_csrf(method: &Method, headers: &HeaderMap) -> bool {
    if method == Method::GET {
        return true;
    }
    if let Some(content_type) = header_value(headers, "content-type") {
        let media = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if !matches!(
            media.as_str(),
            "text/plain" | "application/x-www-form-urlencoded" | "multipart/form-data"
        ) {
            return true;
        }
    }
    ["apollo-require-preflight", "x-apollo-operation-name"]
        .iter()
        .any(|name| header_value(headers, name).is_some_and(|s| !s.is_empty()))
}

pub(super) const CSRF_MESSAGE: &str = "This operation has been blocked as a potential Cross-Site Request Forgery (CSRF). Please either specify a 'content-type' header (with a type that is not one of application/x-www-form-urlencoded, multipart/form-data, text/plain) or provide a non-empty value for one of the following headers: x-apollo-operation-name, apollo-require-preflight\n";

type Representation = (&'static str, MediaRange<'static>);

fn representations<const N: usize>(types: [&'static str; N]) -> [Representation; N] {
    types.map(|mime| {
        (
            mime,
            MediaRange::parse(mime).expect("valid built-in Apollo media type"),
        )
    })
}

/// Apollo checks landing-page preferences on GET before choosing a single-result representation.
pub(super) fn response_type(headers: &HeaderMap, method: &Method) -> Option<&'static str> {
    use std::sync::LazyLock;
    static SINGLE: LazyLock<[Representation; 3]> = LazyLock::new(|| {
        representations([
            JSON,
            GRAPHQL_JSON,
            "application/json; callbackSpec=1.0; charset=utf-8",
        ])
    });
    static LANDING: LazyLock<[Representation; 6]> = LazyLock::new(|| {
        representations([
            JSON,
            GRAPHQL_JSON,
            "multipart/mixed; deferspec=20220824",
            "multipart/mixed; incrementalspec=v0.2",
            "multipart/mixed",
            "text/html",
        ])
    });
    let Some(accept) = header_value(headers, "accept") else {
        return Some(JSON);
    };
    if matches!(accept.as_ref(), "" | "*/*" | "application/json") {
        return Some(JSON);
    }
    let ranges: Vec<_> = split_quoted(&accept, ',')
        .filter_map(MediaRange::parse)
        .collect();
    if method == Method::GET && negotiate(&ranges, &*LANDING) == Some("text/html") {
        return Some("text/html");
    }
    negotiate(&ranges, &*SINGLE)
}

// Apollo's Negotiator splits on commas and semicolons outside quoted values.
fn split_quoted(input: &str, separator: char) -> impl Iterator<Item = &str> {
    let mut quoted = false;
    input.split(move |c| {
        if c == '"' {
            quoted = !quoted;
        }
        c == separator && !quoted
    })
}

struct MediaRange<'a> {
    major: &'a str,
    minor: &'a str,
    parameters: Vec<(&'a str, &'a str)>,
    quality: f64,
}

impl<'a> MediaRange<'a> {
    fn parse(input: &'a str) -> Option<Self> {
        let mut parts = split_quoted(input, ';');
        let (major, minor) = parts.next().unwrap().trim().split_once('/')?;
        if major.is_empty()
            || minor.is_empty()
            || major.contains(char::is_whitespace)
            || minor.contains(char::is_whitespace)
        {
            return None;
        }
        let mut parameters: Vec<(&str, &str)> = Vec::new();
        let mut quality = 1.0;
        for part in parts {
            let part = part.trim();
            let (key, value) = part.split_once('=').unwrap_or((part, ""));
            let value = value
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or(value);
            if key.eq_ignore_ascii_case("q") {
                // The Node library uses parseFloat, which also accepts a numeric prefix.
                static PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                    regex::Regex::new(
                        r"^[+-]?(?:Infinity|(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)",
                    )
                    .unwrap()
                });
                quality = PREFIX
                    .find(value.trim_start())
                    .and_then(|v| v.as_str().parse().ok())
                    .unwrap_or(f64::NAN);
                break;
            }
            if let Some(pair) = parameters
                .iter_mut()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
            {
                pair.1 = value;
            } else {
                parameters.push((key, value));
            }
        }
        Some(Self {
            major,
            minor,
            parameters,
            quality,
        })
    }

    fn specificity(&self, offered: &Self) -> Option<u8> {
        let mut score = 0;
        for (pattern, value, weight) in [
            (self.major, offered.major, 4),
            (self.minor, offered.minor, 2),
        ] {
            if pattern.eq_ignore_ascii_case(value) {
                score += weight;
            } else if pattern != "*" {
                return None;
            }
        }
        for (key, value) in &self.parameters {
            let provided = offered
                .parameters
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map_or("", |(_, v)| *v);
            if *value != "*" && !value.eq_ignore_ascii_case(provided) {
                return None;
            }
        }
        Some(score + u8::from(!self.parameters.is_empty()))
    }
}

fn negotiate(
    ranges: &[MediaRange<'_>],
    representations: &[Representation],
) -> Option<&'static str> {
    use std::cmp::Ordering;
    let mut best = None;
    for (offered, representation) in representations {
        // For each representation the most specific matching range supplies its quality.
        // Equivalent duplicate ranges use the later occurrence in the Accept header.
        let chosen = ranges
            .iter()
            .enumerate()
            .filter_map(|(i, range)| Some((range.specificity(representation)?, range.quality, i)))
            .max_by(|a, b| {
                a.0.cmp(&b.0)
                    .then_with(|| a.1.partial_cmp(&b.1).unwrap_or(Ordering::Equal))
                    .then(a.2.cmp(&b.2))
            });
        if let Some((specificity, quality, index)) = chosen
            && quality > 0.0
        {
            // Across representations prefer quality, specificity, then earlier header order.
            let priority = (quality, specificity, std::cmp::Reverse(index));
            if best.is_none_or(|(previous, _)| priority > previous) {
                best = Some((priority, *offered));
            }
        }
    }
    best.map(|(_, mime)| mime)
}

pub(super) fn parse(
    req: PersistedQueryRequest,
    headers: &HeaderMap,
) -> Result<Operation, HttpError> {
    match req.method.as_str() {
        "GET" => parse_get(&req.search, headers),
        "POST" => parse_post(req.body.as_ref()),
        _ => Err(
            HttpError::bad("Apollo Server supports only GET/POST requests.")
                .status(405)
                .allow("GET, POST"),
        ),
    }
}

fn missing_query() -> HttpError {
    HttpError::bad(
        "GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension.",
    )
    .no_store()
}

fn parse_get(search: &str, headers: &HeaderMap) -> Result<Operation, HttpError> {
    if let Some(content_type) = header_value(headers, header::CONTENT_TYPE.as_str())
        && !content_type
            .split(';')
            .next()
            .is_some_and(|s| s.trim().eq_ignore_ascii_case("application/json"))
    {
        return Err(HttpError::bad(
            "GET requests may not have a content-type header other than application/json.",
        )
        .status(415));
    }
    let pairs: Vec<_> =
        url::form_urlencoded::parse(search.trim_start_matches('?').as_bytes()).collect();
    let param = |name: &str| -> Result<Option<&str>, HttpError> {
        let mut matching = pairs.iter().filter(|(key, _)| key == name);
        let first = matching.next().map(|(_, v)| v.as_ref());
        if matching.next().is_some() {
            return Err(HttpError::bad(format!(
                "The '{name}' search parameter may only be specified once."
            )));
        }
        Ok(first)
    };
    let object = |key: &str| -> Result<Value, HttpError> {
        let Some(raw) = param(key)? else {
            return Ok(Value::Null);
        };
        let val: Value = serde_json::from_str(raw).map_err(|_| {
            HttpError::bad(format!("The {key} search parameter contains invalid JSON."))
        })?;
        if !val.is_object() {
            return Err(HttpError::bad(format!(
                "The {key} search parameter should contain a JSON-encoded object."
            )));
        }
        Ok(val)
    };
    let query = param("query")?;
    let name = param("operationName")?.map(str::to_string);
    let variables = object("variables")?;
    object("extensions")?;
    Ok(Operation {
        query: query
            .filter(|s| !s.is_empty())
            .ok_or_else(missing_query)?
            .into(),
        name,
        variables,
    })
}

fn parse_post(body: Option<&Value>) -> Result<Operation, HttpError> {
    if body.is_some_and(Value::is_array) {
        return Err(HttpError::bad("Operation batching disabled."));
    }
    let obj = body
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty())
        .ok_or_else(|| {
            HttpError::bad("POST body missing, invalid Content-Type, or JSON object has no keys.")
        })?;
    let query = obj.get("query");
    if let Some(value) = query
        && !(value.is_null()
            || value.is_string()
            || value == &Value::Bool(false)
            || value.as_f64() == Some(0.0))
    {
        if value.get("kind").and_then(Value::as_str) == Some("Document") {
            return Err(HttpError::bad(
                "GraphQL queries must be strings. It looks like you're sending the internal graphql-js representation of a parsed query in your request instead of a request in the GraphQL query language. You can convert an AST to a string using the `print` function from `graphql`, or use a client like `apollo-client` which converts the internal representation to a string for you.",
            ));
        }
        return Err(HttpError::bad("GraphQL queries must be strings."));
    }
    for key in ["variables", "extensions"] {
        if obj.get(key).is_some_and(Value::is_string) {
            return Err(HttpError::bad(format!(
                "`{key}` in a POST body should be provided as an object, not a recursively JSON-encoded string."
            )));
        }
    }
    for key in ["extensions", "variables"] {
        if obj.get(key).is_some_and(|v| !v.is_null() && !v.is_object()) {
            return Err(HttpError::bad(format!(
                "`{key}` in a POST body must be an object if provided."
            )));
        }
    }
    let name = obj.get("operationName");
    if name.is_some_and(|v| !v.is_null() && !v.is_string()) {
        return Err(HttpError::bad(
            "`operationName` in a POST body must be a string if provided.",
        ));
    }
    Ok(Operation {
        query: query
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(missing_query)?
            .into(),
        name: name.and_then(Value::as_str).map(str::to_owned),
        variables: obj.get("variables").cloned().unwrap_or(Value::Null),
    })
}
