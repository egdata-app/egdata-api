//! GraphQL field-level abuse telemetry matching `src/graphql/abuse-telemetry.ts`.

use std::sync::{Arc, Mutex};

use async_graphql::extensions::{
    Extension, ExtensionContext, ExtensionFactory, NextExecute, NextParseQuery,
};
use async_graphql::parser::types::ExecutableDocument;
use async_graphql::{Response, ServerResult, Variables};
use async_trait::async_trait;
use egdata_core::abuse::AbuseResource;
use serde_json::Value;

/// Maximum number of telemetry resources recorded per GraphQL request.
pub const MAX_ABUSE_TELEMETRY_EVENTS: usize = 32;

/// Maximum length preserved for `itemId` in GraphQL telemetry resources.
pub const MAX_ITEM_ID_LEN: usize = 128;

const HYDRATION_OPERATIONS: [&str; 2] = ["OfferOnly", "OfferPage"];

/// Request-scoped telemetry collector capturing coerced arguments from executed fields.
#[derive(Clone, Default)]
pub struct AbuseTelemetry {
    inner: Arc<Mutex<AbuseTelemetryState>>,
}

type TelemetrySink = Arc<dyn Fn(AbuseResource) + Send + Sync>;

#[derive(Default)]
struct AbuseTelemetryState {
    operation_name: Option<String>,
    resources: Vec<AbuseResource>,
    sink: Option<TelemetrySink>,
}

impl AbuseTelemetry {
    /// Creates an empty request-scoped GraphQL telemetry collector.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a collector that also forwards each recorded resource to `sink`.
    pub fn with_sink(sink: impl Fn(AbuseResource) + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(AbuseTelemetryState {
                operation_name: None,
                resources: Vec::new(),
                sink: Some(Arc::new(sink)),
            })),
        }
    }

    /// Pre-populates or updates the executed GraphQL operation name.
    pub fn set_operation_name(&self, operation_name: Option<String>) {
        let mut guard = self.inner.lock().expect("abuse telemetry mutex poisoned");
        guard.operation_name = operation_name.filter(|name| !name.is_empty());
    }

    /// Records telemetry for a resolved GraphQL field using its coerced arguments.
    pub fn record_field(&self, parent_type: &str, field_name: &str, args: &Value) {
        let mut guard = self.inner.lock().expect("abuse telemetry mutex poisoned");
        if guard.resources.len() >= MAX_ABUSE_TELEMETRY_EVENTS {
            return;
        }
        let Some(resource) = build_abuse_resource(
            parent_type,
            field_name,
            args,
            guard.operation_name.as_deref(),
        ) else {
            return;
        };
        guard.resources.push(resource.clone());
        if let Some(sink) = guard.sink.as_ref() {
            sink(resource);
        }
    }

    /// Returns a snapshot of the recorded resources for this request.
    pub fn resources(&self) -> Vec<AbuseResource> {
        self.inner
            .lock()
            .expect("abuse telemetry mutex poisoned")
            .resources
            .clone()
    }

    /// Drains and returns all recorded resources for this request.
    pub fn take_resources(&self) -> Vec<AbuseResource> {
        let mut guard = self.inner.lock().expect("abuse telemetry mutex poisoned");
        std::mem::take(&mut guard.resources)
    }
}

/// Builds an [`AbuseResource`] from a resolved field and its coerced arguments,
/// returning `None` for non-root fields without a valid non-negative integer `page`.
pub fn build_abuse_resource(
    parent_type: &str,
    field_name: &str,
    args: &Value,
    operation_name: Option<&str>,
) -> Option<AbuseResource> {
    let page = extract_page(args);
    let root = parent_type == "Query";
    // Nested paginated fields matter; leaf fields do not represent requests.
    if !root && page.is_none() {
        return None;
    }

    let item_id = if root {
        args.get("id").and_then(Value::as_str).map(truncate_item_id)
    } else {
        None
    };

    let (hydration_id, hydration_route) = match (
        root && field_name == "offer" && page.is_none(),
        item_id.as_deref(),
        operation_name,
    ) {
        (true, Some(id), Some(op))
            if is_lowercase_hex_32(id) && HYDRATION_OPERATIONS.contains(&op) =>
        {
            (Some(id.to_owned()), Some(format!("graphql:{op}")))
        }
        _ => (None, None),
    };

    Some(AbuseResource {
        route: format!("/graphql/{parent_type}.{field_name}"),
        page,
        item_id,
        hydration_id,
        hydration_route,
        ..AbuseResource::default()
    })
}

fn extract_page(args: &Value) -> Option<u32> {
    let number = args.get("page")?.as_f64()?;
    if !number.is_finite()
        || number.fract() != 0.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&number)
    {
        return None;
    }
    u32::try_from(number as u64).ok()
}

fn truncate_item_id(id: &str) -> String {
    // JS slice counts UTF-16 code units. The observation's UTF-8 encoding
    // replaces a trailing unpaired surrogate when the slice splits a pair.
    if id.len() <= MAX_ITEM_ID_LEN {
        return id.to_owned();
    }
    String::from_utf16_lossy(&id.encode_utf16().take(MAX_ITEM_ID_LEN).collect::<Vec<_>>())
}

fn is_lowercase_hex_32(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Schema extension factory propagating the executed operation's AST name into [`AbuseTelemetry`].
#[derive(Debug, Clone, Copy, Default)]
pub struct AbuseTelemetryExtensionFactory;

impl ExtensionFactory for AbuseTelemetryExtensionFactory {
    fn create(&self) -> Arc<dyn Extension> {
        Arc::new(AbuseTelemetryExtension {
            single_operation_name: Mutex::new(None),
        })
    }
}

struct AbuseTelemetryExtension {
    single_operation_name: Mutex<Option<String>>,
}

#[async_trait]
impl Extension for AbuseTelemetryExtension {
    async fn parse_query(
        &self,
        ctx: &ExtensionContext<'_>,
        query: &str,
        variables: &Variables,
        next: NextParseQuery<'_>,
    ) -> ServerResult<ExecutableDocument> {
        let doc = next.run(ctx, query, variables).await?;
        let mut ops = doc.operations.iter();
        let single_name = ops
            .next()
            .filter(|_| ops.next().is_none())
            .and_then(|(name, _)| name.map(|n| n.as_str().to_owned()));
        if let Ok(mut guard) = self.single_operation_name.lock() {
            *guard = single_name;
        }
        Ok(doc)
    }

    async fn execute(
        &self,
        ctx: &ExtensionContext<'_>,
        operation_name: Option<&str>,
        next: NextExecute<'_>,
    ) -> Response {
        if let Some(telemetry) = ctx.data_opt::<AbuseTelemetry>() {
            let resolved = operation_name
                .filter(|name| !name.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    self.single_operation_name
                        .lock()
                        .ok()
                        .and_then(|guard| guard.clone())
                });
            telemetry.set_operation_name(resolved);
        }
        next.run(ctx, operation_name).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_graphql::{EmptyMutation, EmptySubscription, Object, Schema};
    use serde_json::json;

    #[test]
    fn builds_root_offer_hydration_resources_matching_node() {
        let offer_id = "0123456789abcdef0123456789abcdef";
        for op in ["OfferOnly", "OfferPage"] {
            let resource =
                build_abuse_resource("Query", "offer", &json!({ "id": offer_id }), Some(op))
                    .expect("root field is recorded");
            assert_eq!(
                resource,
                AbuseResource {
                    route: "/graphql/Query.offer".into(),
                    page: None,
                    item_id: Some(offer_id.into()),
                    hydration_id: Some(offer_id.into()),
                    hydration_route: Some(format!("graphql:{op}")),
                    ..AbuseResource::default()
                }
            );
        }

        // Non-matching operation names, uppercase hex, short IDs, or present page omit hydration.
        let non_hydration_cases = [
            (Some("OtherOperation"), offer_id, json!({ "id": offer_id })),
            (None, offer_id, json!({ "id": offer_id })),
            (
                Some("OfferOnly"),
                "0123456789ABCDEF0123456789abcdef",
                json!({ "id": "0123456789ABCDEF0123456789abcdef" }),
            ),
            (Some("OfferOnly"), "short-id", json!({ "id": "short-id" })),
            (
                Some("OfferOnly"),
                offer_id,
                json!({ "id": offer_id, "page": 1 }),
            ),
        ];

        for (op, expected_id, args) in non_hydration_cases {
            let resource = build_abuse_resource("Query", "offer", &args, op)
                .expect("root offer field is recorded");
            assert_eq!(resource.item_id.as_deref(), Some(expected_id));
            assert_eq!(resource.hydration_id, None);
            assert_eq!(resource.hydration_route, None);
        }
    }

    #[test]
    fn handles_page_validation_nested_fields_and_item_id_truncation() {
        assert_eq!(
            build_abuse_resource("Offer", "title", &json!({}), Some("OfferOnly")),
            None
        );
        assert_eq!(
            build_abuse_resource("Offer", "changelog", &json!({ "page": -1 }), None),
            None
        );
        assert_eq!(
            build_abuse_resource("Offer", "changelog", &json!({ "page": 1.5 }), None),
            None
        );
        assert_eq!(
            build_abuse_resource("Offer", "changelog", &json!({ "page": "2" }), None),
            None
        );
        assert_eq!(
            build_abuse_resource(
                "Offer",
                "changelog",
                &json!({ "page": 9_007_199_254_740_992_u64 }),
                None
            ),
            None
        );
        assert_eq!(
            build_abuse_resource(
                "Offer",
                "changelog",
                &json!({ "page": u64::from(u32::MAX) + 1 }),
                None
            ),
            None
        );

        let nested = build_abuse_resource(
            "Offer",
            "changelog",
            &json!({ "id": "ignored-on-nested", "page": 0 }),
            Some("OfferPage"),
        )
        .expect("nested paginated field is recorded");
        assert_eq!(nested.route, "/graphql/Offer.changelog");
        assert_eq!(nested.page, Some(0));
        assert_eq!(nested.item_id, None);

        let long_id = "x".repeat(200);
        let root_truncated =
            build_abuse_resource("Query", "item", &json!({ "id": long_id, "page": 3 }), None)
                .expect("root field is recorded");
        assert_eq!(root_truncated.route, "/graphql/Query.item");
        assert_eq!(root_truncated.page, Some(3));
        assert_eq!(
            root_truncated.item_id.as_deref(),
            Some("x".repeat(128).as_str())
        );
        assert_eq!(root_truncated.hydration_id, None);
        assert_eq!(truncate_item_id(&"🟢".repeat(80)), "🟢".repeat(64));
        assert_eq!(
            truncate_item_id(&format!("{}🟢", "a".repeat(127))),
            format!("{}�", "a".repeat(127))
        );
    }

    #[test]
    fn collector_caps_at_32_events_and_forwards_to_sink() {
        let forwarded = Arc::new(Mutex::new(Vec::new()));
        let forwarded_clone = forwarded.clone();
        let telemetry = AbuseTelemetry::with_sink(move |resource| {
            forwarded_clone.lock().unwrap().push(resource);
        });
        telemetry.set_operation_name(Some("OfferOnly".into()));

        for idx in 0..40 {
            telemetry.record_field("Offer", "title", &json!({}));
            telemetry.record_field("Query", "item", &json!({ "id": format!("item-{idx}") }));
        }

        let snapshot = telemetry.resources();
        assert_eq!(snapshot.len(), MAX_ABUSE_TELEMETRY_EVENTS);
        assert_eq!(forwarded.lock().unwrap().len(), MAX_ABUSE_TELEMETRY_EVENTS);
        assert_eq!(snapshot[0].item_id.as_deref(), Some("item-0"));
        assert_eq!(snapshot[31].item_id.as_deref(), Some("item-31"));

        let drained = telemetry.take_resources();
        assert_eq!(drained.len(), MAX_ABUSE_TELEMETRY_EVENTS);
        assert!(telemetry.resources().is_empty());

        let plain = AbuseTelemetry::new();
        plain.record_field("Query", "events", &json!({}));
        assert_eq!(plain.take_resources().len(), 1);
    }

    #[tokio::test]
    async fn schema_execution_captures_coerced_arguments_and_operation_names() {
        let schema = crate::schema::build_schema(true).expect("schema builds");
        let offer_id = "0123456789abcdef0123456789abcdef";

        // 1. Named single operation without explicit operationName in request (uses AST name).
        let telemetry = AbuseTelemetry::new();
        let req =
            async_graphql::Request::new("query OfferOnly($id: ID!) { offer(id: $id) { id } }")
                .variables(Variables::from_json(json!({ "id": offer_id })))
                .data(telemetry.clone());
        let resp = schema.execute(req).await;
        // Services are omitted so resolver errors, but telemetry captures willResolveField beforehand.
        assert!(!resp.errors.is_empty());
        let resources = telemetry.take_resources();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0].route, "/graphql/Query.offer");
        assert_eq!(resources[0].item_id.as_deref(), Some(offer_id));
        assert_eq!(resources[0].hydration_id.as_deref(), Some(offer_id));
        assert_eq!(
            resources[0].hydration_route.as_deref(),
            Some("graphql:OfferOnly")
        );

        // 2. Multi-operation document with explicit operationName.
        let telemetry_multi = AbuseTelemetry::new();
        let req_multi = async_graphql::Request::new(
            "query OfferPage($id: ID!) { offer(id: $id) { id } } query Other { events { id } }",
        )
        .operation_name("OfferPage")
        .variables(Variables::from_json(json!({ "id": offer_id })))
        .data(telemetry_multi.clone());
        let _ = schema.execute(req_multi).await;
        let multi_resources = telemetry_multi.take_resources();
        assert_eq!(multi_resources.len(), 1);
        assert_eq!(
            multi_resources[0].hydration_route.as_deref(),
            Some("graphql:OfferPage")
        );

        // 3. Extension works on any minimal schema even without AbuseTelemetry attached.
        struct MinimalQuery;
        #[Object]
        impl MinimalQuery {
            async fn ping(&self) -> &'static str {
                "pong"
            }
        }
        let minimal = Schema::build(MinimalQuery, EmptyMutation, EmptySubscription)
            .extension(AbuseTelemetryExtensionFactory)
            .finish();
        assert!(minimal.execute("{ ping }").await.is_ok());
    }
}
