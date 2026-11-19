//! GraphQL HTTP origin using the same middleware order as the Apollo/Hono bridge.
mod request;

use crate::{
    middleware::{
        edge_cache::edge_cache_headers,
        rate_limit::{general_rate_limit, graphql_rate_limit},
        request_logger::request_debug_logger,
        response_etag::response_etag,
        route_template::route_template,
    },
    state::AppState,
};
use async_graphql::{
    Request as GraphqlRequest, ServerError, Variables,
    dynamic::Schema,
    parser::types::{ExecutableDocument, OperationDefinition, OperationType},
};
use axum::{
    Router,
    body::Body,
    extract::{Extension, Request, State},
    http::{HeaderMap, Method, header},
    middleware,
    response::Response,
    routing::any,
};
use egdata_core::v1::serialization::node_json;
use egdata_graphql::{
    abuse_telemetry::AbuseTelemetry,
    persisted::{PersistedQueryRequest, PersistedQueryStore, apply_persisted_query},
    resolvers::GraphqlServices,
    schema::{CacheHints, build_schema},
    validation::{
        OperationError, VariableErrors, extract_error_http_status, validate_query_source,
    },
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const JSON: &str = "application/json; charset=utf-8";
const GRAPHQL_JSON: &str = "application/graphql-response+json; charset=utf-8";

struct GraphqlOrigin {
    schema: Schema,
    persisted: PersistedQueryStore,
}

pub(super) fn router(state: &AppState) -> Router<AppState> {
    let origin = Arc::new(GraphqlOrigin {
        schema: build_schema(state.config.graphql_introspection)
            .expect("canonical GraphQL schema must build"),
        persisted: PersistedQueryStore::new(state.graphql_cache.clone()),
    });
    Router::new()
        .route("/graphql", any(handle))
        .layer(Extension(origin))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            graphql_rate_limit,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            general_rate_limit,
        ))
        .layer(middleware::from_fn(edge_cache_headers))
        .layer(middleware::from_fn(route_template))
        .layer(middleware::from_fn(request_debug_logger))
        .layer(middleware::from_fn(response_etag))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            crate::middleware::anti_abuse::middleware,
        ))
}

struct HttpError {
    status: u16,
    message: String,
    code: &'static str,
    no_store: bool,
    allow: Option<&'static str>,
}
impl HttpError {
    fn bad(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            message: message.into(),
            code: "BAD_REQUEST",
            no_store: false,
            allow: None,
        }
    }
    fn status(mut self, status: u16) -> Self {
        self.status = status;
        self
    }
    fn allow(mut self, methods: &'static str) -> Self {
        self.allow = Some(methods);
        self
    }
    fn no_store(mut self) -> Self {
        self.no_store = true;
        self
    }
    fn code(mut self, code: &'static str) -> Self {
        self.code = code;
        self
    }
    fn response(self, mime: &'static str) -> Response {
        let body = json!({"errors":[{"message":self.message,"extensions":{"code":self.code}}]});
        let mut response = json_response(self.status, &body, mime, true);
        if self.no_store {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        }
        if let Some(methods) = self.allow {
            response
                .headers_mut()
                .insert(header::ALLOW, methods.parse().unwrap());
        }
        response
    }
}

fn json_response(status: u16, value: &Value, mime: &'static str, apollo: bool) -> Response {
    let mut text = node_json(value);
    if apollo {
        text.push('\n');
    }
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .body(Body::from(text))
        .unwrap()
}

async fn handle(
    State(state): State<AppState>,
    Extension(origin): Extension<Arc<GraphqlOrigin>>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let parsed = if parts.method == Method::GET {
        None
    } else {
        match body.collect().await {
            Ok(bytes) => serde_json::from_slice(&bytes.to_bytes()).ok(),
            Err(_) => None,
        }
    };
    let incoming = PersistedQueryRequest {
        method: parts.method.to_string(),
        search: parts.uri.query().unwrap_or_default().into(),
        body: parsed,
    };
    let apq = apply_persisted_query(&origin.persisted, incoming).await;
    if let Some(err) = apq.error {
        let mut response = json_response(err.status, &err.response_body(), JSON, false);
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
        return response;
    }
    let media = request::response_type(&parts.headers, &parts.method);
    if media == Some("text/html") {
        let template = if state.config.node_env == "production" {
            include_str!("landing-production.html")
        } else {
            include_str!("landing-development.html")
        };
        let nonce = hex::encode(Sha256::digest(uuid::Uuid::new_v4().to_string().as_bytes()));
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/html")
            .body(Body::from(template.replace("{{APOLLO_NONCE}}", &nonce)))
            .unwrap();
    }
    if !request::prevents_csrf(&parts.method, &parts.headers) {
        return HttpError::bad(request::CSRF_MESSAGE).response(media.unwrap_or(JSON));
    }
    let telemetry = parts
        .extensions
        .get::<crate::middleware::anti_abuse::AntiAbuseGraphql>()
        .cloned()
        .map(|sink| AbuseTelemetry::with_sink(move |resource| sink.record(resource)));
    let result = execute(
        &state,
        &origin,
        apq.request,
        &parts.headers,
        &parts.method,
        media,
        telemetry,
    )
    .await;
    result.unwrap_or_else(|error| error.response(media.unwrap_or(JSON)))
}

fn operation_for_http<'a>(
    doc: &'a ExecutableDocument,
    name: Option<&str>,
    method: &Method,
) -> Result<&'a OperationDefinition, HttpError> {
    let mut ops = doc.operations.iter();
    let operation = match name.filter(|s| !s.is_empty()) {
        Some(selected) => {
            ops.find(|(n, _)| n.is_some_and(|n| n.as_str() == selected))
                .ok_or_else(|| {
                    HttpError::bad(format!("Unknown operation named \"{selected}\"."))
                        .code("OPERATION_RESOLUTION_FAILURE")
                        .no_store()
                })?
                .1
        }
        None => {
            let operation = ops
                .next()
                .ok_or_else(|| {
                    HttpError::bad("Must provide an operation.")
                        .code("OPERATION_RESOLUTION_FAILURE")
                        .no_store()
                })?
                .1;
            if ops.next().is_some() {
                return Err(HttpError::bad(
                    "Must provide operation name if query contains multiple operations.",
                )
                .code("OPERATION_RESOLUTION_FAILURE")
                .no_store());
            }
            operation
        }
    };
    if method == Method::GET && operation.node.ty != OperationType::Query {
        return Err(HttpError::bad(format!(
            "GET requests only support query operations, not {} operations",
            operation.node.ty
        ))
        .status(405)
        .allow("POST")
        .no_store());
    }
    Ok(&operation.node)
}

async fn execute(
    state: &AppState,
    origin: &GraphqlOrigin,
    raw: PersistedQueryRequest,
    headers: &HeaderMap,
    method: &Method,
    media: Option<&'static str>,
    telemetry: Option<AbuseTelemetry>,
) -> Result<Response, HttpError> {
    let mut input = request::parse(raw, headers)?;
    let mut gql = GraphqlRequest::new(input.query);
    let mime = media.unwrap_or(JSON);
    if let Some(err) = validate_query_source(&gql.query) {
        return Ok(graphql_errors(vec![err], None, mime, "BAD_REQUEST", 400));
    }
    let doc = match gql.parsed_query() {
        Ok(doc) => doc,
        Err(err) => {
            return Ok(graphql_errors(
                vec![syntax_error(err, &gql.query)],
                None,
                mime,
                "GRAPHQL_PARSE_FAILED",
                400,
            ));
        }
    };
    let operation = match operation_for_http(doc, input.name.as_deref(), method) {
        Ok(operation) => operation,
        Err(http_error) => {
            // Apollo reports an invalid document before selecting its operation.
            let rejection = ServerError::new(http_error.message.clone(), None);
            let mut result = origin
                .schema
                .execute(
                    gql.variables(Variables::from_json(input.variables))
                        .data(OperationError(rejection)),
                )
                .await;
            // GraphQL-js checks for a missing mutation/subscription root at
            // execution, after selecting an operation and checking the HTTP method.
            result.errors.retain(|error| {
                !matches!(
                    error.message.as_str(),
                    "Schema is not configured for mutations."
                        | "Schema is not configured for subscriptions."
                )
            });
            if result.errors.is_empty()
                || (result.errors.len() == 1 && result.errors[0].message == http_error.message)
            {
                return Err(http_error);
            }
            return Ok(graphql_errors(
                result.errors,
                None,
                mime,
                "GRAPHQL_VALIDATION_FAILED",
                400,
            ));
        }
    };
    let variable_errors = VariableErrors::for_operation(operation, &mut input.variables);
    gql = gql
        .variables(Variables::from_json(input.variables))
        .data(variable_errors);
    if let Some(name) = input.name {
        gql = gql.operation_name(name);
    }
    let hints = CacheHints::default();
    let mut services =
        GraphqlServices::new(state.mongo.clone(), state.cache.clone(), state.epic.clone());
    services.now = state.now;
    if let Some(telemetry) = telemetry {
        gql = gql.data(telemetry);
    }
    let result = origin
        .schema
        .execute(gql.data(Arc::new(services)).data(hints.clone()))
        .await;
    let mime=media.ok_or_else(||HttpError::bad(format!("An 'accept' header was provided for this request which does not accept {JSON} or {GRAPHQL_JSON}")).status(406))?;
    let data = result.data.into_json().unwrap_or(Value::Null);
    if !result.errors.is_empty() {
        let executed = result.errors.iter().any(|error| !error.path.is_empty());
        return Ok(if executed {
            graphql_errors(
                result.errors,
                Some(data),
                mime,
                "INTERNAL_SERVER_ERROR",
                200,
            )
        } else {
            graphql_errors(result.errors, None, mime, "GRAPHQL_VALIDATION_FAILED", 400)
        });
    }
    let mut response = json_response(200, &json!({"data":data}), mime, true);
    let headers = response.headers_mut();
    if method == Method::GET
        && let Some(age) = hints.max_age().filter(|age| *age > 0)
    {
        let stale = age.saturating_mul(10).clamp(60, 3600);
        headers.insert(
            header::CACHE_CONTROL,
            format!("public, max-age={age}, s-maxage={age}, stale-while-revalidate={stale}")
                .parse()
                .unwrap(),
        );
        headers.insert(
            "cdn-cache-control",
            format!("public, max-age={age}, stale-while-revalidate={stale}")
                .parse()
                .unwrap(),
        );
        headers.insert(header::VARY, "Accept-Encoding".parse().unwrap());
    } else {
        headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    Ok(response)
}

fn syntax_error(mut error: ServerError, source: &str) -> ServerError {
    if error
        .message
        .lines()
        .last()
        .is_some_and(|line| line.trim() == "= expected name")
        && let Some(pos) = error.locations.first()
    {
        let found = source
            .split('\n')
            .nth(pos.line.saturating_sub(1))
            .and_then(|line| line.chars().nth(pos.column.saturating_sub(1)));
        let token = found.map_or_else(|| "<EOF>".to_string(), |c| format!("\"{c}\""));
        error.message = format!("Syntax Error: Expected Name, found {token}.");
    }
    error
}

fn graphql_errors(
    errors: Vec<ServerError>,
    data: Option<Value>,
    mime: &'static str,
    code: &str,
    default_status: u16,
) -> Response {
    let status = errors
        .iter()
        .find_map(extract_error_http_status)
        .unwrap_or(default_status);
    let errors = errors
        .into_iter()
        .map(|mut err| {
            if code == "GRAPHQL_VALIDATION_FAILED"
                && let Some(field) = err.message.strip_prefix("Unknown field ")
            {
                err.message = format!("Cannot query field {field}");
            }
            let mut formatted = serde_json::to_value(err).unwrap();
            if !formatted["extensions"].is_object() {
                formatted["extensions"] = json!({});
            }
            let extensions = formatted["extensions"].as_object_mut().unwrap();
            extensions.shift_remove("http");
            // Apollo labels validation-rule failures at the HTTP boundary and
            // places its code before the rule's remaining extension fields.
            if code == "GRAPHQL_VALIDATION_FAILED"
                && matches!(
                    extensions.get("code").and_then(Value::as_str),
                    Some("QUERY_ALIAS_LIMIT_EXCEEDED" | "QUERY_DEPTH_EXCEEDED")
                )
            {
                extensions.shift_remove("code");
                extensions.shift_insert(0, "code".into(), json!(code));
            } else {
                extensions.entry("code").or_insert_with(|| json!(code));
            }
            formatted
        })
        .collect::<Vec<_>>();
    let mut body = json!({"errors":errors});
    if let Some(data) = data {
        body["data"] = data;
    }
    let mut response = json_response(status, &body, mime, true);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ApiConfig;
    use egdata_api_test_support::test_app_state;
    use tower::ServiceExt;

    #[tokio::test]
    async fn graphql_http_records_only_executed_fields_with_coerced_ids() {
        use crate::middleware::anti_abuse::AntiAbuseGraphql;
        let state = test_app_state(ApiConfig::default());
        let app = router(&state).with_state(state);
        let id = "0123456789abcdef0123456789abcdef";
        let payload = json!({"query":"query OfferPage($id: ID!) { selected: offer(id:$id){id} ignored:item(id:1) @skip(if:true){id} other:item(id:7){id} } query Other {events{id}}","operationName":"OfferPage","variables":{"id":id}});
        let sink = AntiAbuseGraphql::default();
        let req = Request::builder()
            .method(Method::POST)
            .uri("/graphql")
            .header(header::CONTENT_TYPE, "application/json")
            .extension(sink.clone())
            .body(Body::from(payload.to_string()))
            .unwrap();
        assert_eq!(app.oneshot(req).await.unwrap().status(), 200);
        let resources = sink.take();
        assert_eq!(resources.len(), 2);
        let offer = resources
            .iter()
            .find(|r| r.route == "/graphql/Query.offer")
            .unwrap();
        assert_eq!(offer.hydration_route.as_deref(), Some("graphql:OfferPage"));
        assert_eq!(offer.hydration_id.as_deref(), Some(id));
        let item = resources
            .iter()
            .find(|r| r.route == "/graphql/Query.item")
            .unwrap();
        assert_eq!(item.item_id.as_deref(), Some("7"));
    }

    #[tokio::test]
    async fn landing_page_node_oracle() {
        for (environment, template) in [
            ("development", include_str!("landing-development.html")),
            ("production", include_str!("landing-production.html")),
        ] {
            let state = test_app_state(ApiConfig {
                node_env: environment.to_owned(),
                ..ApiConfig::default()
            });
            let app = router(&state).with_state(state);
            let mut previous = String::new();
            for accept in ["text/html", "text/*;q=0.9,application/json;q=0.1"] {
                let request = Request::builder()
                    .uri("/graphql")
                    .header(header::ACCEPT, accept)
                    .body(Body::empty())
                    .unwrap();
                let response = app.clone().oneshot(request).await.unwrap();
                assert_eq!(response.status(), 200);
                assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html");
                let body = String::from_utf8(
                    response
                        .into_body()
                        .collect()
                        .await
                        .unwrap()
                        .to_bytes()
                        .to_vec(),
                )
                .unwrap();
                let nonce = &body.split_once("'nonce-").unwrap().1[..64];
                assert!(nonce.bytes().all(|b| b.is_ascii_hexdigit()));
                assert_ne!(previous, nonce);
                assert_eq!(body, template.replace("{{APOLLO_NONCE}}", nonce));
                previous = nonce.to_owned();
            }
        }
    }
}
