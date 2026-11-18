//! Project Apollo's public introspection metadata through the validated GraphQL selection.
//! The schema oracle regenerates this metadata from the configured Node server. Its scalar
//! names, built-in descriptions, directive order and applied defaults are part of the API.

use super::*;
use async_graphql::{
    ErrorExtensionValues, Name, ServerError, ValidationResult,
    extensions::NextValidation,
    parser::types::{Field as AstField, FragmentDefinition},
};
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

struct Metadata {
    schema: JsonValue,
    types: HashMap<String, usize>,
}

static METADATA: LazyLock<Metadata> = LazyLock::new(|| {
    let schema: JsonValue = serde_json::from_str(include_str!("public-schema.json"))
        .expect("verified Apollo introspection metadata");
    let types = schema["types"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, ty)| (ty["name"].as_str().unwrap().to_owned(), index))
        .collect();
    Metadata { schema, types }
});

pub(crate) fn public_schema() -> &'static JsonValue {
    &METADATA.schema
}

pub(crate) fn named_type(name: &str) -> Option<&'static JsonValue> {
    METADATA.named_type(name)
}

impl Metadata {
    fn named_type(&self, name: &str) -> Option<&JsonValue> {
        self.types
            .get(name)
            .map(|index| &self.schema["types"][*index])
    }
}

pub(super) struct CacheControlIntrospectionFactory {
    pub(super) enabled: bool,
}

impl ExtensionFactory for CacheControlIntrospectionFactory {
    fn create(&self) -> Arc<dyn Extension> {
        Arc::new(Introspection {
            enabled: self.enabled,
            request: Mutex::new(None),
        })
    }
}

struct Introspection {
    enabled: bool,
    request: Mutex<Option<(ExecutableDocument, Variables)>>,
}

const DISABLED: &str = "GraphQL introspection is not allowed by Apollo Server, but the query contained __schema or __type. To enable introspection, pass introspection: true to ApolloServer in production";

fn find_introspection(selections: &SelectionSet, locations: &mut Vec<async_graphql::Pos>) {
    for selection in &selections.items {
        match &selection.node {
            Selection::Field(field) => {
                if matches!(field.node.name.node.as_str(), "__schema" | "__type") {
                    locations.push(field.pos);
                }
                find_introspection(&field.node.selection_set.node, locations);
            }
            Selection::InlineFragment(fragment) => {
                find_introspection(&fragment.node.selection_set.node, locations)
            }
            // Fragment definitions are visited once at document scope.
            Selection::FragmentSpread(_) => (),
        }
    }
}

#[async_trait]
impl Extension for Introspection {
    async fn parse_query(
        &self,
        ctx: &ExtensionContext<'_>,
        source: &str,
        variables: &Variables,
        next: NextParseQuery<'_>,
    ) -> ServerResult<ExecutableDocument> {
        let document = next.run(ctx, source, variables).await?;
        if source.contains("__schema") || source.contains("__type") {
            *self.request.lock().unwrap() = Some((document.clone(), variables.clone()));
        }
        Ok(document)
    }

    async fn validation(
        &self,
        ctx: &ExtensionContext<'_>,
        next: NextValidation<'_>,
    ) -> Result<ValidationResult, Vec<ServerError>> {
        let standard = next.run(ctx).await;
        if self.enabled {
            return standard;
        }
        let request = self.request.lock().unwrap();
        let Some((doc, _)) = request.as_ref() else {
            return standard;
        };
        let mut locations = Vec::new();
        for (_, op) in doc.operations.iter() {
            find_introspection(&op.node.selection_set.node, &mut locations);
        }
        for fragment in doc.fragments.values() {
            find_introspection(&fragment.node.selection_set.node, &mut locations);
        }
        if locations.is_empty() {
            return standard;
        }
        locations.sort_by_key(|pos| (pos.line, pos.column));
        let mut errors = standard.err().unwrap_or_default();
        for pos in locations {
            let mut err = ServerError::new(DISABLED, Some(pos));
            let mut ext = ErrorExtensionValues::default();
            ext.set("validationErrorCode", "INTROSPECTION_DISABLED");
            err.extensions = Some(ext);
            errors.push(err);
        }
        Err(errors)
    }

    async fn execute(
        &self,
        ctx: &ExtensionContext<'_>,
        operation_name: Option<&str>,
        next: NextExecute<'_>,
    ) -> Response {
        let request = self.request.lock().unwrap().take();
        let Some((doc, mut variables)) = request else {
            return next.run(ctx, operation_name).await;
        };
        let Some((_, operation)) = doc
            .operations
            .iter()
            .find(|(name, _)| operation_name.is_none() || name.map(Name::as_str) == operation_name)
        else {
            return next.run(ctx, operation_name).await;
        };
        for definition in &operation.node.variable_definitions {
            if let Some(value) = &definition.node.default_value {
                variables
                    .entry(definition.node.name.node.clone())
                    .or_insert_with(|| value.node.clone());
            }
        }
        let projection = Projection {
            fragments: &doc.fragments,
            variables: &variables,
        };
        let fields = projection.fields("Query", &operation.node.selection_set.node);
        if !fields
            .iter()
            .any(|field| matches!(field.name.node.as_str(), "__schema" | "__type"))
        {
            return next.run(ctx, operation_name).await;
        }
        let only_introspection = fields
            .iter()
            .all(|f| matches!(f.name.node.as_str(), "__schema" | "__type" | "__typename"));
        let mut response = if only_introspection {
            Response::new(Value::Object(Default::default()))
        } else {
            next.run(ctx, operation_name).await
        };
        let Value::Object(data) = &mut response.data else {
            return response;
        };
        let mut projected = serde_json::Map::new();
        for field in fields {
            let value = match field.name.node.as_str() {
                "__schema" => projection.object(
                    "__Schema",
                    super::public_schema(),
                    &field.selection_set.node,
                ),
                "__type" => field
                    .get_argument("name")
                    .and_then(|name| {
                        name.node
                            .clone()
                            .into_const_with(|variable| variables.get(&variable).cloned().ok_or(()))
                            .ok()
                    })
                    .and_then(|v| match v {
                        Value::String(name) => super::named_type(&name),
                        _ => None,
                    })
                    .map_or(JsonValue::Null, |ty| {
                        projection.object("__Type", ty, &field.selection_set.node)
                    }),
                "__typename" if only_introspection => json!("Query"),
                _ => continue,
            };
            merge(
                projected
                    .entry(field.response_key().node.to_string())
                    .or_insert(JsonValue::Null),
                value,
            );
        }
        for (key, value) in projected {
            data.insert(
                Name::new(key),
                Value::from_json(value).expect("JSON introspection result"),
            );
        }
        response
    }
}

struct Projection<'a> {
    fragments: &'a HashMap<Name, Positioned<FragmentDefinition>>,
    variables: &'a Variables,
}

impl<'a> Projection<'a> {
    fn fields(&self, ty: &str, set: &'a SelectionSet) -> Vec<&'a AstField> {
        let mut fields = Vec::new();
        self.collect(ty, set, &mut HashSet::new(), &mut fields);
        fields
    }

    fn collect(
        &self,
        ty: &str,
        set: &'a SelectionSet,
        visited: &mut HashSet<&'a Name>,
        fields: &mut Vec<&'a AstField>,
    ) {
        for selection in &set.items {
            let skipped = selection.node.directives().iter().any(|directive| {
                let value = directive.node.get_argument("if").and_then(|v| {
                    v.node
                        .clone()
                        .into_const_with(|var| self.variables.get(&var).cloned().ok_or(()))
                        .ok()
                });
                matches!(
                    (directive.node.name.node.as_str(), value),
                    ("skip", Some(Value::Boolean(true))) | ("include", Some(Value::Boolean(false)))
                )
            });
            if skipped {
                continue;
            }
            match &selection.node {
                Selection::Field(field) => fields.push(&field.node),
                Selection::InlineFragment(fragment)
                    if fragment
                        .node
                        .type_condition
                        .as_ref()
                        .is_none_or(|cond| cond.node.on.node == ty) =>
                {
                    self.collect(ty, &fragment.node.selection_set.node, visited, fields)
                }
                Selection::FragmentSpread(spread) => {
                    let name = &spread.node.fragment_name.node;
                    if visited.insert(name)
                        && let Some(frag) = self.fragments.get(name)
                        && frag.node.type_condition.node.on.node == ty
                    {
                        self.collect(ty, &frag.node.selection_set.node, visited, fields);
                    }
                }
                _ => (),
            }
        }
    }

    fn object(&self, ty: &str, value: &JsonValue, set: &'a SelectionSet) -> JsonValue {
        if value.is_null() {
            return JsonValue::Null;
        }
        // Named type references in the compact metadata carry their name/kind.
        // Resolve against the full definition only when the query traverses them.
        let value = if ty == "__Type" {
            value["name"]
                .as_str()
                .and_then(|name| METADATA.named_type(name))
                .unwrap_or(value)
        } else {
            value
        };
        let mut result = serde_json::Map::new();
        for field in self.fields(ty, set) {
            let name = field.name.node.as_str();
            let value = if name == "__typename" {
                json!(ty)
            } else {
                let entry = &value[name];
                let child = match name {
                    "types" | "queryType" | "mutationType" | "subscriptionType" | "ofType"
                    | "type" | "interfaces" | "possibleTypes" => Some("__Type"),
                    "directives" => Some("__Directive"),
                    "fields" => Some("__Field"),
                    "args" | "inputFields" => Some("__InputValue"),
                    "enumValues" => Some("__EnumValue"),
                    _ => None,
                };
                match child {
                    Some(child) if entry.is_array() => {
                        let include_deprecated =
                            field.get_argument("includeDeprecated").and_then(|v| {
                                v.node
                                    .clone()
                                    .into_const_with(|var| {
                                        self.variables.get(&var).cloned().ok_or(())
                                    })
                                    .ok()
                            }) == Some(Value::Boolean(true));
                        let list = entry
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|v| include_deprecated || v["isDeprecated"] != true)
                            .map(|v| self.object(child, v, &field.selection_set.node))
                            .collect();
                        JsonValue::Array(list)
                    }
                    Some(child) => self.object(child, entry, &field.selection_set.node),
                    None => entry.clone(),
                }
            };
            merge(
                result
                    .entry(field.response_key().node.to_string())
                    .or_insert(JsonValue::Null),
                value,
            );
        }
        JsonValue::Object(result)
    }
}

// Multiple appearances of the same response key contribute their selected subfields.
fn merge(target: &mut JsonValue, more: JsonValue) {
    match (target, more) {
        (JsonValue::Object(target), JsonValue::Object(more)) => {
            for (key, value) in more {
                merge(target.entry(key).or_insert(JsonValue::Null), value);
            }
        }
        (JsonValue::Array(target), JsonValue::Array(more)) => {
            for (a, b) in target.iter_mut().zip(more) {
                merge(a, b);
            }
        }
        (target, more) => *target = more,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn introspection_handles_inline_fragments_variables_typename_and_key_merging() {
        // Disabled introspection detects __schema inside inline fragments.
        let disabled = crate::schema::build_schema(false).expect("schema builds");
        let blocked = disabled
            .execute("{ ... on Query { __schema { queryType { name } } } }")
            .await;
        assert_eq!(blocked.errors.len(), 1);
        assert_eq!(
            blocked.errors[0]
                .extensions
                .as_ref()
                .unwrap()
                .get("validationErrorCode"),
            Some(&Value::from("INTROSPECTION_DISABLED"))
        );

        let enabled = crate::schema::build_schema(true).expect("schema builds");

        // Variable default value, non-string __type(name:), unknown type, __typename inside __type,
        // includeDeprecated via variable, fragment spread on wrong type, and response key merging.
        let q = r#"
          query Intro($typeName: String = "Seller", $dep: Boolean = true, $nullName: String = null) {
            seller: __type(name: $typeName) {
              __typename
              name
              fields(includeDeprecated: $dep) { name }
            }
            missing: __type(name: "DoesNotExist") { name }
            nullType: __type(name: $nullName) { name }
            ... on Query {
              __schema {
                types { name }
                types { kind }
              }
            }
          }
        "#;
        let res = enabled.execute(q).await.into_result().unwrap();
        let data = res.data.into_json().unwrap();
        assert_eq!(data["seller"]["__typename"], "__Type");
        assert_eq!(data["seller"]["name"], "Seller");
        assert_eq!(data["missing"], JsonValue::Null);
        assert_eq!(data["nullType"], JsonValue::Null);
        assert!(data["__schema"]["types"].as_array().unwrap().len() > 1);

        // Direct Projection::collect skips spreads/inline fragments targeting another type.
        let parsed = async_graphql::parser::parse_query(
            "query { ...OtherType ... on Offer { id } } fragment OtherType on Offer { id }",
        )
        .unwrap();
        let (_, op) = parsed.operations.iter().next().unwrap();
        let proj = Projection {
            fragments: &parsed.fragments,
            variables: &Variables::default(),
        };
        assert!(proj.fields("Query", &op.node.selection_set.node).is_empty());

        // Multiple operations in document where operation_name selects one.
        let multi = enabled
            .execute(
                async_graphql::Request::new(
                    "query A { __type(name: \"Seller\") { name } } query B { __typename }",
                )
                .operation_name("B"),
            )
            .await
            .into_result()
            .unwrap();
        assert_eq!(
            multi.data.into_json().unwrap(),
            json!({ "__typename": "Query" })
        );

        // Merging scalar overwrite fallback.
        let mut target = json!({"a": [1]});
        merge(&mut target, json!({"a": [2], "b": 3}));
        assert_eq!(target, json!({"a": [2], "b": 3}));
    }
}
