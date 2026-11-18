//! GraphQL-js serializes the *result* of each resolver. The dynamic engine expects
//! already-coerced leaf values and concrete object names for abstract fields.

use super::*;
use async_graphql::{
    Context, Error, QueryPathSegment, Request,
    dynamic::FieldValue,
    extensions::{NextPrepareRequest, NextRequest, NextResolve, ResolveInfo},
};
use chrono::{DateTime, Utc};
use egdata_core::v1::{
    query::format_js_number,
    serialization::{js_iso_datetime, node_json},
};
use std::collections::HashSet;

#[derive(Default)]
struct NullListElements(Mutex<HashSet<String>>);

pub(super) struct NullListElementsFactory;

impl ExtensionFactory for NullListElementsFactory {
    fn create(&self) -> Arc<dyn Extension> {
        Arc::new(NullListElementsFactory)
    }
}

#[async_trait]
impl Extension for NullListElementsFactory {
    async fn request(&self, ctx: &ExtensionContext<'_>, next: NextRequest<'_>) -> Response {
        let mut response = next.run(ctx).await;
        // GraphQL returns an empty root object when directives skip every field.
        if response.errors.is_empty() && response.data == Value::Null {
            response.data = Value::Object(Default::default());
        }
        response
    }
    async fn prepare_request(
        &self,
        ctx: &ExtensionContext<'_>,
        request: Request,
        next: NextPrepareRequest<'_>,
    ) -> ServerResult<Request> {
        next.run(ctx, request.data(NullListElements::default()))
            .await
    }
    async fn resolve(
        &self,
        ctx: &ExtensionContext<'_>,
        info: ResolveInfo<'_>,
        next: NextResolve<'_>,
    ) -> ServerResult<Option<Value>> {
        if matches!(info.path_node.segment, QueryPathSegment::Index(_))
            && let Some(nulls) = ctx.data_opt::<NullListElements>()
        {
            let mut paths = nulls.0.lock().unwrap();
            if !paths.is_empty() && paths.remove(&info.path_node.to_string()) {
                return Ok(None);
            }
        }
        next.run(ctx, info).await
    }
}

pub(super) fn complete(
    ctx: &Context<'_>,
    ty: &ParserType,
    parent: &str,
    value: async_graphql::Result<JsonValue>,
) -> async_graphql::Result<Option<FieldValue<'static>>> {
    let result = value.and_then(|v| match v {
        JsonValue::Null => Ok(None),
        v => field_value(ctx, ty, parent, v).map(Some),
    });
    match result {
        Err(error) if ty.nullable => {
            ctx.add_error(ctx.set_error_path(error.into_server_error(ctx.item.pos)));
            Ok(None)
        }
        result => result,
    }
}

fn field_value(
    ctx: &Context<'_>,
    ty: &ParserType,
    parent: &str,
    value: JsonValue,
) -> async_graphql::Result<FieldValue<'static>> {
    let field = ctx.item.node.name.node.as_str();
    match &ty.base {
        BaseType::List(inner) => {
            let JsonValue::Array(values) = value else {
                return Err(Error::new(format!(
                    "Expected Iterable, but did not find one for field \"{parent}.{field}\"."
                )));
            };
            let mut out = Vec::with_capacity(values.len());
            for (index, value) in values.into_iter().enumerate() {
                let item = ctx.with_index(index);
                match complete(&item, inner, parent, Ok(value))? {
                    Some(value) => out.push(value),
                    None => {
                        // Dynamic list completion receives a FieldValue for every position.
                        // A null object would otherwise execute its nested fields.
                        let path = item.path_node.expect("with_index sets the list item path");
                        item.data_unchecked::<NullListElements>()
                            .0
                            .lock()
                            .unwrap()
                            .insert(path.to_string());
                        out.push(FieldValue::NULL);
                    }
                }
            }
            Ok(FieldValue::list(out))
        }
        BaseType::Named(name) => {
            let name = name.as_str();
            let concrete = match name {
                "ChangelogDocument" | "BaseGameResult" => {
                    let member=union_member(name,&value).ok_or_else(||Error::new(format!(
                        "Abstract type \"{name}\" must resolve to an Object type at runtime for field \"{parent}.{field}\". Either the \"{name}\" type should provide a \"resolveType\" function or each possible type should provide an \"isTypeOf\" function."
                    )))?;
                    Some(member)
                }
                _ => None,
            };
            let value = serialize_leaf(name, value)?;
            Value::from_json(value)
                .map(|json| {
                    let value = FieldValue::value(json);
                    if let Some(member) = concrete {
                        value.with_type(member)
                    } else {
                        value
                    }
                })
                .map_err(Error::from)
        }
    }
}

fn union_member(name: &str, value: &JsonValue) -> Option<&'static str> {
    for (field, member) in [
        ("offerType", "Offer"),
        ("entitlementName", "Item"),
        ("artifactId", "Asset"),
    ] {
        if member == "Asset" && name != "ChangelogDocument" {
            continue;
        }
        if value.get(field).is_some_and(|v| match v {
            JsonValue::Null => false,
            JsonValue::Bool(b) => *b,
            JsonValue::Number(n) => n.as_f64() != Some(0.),
            JsonValue::String(s) => !s.is_empty(),
            _ => true,
        }) {
            return Some(member);
        }
    }
    None
}

fn serialize_leaf(name: &str, value: JsonValue) -> async_graphql::Result<JsonValue> {
    let error = |prefix: &str| Error::new(format!("{prefix}: {}", inspect(&value, 0)));
    match name {
        "Date" | "DateTime" => match &value {
            JsonValue::String(s) => {
                let parsed = DateTime::parse_from_rfc3339(s)
                    .ok()
                    .filter(|_| {
                        let bytes = s.as_bytes();
                        bytes.get(10).is_some_and(|b| b.eq_ignore_ascii_case(&b'T'))
                            && bytes
                                .get(17..19)
                                .is_some_and(|seconds| seconds < b"60".as_slice())
                    })
                    .ok_or_else(|| {
                        Error::new(format!(
                            "DateTime cannot represent an invalid date-time-string {s}."
                        ))
                    })?;
                Ok(json!(js_iso_datetime(parsed.with_timezone(&Utc))))
            }
            JsonValue::Number(n) => {
                let millis = n.as_f64().unwrap_or_default() as i64;
                Ok(DateTime::from_timestamp_millis(millis)
                    .map_or(JsonValue::Null, |date| json!(js_iso_datetime(date))))
            }
            _ => Err(Error::new(format!(
                "DateTime cannot be serialized from a non string, non numeric or non Date type {}",
                node_json(&value)
            ))),
        },
        "ID" | "String" => match &value {
            JsonValue::String(_) => Ok(value),
            JsonValue::Number(n)
                if name == "String" || n.as_f64().is_some_and(|n| n.fract() == 0.) =>
            {
                Ok(json!(format_js_number(n.as_f64().unwrap())))
            }
            JsonValue::Bool(b) if name == "String" => Ok(json!(b.to_string())),
            _ => Err(error(&format!("{name} cannot represent value"))),
        },
        "Boolean" => match value {
            JsonValue::Bool(_) => Ok(value),
            JsonValue::Number(n) => Ok(json!(n.as_f64() != Some(0.))),
            _ => Err(error("Boolean cannot represent a non boolean value")),
        },
        "Int" | "Float" => {
            let n = match &value {
                JsonValue::Number(n) => n.as_f64(),
                JsonValue::String(s) if !s.is_empty() => js_number(s),
                JsonValue::Bool(b) => Some(f64::from(i32::from(*b))),
                _ => None,
            };
            if name == "Float" {
                return n
                    .filter(|n| n.is_finite())
                    .map(|n| json!(n))
                    .ok_or_else(|| error("Float cannot represent non numeric value"));
            }
            let n = n
                .filter(|n| n.fract() == 0.)
                .ok_or_else(|| error("Int cannot represent non-integer value"))?;
            if n < f64::from(i32::MIN) || n > f64::from(i32::MAX) {
                return Err(error(
                    "Int cannot represent non 32-bit signed integer value",
                ));
            }
            Ok(json!(n as i32))
        }
        _ => Ok(value),
    }
}

pub(crate) fn js_number(text: &str) -> Option<f64> {
    let text = text.trim();
    if text.is_empty() {
        return Some(0.);
    }
    let lower = text.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
        }
    }
    text.parse().ok()
}

pub(crate) fn inspect(value: &JsonValue, depth: usize) -> String {
    match value {
        JsonValue::Object(m) if m.is_empty() => "{}".into(),
        JsonValue::Object(_) if depth >= 2 => "[Object]".into(),
        JsonValue::Object(m) => format!(
            "{{ {} }}",
            m.iter()
                .map(|(k, v)| format!("{k}: {}", inspect(v, depth + 1)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        JsonValue::Array(a) if a.is_empty() => "[]".into(),
        JsonValue::Array(_) if depth >= 2 => "[Array]".into(),
        JsonValue::Array(a) => {
            let mut items = a
                .iter()
                .take(10)
                .map(|v| inspect(v, depth + 1))
                .collect::<Vec<_>>();
            if a.len() > 10 {
                let count = a.len() - 10;
                items.push(format!(
                    "... {count} more item{}",
                    if count == 1 { "" } else { "s" }
                ));
            }
            format!("[{}]", items.join(", "))
        }
        _ => node_json(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_graphql::{EmptyMutation, EmptySubscription, Object, Schema};
    use egdata_core::{
        error::CoreError,
        ports::{
            EpicStorePort, MongoDocumentStream, MongoFindOptions, MongoStorePort, ResponseCachePort,
        },
    };
    use std::sync::Arc;

    #[test]
    fn leaf_serialization_union_member_js_number_and_inspect_edge_cases() {
        // union_member for ChangelogDocument & BaseGameResult
        assert_eq!(
            union_member("ChangelogDocument", &json!({"offerType": "BASE_GAME"})),
            Some("Offer")
        );
        assert_eq!(
            union_member("ChangelogDocument", &json!({"entitlementName": "e"})),
            Some("Item")
        );
        assert_eq!(
            union_member("ChangelogDocument", &json!({"artifactId": "a"})),
            Some("Asset")
        );
        assert_eq!(
            union_member("BaseGameResult", &json!({"artifactId": "a"})),
            None
        );
        assert_eq!(
            union_member(
                "ChangelogDocument",
                &json!({"offerType": null, "entitlementName": false, "artifactId": 0})
            ),
            None
        );
        assert_eq!(
            union_member(
                "ChangelogDocument",
                &json!({"offerType": 1, "artifactId": ""})
            ),
            Some("Offer")
        );
        assert_eq!(
            union_member("ChangelogDocument", &json!({"offerType": ["x"]})),
            Some("Offer")
        );

        assert_eq!(inspect(&json!([]), 0), "[]");
        // DateTime serialization
        assert!(serialize_leaf("DateTime", json!("2025-01-01T00:00:00Z")).is_ok());
        assert!(serialize_leaf("DateTime", json!("not-a-date")).is_err());
        assert!(serialize_leaf("DateTime", json!("2025-01-01 00:00:00Z")).is_err());
        assert_eq!(
            serialize_leaf("DateTime", json!(0)).unwrap(),
            json!("1970-01-01T00:00:00.000Z")
        );
        assert_eq!(
            serialize_leaf("DateTime", json!(9e18)).unwrap(),
            JsonValue::Null
        );
        assert!(serialize_leaf("DateTime", json!(true)).is_err());

        // ID & String
        assert_eq!(serialize_leaf("ID", json!(42)).unwrap(), json!("42"));
        assert_eq!(
            serialize_leaf("String", json!(42.5)).unwrap(),
            json!("42.5")
        );
        assert_eq!(
            serialize_leaf("String", json!(true)).unwrap(),
            json!("true")
        );
        assert!(serialize_leaf("ID", json!(42.5)).is_err());
        assert!(serialize_leaf("ID", json!(true)).is_err());

        // Boolean
        assert_eq!(serialize_leaf("Boolean", json!(true)).unwrap(), json!(true));
        assert_eq!(serialize_leaf("Boolean", json!(1)).unwrap(), json!(true));
        assert_eq!(serialize_leaf("Boolean", json!(0)).unwrap(), json!(false));
        assert!(serialize_leaf("Boolean", json!("yes")).is_err());

        // Int & Float
        assert_eq!(
            serialize_leaf("Float", json!("0xff")).unwrap(),
            json!(255.0)
        );
        assert_eq!(serialize_leaf("Float", json!(true)).unwrap(), json!(1.0));
        assert!(serialize_leaf("Float", json!("nope")).is_err());
        assert_eq!(serialize_leaf("Int", json!("10")).unwrap(), json!(10));
        assert!(serialize_leaf("Int", json!({})).is_err());
        assert!(serialize_leaf("Int", json!(10.5)).is_err());
        assert!(serialize_leaf("Int", json!(1e12)).is_err());

        // js_number
        assert_eq!(js_number("   "), Some(0.0));
        assert_eq!(js_number("0x10"), Some(16.0));
        assert_eq!(js_number("0o10"), Some(8.0));
        assert_eq!(js_number("0b101"), Some(5.0));
        assert_eq!(js_number("3.5"), Some(3.5));

        // inspect depth & array truncation (1 more item vs N more items)
        assert_eq!(inspect(&json!({}), 0), "{}");
        assert_eq!(
            inspect(&json!({"a": {"b": {"c": 1}}}), 0),
            "{ a: { b: [Object] } }"
        );
        assert_eq!(inspect(&json!([[["x"]]]), 0), "[[[Array]]]");
        let eleven: Vec<JsonValue> = (0..11).map(|i| json!(i)).collect();
        assert!(inspect(&JsonValue::Array(eleven), 0).ends_with("... 1 more item]"));
        let twelve: Vec<JsonValue> = (0..12).map(|i| json!(i)).collect();
        assert!(inspect(&JsonValue::Array(twelve), 0).ends_with("... 2 more items]"));
    }

    struct StaticMongo(JsonValue, bool);
    #[async_trait]
    impl MongoStorePort for StaticMongo {
        async fn find_one(
            &self,
            _: &str,
            _: bson::Document,
            _: Option<bson::Document>,
        ) -> Result<Option<bson::Document>, CoreError> {
            if self.1 {
                return Err(CoreError::Internal("boom".into()));
            }
            Ok((!self.0.is_null()).then(|| bson::to_document(&self.0).unwrap()))
        }
        async fn find_many(
            &self,
            _: &str,
            _: bson::Document,
            _: MongoFindOptions,
        ) -> Result<Vec<bson::Document>, CoreError> {
            Ok(vec![])
        }
        async fn find_stream(
            &self,
            _: &str,
            _: bson::Document,
            _: MongoFindOptions,
        ) -> Result<MongoDocumentStream, CoreError> {
            Ok(Box::pin(futures::stream::empty()))
        }
        async fn aggregate(
            &self,
            _: &str,
            _: Vec<bson::Document>,
        ) -> Result<Vec<bson::Document>, CoreError> {
            Ok(vec![])
        }
        async fn count_documents(&self, _: &str, _: bson::Document) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn distinct(
            &self,
            _: &str,
            _: &str,
            _: bson::Document,
        ) -> Result<Vec<bson::Bson>, CoreError> {
            Ok(vec![])
        }
        async fn insert_one(&self, _: &str, _: bson::Document) -> Result<(), CoreError> {
            Ok(())
        }
        async fn update_one(
            &self,
            _: &str,
            _: bson::Document,
            _: bson::Document,
            _: bool,
        ) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn delete_one(&self, _: &str, _: bson::Document) -> Result<u64, CoreError> {
            Ok(0)
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }
    struct DummyDeps;
    #[async_trait]
    impl ResponseCachePort for DummyDeps {
        async fn get(&self, _: &str) -> Result<Option<String>, CoreError> {
            Ok(None)
        }
        async fn set(&self, _: &str, _: &str, _: u64) -> Result<(), CoreError> {
            Ok(())
        }
        async fn del(&self, _: &str) -> Result<(), CoreError> {
            Ok(())
        }
        async fn ping(&self) -> Result<bool, CoreError> {
            Ok(true)
        }
    }
    #[async_trait]
    impl EpicStorePort for DummyDeps {
        async fn graphql(&self, _: &str, _: &JsonValue) -> Result<JsonValue, CoreError> {
            Ok(JsonValue::Null)
        }
        async fn featured_games(&self) -> Result<Vec<JsonValue>, CoreError> {
            Ok(vec![])
        }
    }

    #[tokio::test]
    async fn output_completion_handles_nullable_errors_non_iterable_and_invalid_unions() {
        let schema = crate::schema::build_schema(true).unwrap();

        // Nullable field resolver error returns null + error via output::complete.
        let services_err = Arc::new(crate::resolvers::GraphqlServices::new(
            Arc::new(StaticMongo(JsonValue::Null, true)),
            Arc::new(DummyDeps),
            Arc::new(DummyDeps),
        ));
        let err_resp = schema
            .execute(async_graphql::Request::new("{ item(id: \"x\") { id } }").data(services_err))
            .await;
        assert_eq!(err_resp.errors.len(), 1);
        assert_eq!(err_resp.data.into_json().unwrap(), json!({ "item": null }));

        let custom = crate::schema::build_schema_from_sdl(
            "type Query { item(id: ID!): Item } type Item { categories: [Int!] }",
            true,
        )
        .unwrap();
        let invalid_element = Arc::new(crate::resolvers::GraphqlServices::new(
            Arc::new(StaticMongo(json!({"categories":[{}]}), false)),
            Arc::new(DummyDeps),
            Arc::new(DummyDeps),
        ));
        let response = custom
            .execute(
                async_graphql::Request::new("{item(id:\"x\"){categories}}").data(invalid_element),
            )
            .await;
        assert_eq!(
            response.data.into_json().unwrap(),
            json!({"item":{"categories":null}})
        );
        assert_eq!(response.errors.len(), 1);

        // Non-array value returned for a List field triggers Expected Iterable error.
        let services_bad_list = Arc::new(crate::resolvers::GraphqlServices::new(
            Arc::new(StaticMongo(
                json!({ "id": "x", "categories": "not-a-list" }),
                false,
            )),
            Arc::new(DummyDeps),
            Arc::new(DummyDeps),
        ));
        let bad_list = schema
            .execute(
                async_graphql::Request::new("{ item(id: \"x\") { categories { path } } }")
                    .data(services_bad_list),
            )
            .await;
        assert!(bad_list.errors[0].message.contains("Expected Iterable"));

        // Abstract type without matching member fields triggers runtime resolveType error.
        let services_bad_union = Arc::new(crate::resolvers::GraphqlServices::new(
            Arc::new(StaticMongo(
                json!({ "_id": "64b000000000000000000001", "document": { "unknown": true } }),
                false,
            )),
            Arc::new(DummyDeps),
            Arc::new(DummyDeps),
        ));
        let bad_union = schema
            .execute(
                async_graphql::Request::new(
                    "{ changelog(id: \"64b000000000000000000001\") { document { __typename } } }",
                )
                .data(services_bad_union),
            )
            .await;
        assert!(bad_union.errors[0].message.contains("Abstract type"));

        // Null list element suppression via NullListElements extension.
        struct ListQuery;
        #[Object]
        impl ListQuery {
            async fn ok(&self) -> &'static str {
                "ok"
            }
        }
        let minimal = Schema::build(ListQuery, EmptyMutation, EmptySubscription)
            .extension(NullListElementsFactory)
            .finish();
        assert!(minimal.execute("{ ok }").await.is_ok());

        // Exercise remaining trait stubs on StaticMongo / DummyDeps.
        let m = StaticMongo(JsonValue::Null, false);
        assert!(
            m.find_many("c", bson::Document::new(), Default::default())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            m.find_stream("c", bson::Document::new(), Default::default())
                .await
                .is_ok()
        );
        assert!(m.aggregate("c", vec![]).await.unwrap().is_empty());
        assert_eq!(
            m.count_documents("c", bson::Document::new()).await.unwrap(),
            0
        );
        assert!(
            m.distinct("c", "f", bson::Document::new())
                .await
                .unwrap()
                .is_empty()
        );
        assert!(m.insert_one("c", bson::Document::new()).await.is_ok());
        assert_eq!(
            m.update_one("c", bson::Document::new(), bson::Document::new(), false)
                .await
                .unwrap(),
            0
        );
        assert_eq!(m.delete_one("c", bson::Document::new()).await.unwrap(), 0);
        assert!(MongoStorePort::ping(&m).await.unwrap());
        let d = DummyDeps;
        assert!(d.get("k").await.unwrap().is_none());
        assert!(d.set("k", "v", 1).await.is_ok());
        assert!(d.del("k").await.is_ok());
        assert!(ResponseCachePort::ping(&d).await.unwrap());
        assert_eq!(
            d.graphql("q", &JsonValue::Null).await.unwrap(),
            JsonValue::Null
        );
        assert!(d.featured_games().await.unwrap().is_empty());
    }
}
