//! RFC 9457 Problem Details error model for `/v1` routes.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Media type for RFC 9457 Problem Details responses.
pub const PROBLEM_CONTENT_TYPE: &str = "application/problem+json";

/// Individual validation or parameter issue in a Problem Details payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemIssue {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    pub code: String,
    pub message: String,
}

/// RFC 9457 Problem Details response body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemDetail {
    #[serde(rename = "type")]
    pub problem_type: String,
    pub title: String,
    pub status: u16,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<ProblemIssue>>,
}

/// Maps an HTTP status code to its standard reason phrase used as default problem title.
pub fn status_title(status: u16) -> &'static str {
    match status {
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "Error",
    }
}

/// Builds the canonical problem type URI for a machine-readable error code.
pub fn problem_type(code: &str) -> String {
    format!(
        "https://api.egdata.app/problems/{}",
        code.to_lowercase().replace('_', "-")
    )
}

/// Inner data for [`ProblemError`], boxed to keep `Result<_, ProblemError>` small.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProblemErrorInner {
    pub status: u16,
    pub code: String,
    pub title: String,
    pub detail: String,
    pub errors: Option<Vec<ProblemIssue>>,
    pub headers: Option<BTreeMap<String, String>>,
}

/// Domain error that renders to an RFC 9457 `application/problem+json` HTTP response.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", .0.detail)]
pub struct ProblemError(Box<ProblemErrorInner>);

impl std::ops::Deref for ProblemError {
    type Target = ProblemErrorInner;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl ProblemError {
    /// Creates a new `ProblemError` with the default title for `status`.
    pub fn new(status: u16, code: impl Into<String>, detail: impl Into<String>) -> Self {
        Self(Box::new(ProblemErrorInner {
            status,
            code: code.into(),
            title: status_title(status).to_string(),
            detail: detail.into(),
            errors: None,
            headers: None,
        }))
    }

    /// Overrides the default HTTP status title.
    pub fn with_title(mut self, title: impl Into<String>) -> Self {
        self.0.title = title.into();
        self
    }

    /// Attaches structured field/parameter issues.
    pub fn with_errors(mut self, errors: Vec<ProblemIssue>) -> Self {
        self.0.errors = Some(errors);
        self
    }

    /// Attaches extra HTTP response headers.
    pub fn with_headers(mut self, headers: BTreeMap<String, String>) -> Self {
        self.0.headers = Some(headers);
        self
    }

    /// Converts this error into an RFC 9457 `ProblemDetail` payload.
    pub fn to_problem_detail(
        &self,
        instance: Option<&str>,
        request_id: Option<&str>,
    ) -> ProblemDetail {
        let non_empty_request_id = request_id.filter(|id| !id.is_empty()).map(str::to_string);
        let non_empty_errors = self
            .0
            .errors
            .as_ref()
            .filter(|list| !list.is_empty())
            .cloned();
        ProblemDetail {
            problem_type: problem_type(&self.0.code),
            title: self.0.title.clone(),
            status: self.0.status,
            detail: self.0.detail.clone(),
            instance: instance.map(str::to_string),
            code: self.0.code.clone(),
            request_id: non_empty_request_id,
            errors: non_empty_errors,
        }
    }
}

/// Constructs a `400 Bad Request` problem error.
pub fn bad_request(
    code: impl Into<String>,
    detail: impl Into<String>,
    errors: Option<Vec<ProblemIssue>>,
) -> ProblemError {
    let mut err = ProblemError::new(400, code, detail);
    if let Some(issues) = errors {
        err = err.with_errors(issues);
    }
    err
}

/// Constructs a `404 Not Found` problem error.
pub fn not_found(code: impl Into<String>, detail: impl Into<String>) -> ProblemError {
    ProblemError::new(404, code, detail)
}

/// Constructs a `415 Unsupported Media Type` problem error.
pub fn unsupported_media_type(detail: impl Into<String>) -> ProblemError {
    ProblemError::new(415, "UNSUPPORTED_MEDIA_TYPE", detail)
}

/// Constructs a `503 Service Unavailable` problem error.
pub fn service_unavailable(code: impl Into<String>, detail: impl Into<String>) -> ProblemError {
    ProblemError::new(503, code, detail)
}

/// Raw validation issue input prior to RFC 9457 `ProblemIssue` normalization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationIssue {
    pub path: Vec<String>,
    pub message: String,
    pub code: Option<String>,
}

/// Maps validation issues to RFC 9457 `ProblemIssue` entries with JSON Pointer escaping.
pub fn issues_to_problem_issues(issues: &[ValidationIssue]) -> Vec<ProblemIssue> {
    issues
        .iter()
        .map(|issue| {
            let parameter = issue.path.first().cloned();
            let pointer = if issue.path.is_empty() {
                None
            } else {
                let escaped: Vec<String> = issue
                    .path
                    .iter()
                    .map(|part| part.replace('~', "~0").replace('/', "~1"))
                    .collect();
                Some(format!("/{}", escaped.join("/")))
            };
            let code = issue
                .code
                .as_deref()
                .map(str::to_uppercase)
                .unwrap_or_else(|| "INVALID".to_string());
            ProblemIssue {
                pointer,
                parameter,
                code,
                message: issue.message.clone(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_titles() {
        let cases = [
            (400, "Bad Request"),
            (401, "Unauthorized"),
            (403, "Forbidden"),
            (404, "Not Found"),
            (405, "Method Not Allowed"),
            (408, "Request Timeout"),
            (409, "Conflict"),
            (410, "Gone"),
            (413, "Content Too Large"),
            (415, "Unsupported Media Type"),
            (422, "Unprocessable Content"),
            (429, "Too Many Requests"),
            (500, "Internal Server Error"),
            (501, "Not Implemented"),
            (502, "Bad Gateway"),
            (503, "Service Unavailable"),
            (504, "Gateway Timeout"),
            (418, "Error"),
        ];
        for (status, expected) in cases {
            assert_eq!(status_title(status), expected);
        }
    }

    #[test]
    fn test_problem_type_formatting() {
        assert_eq!(
            problem_type("INVALID_QUERY"),
            "https://api.egdata.app/problems/invalid-query"
        );
        assert_eq!(
            problem_type("NOT_FOUND"),
            "https://api.egdata.app/problems/not-found"
        );
    }

    #[test]
    fn test_problem_error_constructors_and_detail() {
        let err = bad_request(
            "INVALID_LIMIT",
            "Bad limit",
            Some(vec![ProblemIssue {
                pointer: Some("/limit".into()),
                parameter: Some("limit".into()),
                code: "INVALID".into(),
                message: "Out of range".into(),
            }]),
        );
        assert_eq!(err.status, 400);
        assert_eq!(err.title, "Bad Request");
        assert_eq!(err.to_string(), "Bad limit");

        let detail = err.to_problem_detail(Some("/v1/offers"), Some("req-1"));
        let json = serde_json::to_value(&detail).unwrap();
        assert_eq!(
            json["type"],
            "https://api.egdata.app/problems/invalid-limit"
        );
        assert_eq!(json["title"], "Bad Request");
        assert_eq!(json["status"], 400);
        assert_eq!(json["detail"], "Bad limit");
        assert_eq!(json["instance"], "/v1/offers");
        assert_eq!(json["code"], "INVALID_LIMIT");
        assert_eq!(json["requestId"], "req-1");
        assert_eq!(json["errors"][0]["pointer"], "/limit");

        // Empty requestId and empty errors are omitted
        let mut headers = BTreeMap::new();
        headers.insert("Retry-After".into(), "60".into());
        let empty_err = ProblemError::new(429, "RATE_LIMITED", "Slow down")
            .with_title("Custom Limit")
            .with_errors(vec![])
            .with_headers(headers.clone());
        assert_eq!(empty_err.headers, Some(headers));
        let detail2 = empty_err.to_problem_detail(None, Some(""));
        let json2 = serde_json::to_value(&detail2).unwrap();
        assert_eq!(json2["title"], "Custom Limit");
        assert!(json2.get("requestId").is_none());
        assert!(json2.get("errors").is_none());
        assert!(json2.get("instance").is_none());

        assert_eq!(not_found("OFFER_NOT_FOUND", "Missing").status, 404);
        let umt = unsupported_media_type("Need JSON");
        assert_eq!(umt.status, 415);
        assert_eq!(umt.code, "UNSUPPORTED_MEDIA_TYPE");
        let su = service_unavailable("CURSOR_NOT_CONFIGURED", "No secret");
        assert_eq!(su.status, 503);
        assert_eq!(PROBLEM_CONTENT_TYPE, "application/problem+json");
    }

    #[test]
    fn test_issues_to_problem_issues() {
        let issues = vec![
            ValidationIssue {
                path: vec!["a/b".into(), "c~d".into()],
                message: "Bad field".into(),
                code: Some("custom_code".into()),
            },
            ValidationIssue {
                path: vec![],
                message: "Root bad".into(),
                code: None,
            },
        ];
        let mapped = issues_to_problem_issues(&issues);
        assert_eq!(mapped.len(), 2);
        assert_eq!(mapped[0].parameter.as_deref(), Some("a/b"));
        assert_eq!(mapped[0].pointer.as_deref(), Some("/a~1b/c~0d"));
        assert_eq!(mapped[0].code, "CUSTOM_CODE");
        assert_eq!(mapped[1].parameter, None);
        assert_eq!(mapped[1].pointer, None);
        assert_eq!(mapped[1].code, "INVALID");
    }
}
