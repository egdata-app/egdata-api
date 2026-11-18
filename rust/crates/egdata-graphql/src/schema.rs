//! Dynamic GraphQL schema assembled from the canonical TypeScript SDL.

mod introspection;
mod output;

pub(crate) use introspection::{named_type, public_schema};
pub(crate) use output::{inspect, js_number};

use anyhow::{Context as _, anyhow};
use async_graphql::{
    Positioned, Response, ServerResult, Value, Variables,
    dynamic::{
        Enum, EnumItem, Field, FieldFuture, InputObject, InputValue, Object, Scalar, Schema,
        Type as DynamicType, TypeRef, Union,
    },
    extensions::{Extension, ExtensionContext, ExtensionFactory, NextExecute, NextParseQuery},
    parser::{
        parse_schema,
        types::{
            BaseType, ExecutableDocument, Selection, SelectionSet, Type as ParserType, TypeKind,
            TypeSystemDefinition,
        },
    },
};
use async_trait::async_trait;
use serde_json::{Value as JsonValue, json};
use std::sync::{Arc, Mutex};

const TYPEDEFS_SOURCE: &str = include_str!("../../../../src/graphql/typedefs.ts");

/// Request-local minimum cache lifetime accumulated from selected fields.
#[derive(Clone, Default)]
pub struct CacheHints(Arc<Mutex<Option<u32>>>);

impl CacheHints {
    pub fn max_age(&self) -> Option<u32> {
        *self.0.lock().expect("cache hint lock poisoned")
    }

    fn record(&self, max_age: u32) {
        let mut current = self.0.lock().expect("cache hint lock poisoned");
        *current = Some(current.map_or(max_age, |value| value.min(max_age)));
    }
}

/// Build the GraphQL schema from the canonical SDL and attach executable field resolvers.
pub fn build_schema(introspection: bool) -> anyhow::Result<Schema> {
    extract_sdl(TYPEDEFS_SOURCE).and_then(|sdl| build_schema_from_sdl(sdl, introspection))
}

pub(crate) fn build_schema_from_sdl(sdl: &str, introspection: bool) -> anyhow::Result<Schema> {
    let document = parse_schema(sdl).context("parse canonical GraphQL SDL")?;
    let definitions = document
        .definitions
        .iter()
        .filter_map(|definition| match definition {
            TypeSystemDefinition::Type(ty) if !ty.node.extend => Some(&ty.node),
            _ => None,
        })
        .collect::<Vec<_>>();
    let object_hints = definitions
        .iter()
        .filter_map(|definition| {
            matches!(definition.kind, TypeKind::Object(_))
                .then(|| {
                    (
                        definition.name.node.to_string(),
                        cache_hint(&definition.directives),
                    )
                })
                .and_then(|(name, hint)| hint.map(|hint| (name, hint)))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let composite_types = definitions
        .iter()
        .filter(|ty| {
            matches!(
                ty.kind,
                TypeKind::Object(_) | TypeKind::Interface(_) | TypeKind::Union(_)
            )
        })
        .map(|ty| ty.name.node.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut builder = Schema::build("Query", None, None);

    for definition in &definitions {
        let name = definition.name.node.to_string();
        let ty = match &definition.kind {
            TypeKind::Scalar => Some(DynamicType::Scalar(Scalar::new(public_name(&name)))),
            TypeKind::Enum(enumeration) => {
                let mut ty = Enum::new(name.clone());
                for value in &enumeration.values {
                    ty = ty.item(EnumItem::new(value.node.value.node.to_string()));
                }
                Some(DynamicType::Enum(ty))
            }
            TypeKind::InputObject(input) => {
                let mut ty = InputObject::new(name.clone());
                for field in &input.fields {
                    let field = &field.node;
                    let mut input =
                        InputValue::new(field.name.node.to_string(), to_type_ref(&field.ty.node));
                    if let Some(default) = &field.default_value {
                        input = input.default_value(default.node.clone());
                    }
                    ty = ty.field(input);
                }
                Some(DynamicType::InputObject(ty))
            }
            TypeKind::Union(union) => {
                let mut ty = Union::new(name.clone());
                for member in &union.members {
                    ty = ty.possible_type(member.node.to_string());
                }
                Some(DynamicType::Union(ty))
            }
            TypeKind::Object(object) => {
                let parent_type = name.clone();
                let mut ty = Object::new(name.clone());
                for interface in &object.implements {
                    ty = ty.implement(interface.node.to_string());
                }
                for field in &object.fields {
                    let field = &field.node;
                    let field_name = field.name.node.to_string();
                    let resolver_parent_type = parent_type.clone();
                    let named_return_type = named_output_type(&field.ty.node);
                    let return_hint = object_hints.get(&named_return_type).copied();
                    let field_hint = cache_hint(&field.directives).or(return_hint).or_else(|| {
                        (parent_type == "Query"
                            || composite_types.contains(named_return_type.as_str()))
                        .then_some(60)
                    });
                    let return_type = field.ty.node.clone();
                    let id_args = field
                        .arguments
                        .iter()
                        .filter(|arg| named_output_type(&arg.node.ty.node) == "ID")
                        .map(|arg| arg.node.name.node.to_string())
                        .collect::<Vec<_>>();
                    let mut dynamic_field = Field::new(
                        field_name.clone(),
                        to_type_ref(&field.ty.node),
                        move |ctx| {
                            let parent_type = resolver_parent_type.clone();
                            let field_name = field_name.clone();
                            let return_type = return_type.clone();
                            let id_args = id_args.clone();
                            FieldFuture::new(async move {
                                if let (Some(age), Ok(hints)) =
                                    (field_hint, ctx.ctx.data::<CacheHints>())
                                {
                                    hints.record(age);
                                }
                                let parent = ctx
                                    .parent_value
                                    .as_value()
                                    .and_then(|value| value.clone().into_json().ok())
                                    .unwrap_or(JsonValue::Null);
                                let mut arg_map = ctx
                                    .args
                                    .iter()
                                    .filter_map(|(name, value)| {
                                        value
                                            .as_value()
                                            .clone()
                                            .into_json()
                                            .ok()
                                            .map(|value| (name.to_string(), value))
                                    })
                                    .collect::<serde_json::Map<String, JsonValue>>();
                                let selected = ctx
                                    .ctx
                                    .field()
                                    .selection_set()
                                    .filter(|field| !field.name().starts_with("__"))
                                    .map(|field| field.alias().unwrap_or(field.name()).to_string())
                                    .collect::<Vec<_>>();
                                for name in &id_args {
                                    if let Some(value) = arg_map.get_mut(name)
                                        && let Some(n) = value.as_f64().filter(|n| n.fract() == 0.0)
                                    {
                                        *value = json!(egdata_core::v1::query::format_js_number(n));
                                    }
                                }
                                arg_map.insert("__selectedFields".into(), json!(selected));
                                let args = JsonValue::Object(arg_map);
                                if let Some(telemetry) =
                                    ctx.ctx.data_opt::<super::abuse_telemetry::AbuseTelemetry>()
                                {
                                    telemetry.record_field(&parent_type, &field_name, &args);
                                }
                                let services = ctx
                                    .ctx
                                    .data::<std::sync::Arc<super::resolvers::GraphqlServices>>()?;
                                let result = super::resolvers::resolve(
                                    &parent_type,
                                    &field_name,
                                    &parent,
                                    &args,
                                    services,
                                )
                                .await;
                                let result = result.map(|resolved| {
                                    resolved.unwrap_or_else(|| {
                                        parent.get(&field_name).cloned().unwrap_or(JsonValue::Null)
                                    })
                                });
                                output::complete(ctx.ctx, &return_type, &parent_type, result)
                            })
                        },
                    );
                    for argument in &field.arguments {
                        let argument = &argument.node;
                        let mut input = InputValue::new(
                            argument.name.node.to_string(),
                            to_type_ref(&argument.ty.node),
                        );
                        if let Some(default) = &argument.default_value {
                            input = input.default_value(default.node.clone());
                        }
                        dynamic_field = dynamic_field.argument(input);
                    }
                    ty = ty.field(dynamic_field);
                }
                Some(DynamicType::Object(ty))
            }
            TypeKind::Interface(_) => None,
        };
        if let Some(ty) = ty {
            builder = builder.register(ty);
        }
    }
    builder
        .extension(introspection::CacheControlIntrospectionFactory {
            enabled: introspection,
        })
        .extension(output::NullListElementsFactory)
        .extension(super::validation::ValidationExtensionFactory::default())
        .extension(super::abuse_telemetry::AbuseTelemetryExtensionFactory)
        .finish()
        .context("finish canonical GraphQL schema")
}

fn extract_sdl(source: &str) -> anyhow::Result<&str> {
    let (_, body) = source
        .split_once("= `#graphql")
        .ok_or_else(|| anyhow!("canonical typeDefs template was not found"))?;
    let (sdl, _) = body
        .rsplit_once("`;")
        .ok_or_else(|| anyhow!("canonical typeDefs template is not terminated"))?;
    Ok(sdl)
}

fn public_name(name: &str) -> &str {
    if name == "Date" { "DateTime" } else { name }
}

fn to_type_ref(ty: &ParserType) -> TypeRef {
    let base = match &ty.base {
        BaseType::Named(name) => TypeRef::named(public_name(name.as_str())),
        BaseType::List(inner) => TypeRef::List(Box::new(to_type_ref(inner))),
    };
    if ty.nullable {
        base
    } else {
        TypeRef::NonNull(Box::new(base))
    }
}

fn named_output_type(ty: &ParserType) -> String {
    match &ty.base {
        BaseType::Named(name) => name.to_string(),
        BaseType::List(inner) => named_output_type(inner),
    }
}

fn cache_hint(
    directives: &[async_graphql::Positioned<async_graphql::parser::types::ConstDirective>],
) -> Option<u32> {
    directives
        .iter()
        .find(|directive| directive.node.name.node == "cacheControl")?
        .node
        .arguments
        .iter()
        .find(|(name, _)| name.node == "maxAge")
        .and_then(|(_, value)| value.node.to_string().parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTROSPECTION_QUERY: &str = r#"
      query CanonicalSchema {
        __schema {
          types {
            kind name
            fields(includeDeprecated: true) {
              name type { ...TypeRef }
              args { name defaultValue type { ...TypeRef } }
            }
            inputFields { name defaultValue type { ...TypeRef } }
            enumValues(includeDeprecated: true) { name }
            possibleTypes { name }
          }
          directives {
            name isRepeatable locations
            args { name defaultValue type { ...TypeRef } }
          }
        }
      }
      fragment TypeRef on __Type {
        kind name
        ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
      }
    "#;

    #[tokio::test]
    async fn canonical_sdl_parses_and_schema_builds() {
        let schema = build_schema(true).expect("canonical schema builds");
        let response = schema
            .execute("{ __schema {queryType {name}} __typename }")
            .await
            .into_result()
            .unwrap();
        assert_eq!(
            response.data.into_json().unwrap(),
            json!({"__schema":{"queryType":{"name":"Query"}},"__typename":"Query"})
        );
        let sdl = schema.sdl();
        assert!(sdl.contains("type Offer"));
        assert!(sdl.contains("union ChangelogDocument"));
        assert!(sdl.contains("scalar DateTime"));
        let result = schema.execute("{ __schema { queryType { name } } }").await;
        assert_eq!(
            result.into_result().expect("introspection works").data,
            async_graphql::value!({"__schema":{"queryType":{"name":"Query"}}})
        );
    }

    #[tokio::test]
    async fn cache_hints_follow_selected_return_types() {
        let schema = build_schema(true).expect("canonical schema builds");
        let build_hints = CacheHints::default();
        let _ = schema
            .execute(
                async_graphql::Request::new("{ build(id: \"missing\") { appName } }")
                    .data(build_hints.clone()),
            )
            .await;
        assert_eq!(build_hints.max_age(), Some(3600));

        let typename_hints = CacheHints::default();
        let _ = schema
            .execute(async_graphql::Request::new("{ __typename }").data(typename_hints.clone()))
            .await;
        assert_eq!(typename_hints.max_age(), None);
    }

    #[tokio::test]
    async fn production_introspection_rule_rejects_schema_and_type_but_allows_typename() {
        let schema = build_schema(false).expect("canonical schema builds");
        let result = schema
            .execute("{ __typename }")
            .await
            .into_result()
            .unwrap();
        assert_eq!(result.data, async_graphql::value!({"__typename":"Query"}));
        let result = schema.execute("query Q{ ...Blocked } fragment Blocked on Query { x:__schema{ description } y:__type(name:\"Query\"){name} }").await;
        assert_eq!(result.errors.len(), 2);
        for error in result.errors {
            assert_eq!(
                error.extensions.unwrap().get("validationErrorCode"),
                Some(&Value::from("INTROSPECTION_DISABLED"))
            );
            assert!(
                error
                    .message
                    .starts_with("GraphQL introspection is not allowed by Apollo Server")
            );
        }
    }

    #[tokio::test]
    async fn full_schema_introspection_matches_canonical_apollo() {
        let schema = build_schema(true).expect("canonical schema builds");
        let actual = schema
            .execute(INTROSPECTION_QUERY)
            .await
            .into_result()
            .expect("schema introspection succeeds")
            .data
            .into_json()
            .expect("introspection JSON");
        let actual = normalize_introspection(actual["__schema"].clone());
        let expected: JsonValue = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/graphql-schema-node.json"
        ))
        .expect("Node schema fixture parses");
        let expected = normalize_introspection(expected[0]["schema"].clone());
        assert_eq!(first_difference(&actual, &expected, "$"), None);

        // Exercise first_difference error reporting & normalize_introspection edge cases.
        assert!(first_difference(&json!({"a": 1}), &json!({"b": 1}), "$").is_some());
        assert!(first_difference(&json!({"a": 1}), &json!({"a": 2}), "$").is_some());
        assert!(first_difference(&json!([{"name": "a"}]), &json!([{"name": "b"}]), "$").is_some());
        assert!(
            first_difference(
                &json!([{"name": "a"}]),
                &json!([{"name": "a"}, {"name": "b"}]),
                "$"
            )
            .is_some()
        );
        assert!(first_difference(&json!(1), &json!(2), "$").is_some());
        assert_eq!(
            normalize_introspection(json!({})),
            json!({"types":null,"directives":null})
        );
        assert!(build_schema_from_sdl("type Query {", true).is_err());
        let hints = CacheHints::default();
        hints.record(120);
        hints.record(60);
        assert_eq!(hints.max_age(), Some(60));
        let empty_norm = normalize_introspection(json!({"directives": [{"name": "d"}]}));
        assert_eq!(
            empty_norm,
            json!({"types": null, "directives": [{"name": "d", "args": null, "locations": null}]})
        );
    }

    #[tokio::test]
    async fn builds_custom_sdl_with_input_objects_interfaces_and_numeric_id_args() {
        let custom_sdl = r#"
          interface Node {
            id: ID!
          }
          input FilterInput {
            name: String = "all"
            limit: Int
          }
          type Widget {
            id: ID!
            title: String
          }
          type Query {
            widget(id: ID!, filter: FilterInput): Widget
          }
        "#;
        let custom_schema = build_schema_from_sdl(custom_sdl, true).expect("custom SDL builds");
        assert!(custom_schema.sdl().contains("input FilterInput"));

        let impl_sdl = r#"
          interface Node { id: ID! }
          type Widget implements Node { id: ID! }
          type Query { widget: Widget }
        "#;
        assert!(build_schema_from_sdl(impl_sdl, true).is_err());

        assert!(extract_sdl("no prefix").is_err());
        assert!(extract_sdl("= `#graphql\ntype Query { ok: Boolean }").is_err());

        // Numeric literal passed to an ID argument is formatted to string in schema.rs.
        let schema = build_schema(true).expect("canonical schema builds");
        let telemetry = crate::abuse_telemetry::AbuseTelemetry::new();
        let _ = schema
            .execute(async_graphql::Request::new("{ item(id: 42) { id } }").data(telemetry.clone()))
            .await;
        let recorded = telemetry.take_resources();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].item_id.as_deref(), Some("42"));
    }

    fn first_difference(left: &JsonValue, right: &JsonValue, path: &str) -> Option<String> {
        match (left, right) {
            (JsonValue::Object(left), JsonValue::Object(right)) => {
                if left.keys().ne(right.keys()) {
                    return Some(format!(
                        "{path}: keys differ: {:?} vs {:?}",
                        left.keys().collect::<Vec<_>>(),
                        right.keys().collect::<Vec<_>>()
                    ));
                }
                for (key, value) in left {
                    if let Some(difference) =
                        first_difference(value, &right[key], &format!("{path}.{key}"))
                    {
                        return Some(difference);
                    }
                }
                None
            }
            (JsonValue::Array(left), JsonValue::Array(right)) => {
                if left.len() != right.len() {
                    let left_names = left
                        .iter()
                        .filter_map(|value| value.get("name").and_then(JsonValue::as_str))
                        .collect::<Vec<_>>();
                    let right_names = right
                        .iter()
                        .filter_map(|value| value.get("name").and_then(JsonValue::as_str))
                        .collect::<Vec<_>>();
                    return Some(format!(
                        "{path}: array lengths differ: {} vs {}; left names={left_names:?}, right names={right_names:?}",
                        left.len(),
                        right.len()
                    ));
                }
                left.iter()
                    .zip(right)
                    .enumerate()
                    .find_map(|(index, (left, right))| {
                        first_difference(left, right, &format!("{path}[{index}]"))
                    })
            }
            _ if left == right => None,
            _ => Some(format!("{path}: {left} != {right}")),
        }
    }

    fn normalize_introspection(mut schema: JsonValue) -> JsonValue {
        fn sort_named(values: Option<&mut Vec<JsonValue>>) {
            if let Some(values) = values {
                values.sort_by(|left, right| {
                    left["name"]
                        .as_str()
                        .unwrap_or_default()
                        .cmp(right["name"].as_str().unwrap_or_default())
                });
            }
        }
        if let Some(types) = schema["types"].as_array_mut() {
            for ty in types {
                sort_named(ty["fields"].as_array_mut());
                if let Some(fields) = ty["fields"].as_array_mut() {
                    for field in fields {
                        sort_named(field["args"].as_array_mut());
                    }
                }
                sort_named(ty["inputFields"].as_array_mut());
                sort_named(ty["enumValues"].as_array_mut());
                sort_named(ty["possibleTypes"].as_array_mut());
            }
        }
        sort_named(schema["types"].as_array_mut());
        sort_named(schema["directives"].as_array_mut());
        if let Some(directives) = schema["directives"].as_array_mut() {
            for directive in directives {
                sort_named(directive["args"].as_array_mut());
                if let Some(locations) = directive["locations"].as_array_mut() {
                    locations
                        .sort_by_key(|location| location.as_str().unwrap_or_default().to_string());
                }
            }
        }
        schema
    }
}
