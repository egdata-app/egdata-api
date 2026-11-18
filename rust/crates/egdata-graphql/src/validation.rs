//! GraphQL query depth, alias, and byte-size validation matching `src/graphql/validation.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_graphql::extensions::{
    Extension, ExtensionContext, ExtensionFactory, NextParseQuery, NextValidation,
};
use async_graphql::parser::types::{
    DocumentOperations, ExecutableDocument, FragmentDefinition, InlineFragment, Selection,
    SelectionSet,
};
use async_graphql::{
    ErrorExtensionValues, Name, Positioned, ServerError, ServerResult, ValidationResult, Variables,
};
use async_trait::async_trait;

/// Maximum allowed selection-set nesting depth by default (`src/graphql/validation.ts`).
pub const DEFAULT_MAX_DEPTH: usize = 12;

/// Maximum allowed aliased fields per document by default (`src/graphql/validation.ts`).
pub const DEFAULT_MAX_ALIASES: usize = 50;

/// Maximum allowed GraphQL query source size in UTF-8 bytes (`100 * 1024`).
pub const MAX_QUERY_BYTES: usize = 100 * 1024;

/// Error extension code emitted when query byte size exceeds [`MAX_QUERY_BYTES`].
pub const QUERY_TOO_LARGE_CODE: &str = "QUERY_TOO_LARGE";

/// Error extension code emitted when query nesting depth exceeds `max_depth`.
pub const QUERY_DEPTH_EXCEEDED_CODE: &str = "QUERY_DEPTH_EXCEEDED";

/// Error extension code emitted when aliased field count exceeds `max_aliases`.
pub const QUERY_ALIAS_LIMIT_EXCEEDED_CODE: &str = "QUERY_ALIAS_LIMIT_EXCEEDED";

fn resolve_limit(value: usize, fallback: usize) -> usize {
    if value >= 1 { value } else { fallback }
}

fn is_introspection_field(name: &str) -> bool {
    matches!(name, "__schema" | "__type" | "__typename")
}

fn measure_fragment_depth(
    name: &str,
    fragments: &HashMap<Name, Positioned<FragmentDefinition>>,
    fragment_depths: &mut HashMap<String, usize>,
    visiting: &mut HashSet<String>,
) -> usize {
    if let Some(&cached) = fragment_depths.get(name) {
        return cached;
    }

    // Invalid cyclic fragments are reported by standard validation; avoid recursing forever.
    if visiting.contains(name) {
        return 0;
    }

    let Some(fragment) = fragments.get(name) else {
        return 0;
    };

    visiting.insert(name.to_string());
    let depth = measure_selection_set(
        &fragment.node.selection_set.node,
        fragments,
        fragment_depths,
        visiting,
    );
    visiting.remove(name);
    fragment_depths.insert(name.to_string(), depth);

    depth
}

fn measure_selection_set(
    selection_set: &SelectionSet,
    fragments: &HashMap<Name, Positioned<FragmentDefinition>>,
    fragment_depths: &mut HashMap<String, usize>,
    visiting: &mut HashSet<String>,
) -> usize {
    let mut max_child_depth = 0;

    for selection in &selection_set.items {
        match &selection.node {
            Selection::Field(field) => {
                if is_introspection_field(field.node.name.node.as_str()) {
                    continue;
                }

                let child_depth = if field.node.selection_set.node.items.is_empty() {
                    0
                } else {
                    measure_selection_set(
                        &field.node.selection_set.node,
                        fragments,
                        fragment_depths,
                        visiting,
                    )
                };
                max_child_depth = max_child_depth.max(child_depth + 1);
            }
            Selection::InlineFragment(inline) => {
                let frag_depth = measure_selection_set(
                    &inline.node.selection_set.node,
                    fragments,
                    fragment_depths,
                    visiting,
                );
                max_child_depth = max_child_depth.max(frag_depth);
            }
            Selection::FragmentSpread(spread) => {
                let frag_depth = measure_fragment_depth(
                    spread.node.fragment_name.node.as_str(),
                    fragments,
                    fragment_depths,
                    visiting,
                );
                max_child_depth = max_child_depth.max(frag_depth);
            }
        }
    }

    max_child_depth
}

/// Validates operation nesting depth against `max_depth` (`createDepthLimitRule` parity).
pub fn validate_depth_limit(doc: &ExecutableDocument, max_depth: usize) -> Vec<ServerError> {
    let resolved_max = resolve_limit(max_depth, DEFAULT_MAX_DEPTH);
    let mut fragment_depths = HashMap::new();
    let mut errors = Vec::new();

    let mut operations = doc.operations.iter().map(|(_, op)| op).collect::<Vec<_>>();
    operations.sort_unstable_by_key(|op| op.pos);
    for operation in operations {
        let mut visiting = HashSet::new();
        let depth = measure_selection_set(
            &operation.node.selection_set.node,
            &doc.fragments,
            &mut fragment_depths,
            &mut visiting,
        );

        if depth > resolved_max {
            let mut ext = ErrorExtensionValues::default();
            ext.set("code", QUERY_DEPTH_EXCEEDED_CODE);
            ext.set("depth", depth);
            ext.set("maxDepth", resolved_max);

            let mut err = ServerError::new(
                format!(
                    "Query depth of {depth} exceeds the maximum allowed depth of {resolved_max}."
                ),
                Some(operation.pos),
            );
            err.extensions = Some(ext);
            errors.push(err);
        }
    }

    errors
}

fn count_aliases_in_selection_set(
    selection_set: &SelectionSet,
    alias_count: &mut usize,
    reported: &mut bool,
    resolved_max: usize,
    errors: &mut Vec<ServerError>,
) {
    for selection in &selection_set.items {
        match &selection.node {
            Selection::Field(field) => {
                if field.node.alias.is_some() {
                    *alias_count += 1;
                    if !*reported && *alias_count > resolved_max {
                        *reported = true;
                        let mut ext = ErrorExtensionValues::default();
                        ext.set("code", QUERY_ALIAS_LIMIT_EXCEEDED_CODE);
                        ext.set("aliasCount", *alias_count);
                        ext.set("maxAliases", resolved_max);

                        let mut err = ServerError::new(
                            format!("Query contains more than {resolved_max} aliased fields."),
                            Some(field.pos),
                        );
                        err.extensions = Some(ext);
                        errors.push(err);
                    }
                }
                if !field.node.selection_set.node.items.is_empty() {
                    count_aliases_in_selection_set(
                        &field.node.selection_set.node,
                        alias_count,
                        reported,
                        resolved_max,
                        errors,
                    );
                }
            }
            Selection::InlineFragment(inline) => {
                count_aliases_in_selection_set(
                    &inline.node.selection_set.node,
                    alias_count,
                    reported,
                    resolved_max,
                    errors,
                );
            }
            Selection::FragmentSpread(_) => {}
        }
    }
}

/// Validates total aliased fields across operations and fragments (`createMaxAliasesRule` parity).
pub fn validate_max_aliases(doc: &ExecutableDocument, max_aliases: usize) -> Vec<ServerError> {
    let resolved_max = resolve_limit(max_aliases, DEFAULT_MAX_ALIASES);
    let mut alias_count = 0;
    let mut reported = false;
    let mut errors = Vec::new();

    // graphql-js visits definitions in source order. Parsing into maps loses
    // that order, including fragments written before the selected operation.
    let mut sets = doc
        .operations
        .iter()
        .map(|(_, op)| &op.node.selection_set)
        .chain(doc.fragments.values().map(|frag| &frag.node.selection_set))
        .collect::<Vec<_>>();
    sets.sort_unstable_by_key(|set| set.pos);
    for set in sets {
        count_aliases_in_selection_set(
            &set.node,
            &mut alias_count,
            &mut reported,
            resolved_max,
            &mut errors,
        );
    }

    errors
}

/// Runs both depth and alias validation rules against a parsed GraphQL document.
pub fn validate_document_limits(
    doc: &ExecutableDocument,
    max_depth: usize,
    max_aliases: usize,
) -> Vec<ServerError> {
    let mut errors = validate_depth_limit(doc, max_depth);
    errors.extend(validate_max_aliases(doc, max_aliases));
    errors.sort_by_key(|error| error.locations.first().copied());
    errors
}

/// Checks whether `source` exceeds `max_bytes` UTF-8 bytes and returns a 413 `ServerError`.
pub fn get_query_size_error(source: &str, max_bytes: usize) -> Option<ServerError> {
    let resolved_max = resolve_limit(max_bytes, MAX_QUERY_BYTES);
    let size_bytes = source.len();

    if size_bytes <= resolved_max {
        return None;
    }

    let mut ext = ErrorExtensionValues::default();
    ext.set("code", QUERY_TOO_LARGE_CODE);
    ext.set("sizeBytes", size_bytes);
    ext.set("maxBytes", resolved_max);
    ext.set(
        "http",
        async_graphql::Value::Object({
            let mut map = async_graphql::indexmap::IndexMap::new();
            map.insert(Name::new("status"), async_graphql::Value::from(413));
            map
        }),
    );

    let mut err = ServerError::new(
        format!(
            "Query size of {size_bytes} bytes exceeds the maximum allowed size of {resolved_max} bytes."
        ),
        None,
    );
    err.extensions = Some(ext);
    Some(err)
}

/// Validates the canonical 100 KiB source limit at the HTTP bridge boundary,
/// before parsing. Depth and alias validation runs through
/// [`ValidationExtensionFactory`] after the document has been parsed.
pub fn validate_query_source(source: &str) -> Option<ServerError> {
    get_query_size_error(source, MAX_QUERY_BYTES)
}

/// Extracts an explicit HTTP status code from `ServerError.extensions.http.status` if present.
pub fn extract_error_http_status(error: &ServerError) -> Option<u16> {
    let ext = error.extensions.as_ref()?;
    let http = ext.get("http")?;
    if let async_graphql::Value::Object(map) = http
        && let Some(async_graphql::Value::Number(num)) = map.get("status")
    {
        return num.as_u64().and_then(|s| u16::try_from(s).ok());
    }
    None
}

/// Extension factory enforcing query byte-size, depth, and alias limits on every request.
#[derive(Debug, Clone, Copy)]
pub struct ValidationExtensionFactory {
    pub max_depth: usize,
    pub max_aliases: usize,
    pub max_query_bytes: usize,
}

impl Default for ValidationExtensionFactory {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
            max_aliases: DEFAULT_MAX_ALIASES,
            max_query_bytes: MAX_QUERY_BYTES,
        }
    }
}

impl ExtensionFactory for ValidationExtensionFactory {
    fn create(&self) -> Arc<dyn Extension> {
        Arc::new(ValidationExtension {
            max_depth: self.max_depth,
            max_aliases: self.max_aliases,
            max_query_bytes: self.max_query_bytes,
            doc: Mutex::new(None),
        })
    }
}

struct ValidationExtension {
    max_depth: usize,
    max_aliases: usize,
    max_query_bytes: usize,
    doc: Mutex<Option<ExecutableDocument>>,
}

pub use crate::variables::VariableErrors;

/// A transport rejection that must wait until the document passes static validation.
pub struct OperationError(pub ServerError);

// async-graphql's document validator skips __typename and its directives. An
// inline fragment gives @include/@skip the same fields and lets the engine see
// their variables, argument types and source locations during validation.
fn expose_typename_directives(selections: &mut SelectionSet) {
    for selection in &mut selections.items {
        match &mut selection.node {
            Selection::Field(field)
                if field.node.name.node == "__typename" && !field.node.directives.is_empty() =>
            {
                let directives = std::mem::take(&mut field.node.directives);
                let pos = selection.pos;
                let inner = SelectionSet {
                    items: vec![selection.clone()],
                };
                selection.node = Selection::InlineFragment(Positioned::new(
                    InlineFragment {
                        type_condition: None,
                        directives,
                        selection_set: Positioned::new(inner, pos),
                    },
                    pos,
                ));
            }
            Selection::Field(field) => {
                expose_typename_directives(&mut field.node.selection_set.node)
            }
            Selection::InlineFragment(fragment) => {
                expose_typename_directives(&mut fragment.node.selection_set.node)
            }
            Selection::FragmentSpread(_) => (),
        }
    }
}

#[async_trait]
impl Extension for ValidationExtension {
    async fn parse_query(
        &self,
        ctx: &ExtensionContext<'_>,
        query: &str,
        variables: &Variables,
        next: NextParseQuery<'_>,
    ) -> ServerResult<ExecutableDocument> {
        if let Some(err) = get_query_size_error(query, self.max_query_bytes) {
            return Err(err);
        }

        let mut doc = next.run(ctx, query, variables).await?;
        if let Ok(mut guard) = self.doc.lock() {
            *guard = Some(doc.clone());
        }
        if query.contains("__typename") {
            match &mut doc.operations {
                DocumentOperations::Single(op) => {
                    expose_typename_directives(&mut op.node.selection_set.node)
                }
                DocumentOperations::Multiple(ops) => {
                    for op in ops.values_mut() {
                        expose_typename_directives(&mut op.node.selection_set.node);
                    }
                }
            }
            for fragment in doc.fragments.values_mut() {
                expose_typename_directives(&mut fragment.node.selection_set.node);
            }
        }
        Ok(doc)
    }

    async fn validation(
        &self,
        ctx: &ExtensionContext<'_>,
        next: NextValidation<'_>,
    ) -> Result<ValidationResult, Vec<ServerError>> {
        let standard = next.run(ctx).await;
        let custom_errors = self
            .doc
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .map(|doc| validate_document_limits(&doc, self.max_depth, self.max_aliases))
            .unwrap_or_default();

        match (standard, custom_errors.is_empty()) {
            (Ok(_), true) if ctx.data_opt::<OperationError>().is_some() => {
                Err(vec![ctx.data_unchecked::<OperationError>().0.clone()])
            }
            (Ok(res), true) => match ctx.data_opt::<VariableErrors>() {
                Some(errors) if !errors.0.is_empty() => Err(errors.0.clone()),
                _ => Ok(res),
            },
            (Ok(_), false) => Err(custom_errors),
            (Err(mut errs), _) => {
                errs.extend(custom_errors);
                Err(errs)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_graphql::parser::parse_query;
    use async_graphql::{EmptyMutation, EmptySubscription, Object, Schema};

    fn nested_query(depth: usize) -> String {
        let levels = depth.saturating_sub(1);
        format!(
            "{{ {}value{} }}",
            "nested { ".repeat(levels),
            " }".repeat(levels)
        )
    }

    fn aliased_query(count: usize) -> String {
        let fields: Vec<String> = (0..count).map(|i| format!("alias{i}: value")).collect();
        format!("{{ {} }}", fields.join(" "))
    }

    fn validate_str(query: &str, max_depth: usize, max_aliases: usize) -> Vec<ServerError> {
        let doc = parse_query(query).expect("valid GraphQL syntax");
        validate_document_limits(&doc, max_depth, max_aliases)
    }

    #[test]
    fn nested_alias_errors_follow_document_order_and_do_not_set_http_status() {
        let errors = validate_str(
            "query A { a: nested { b: nested { value } } } query B { nested { value } }",
            1,
            1,
        );
        assert_eq!(errors.len(), 3);
        assert_eq!(
            errors
                .iter()
                .map(|e| e.locations[0].column)
                .collect::<Vec<_>>(),
            [1, 23, 47]
        );
        assert!(
            errors
                .iter()
                .all(|e| extract_error_http_status(e).is_none())
        );
    }

    #[test]
    fn depth_limit_allows_valid_and_rejects_excessive() {
        assert!(
            validate_str(
                "{ nested { nested { value } } }",
                DEFAULT_MAX_DEPTH,
                DEFAULT_MAX_ALIASES
            )
            .is_empty()
        );
        assert!(
            validate_str(
                &nested_query(DEFAULT_MAX_DEPTH),
                DEFAULT_MAX_DEPTH,
                DEFAULT_MAX_ALIASES
            )
            .is_empty()
        );

        let errors_20 = validate_str(&nested_query(20), DEFAULT_MAX_DEPTH, DEFAULT_MAX_ALIASES);
        assert_eq!(errors_20.len(), 1);
        assert!(errors_20[0].message.contains("depth"));
        let ext = errors_20[0].extensions.as_ref().unwrap();
        assert_eq!(
            ext.get("code"),
            Some(&async_graphql::Value::from(QUERY_DEPTH_EXCEEDED_CODE))
        );
        assert_eq!(ext.get("depth"), Some(&async_graphql::Value::from(20)));
        assert_eq!(
            ext.get("maxDepth"),
            Some(&async_graphql::Value::from(DEFAULT_MAX_DEPTH))
        );

        let errors_13 = validate_str(
            &nested_query(DEFAULT_MAX_DEPTH + 1),
            DEFAULT_MAX_DEPTH,
            DEFAULT_MAX_ALIASES,
        );
        assert_eq!(errors_13.len(), 1);
    }

    #[test]
    fn depth_limit_handles_fragments_inline_fragments_introspection_and_cycles() {
        let deep_body = nested_query(20);
        let inner = &deep_body[2..deep_body.len() - 2];

        let frag_query =
            format!("fragment DeepFields on Query {{ {inner} }} query {{ ...DeepFields }}");
        let frag_errors = validate_str(&frag_query, DEFAULT_MAX_DEPTH, DEFAULT_MAX_ALIASES);
        assert_eq!(frag_errors.len(), 1);
        assert_eq!(
            frag_errors[0].extensions.as_ref().unwrap().get("code"),
            Some(&async_graphql::Value::from(QUERY_DEPTH_EXCEEDED_CODE))
        );

        // Spread same fragment twice to exercise fragment depth cache hit, plus unknown fragment.
        let cached_frag_query =
            "fragment F on Query { value } query { ...F ...F ...Missing }".to_string();
        assert!(
            validate_str(&cached_frag_query, DEFAULT_MAX_DEPTH, DEFAULT_MAX_ALIASES).is_empty()
        );

        let inline_query = format!("{{ ... on Query {{ {inner} }} }}");
        let inline_errors = validate_str(&inline_query, DEFAULT_MAX_DEPTH, DEFAULT_MAX_ALIASES);
        assert_eq!(inline_errors.len(), 1);

        // Introspection fields are ignored completely.
        assert!(validate_str("{ __schema { types { name } } }", 1, DEFAULT_MAX_ALIASES).is_empty());
        assert!(
            validate_str(
                "{ __type(name: \"Query\") { fields { name } } }",
                1,
                DEFAULT_MAX_ALIASES
            )
            .is_empty()
        );
        assert!(validate_str("{ nested { __typename } }", 1, DEFAULT_MAX_ALIASES).is_empty());

        // Cyclic fragments terminate without stack overflow.
        let cyclic = "
          query { ...A }
          fragment A on Query { nested { ...B } }
          fragment B on Query { nested { ...A } }
        ";
        let _ = validate_str(cyclic, DEFAULT_MAX_DEPTH, DEFAULT_MAX_ALIASES);
    }

    #[test]
    fn alias_limit_counts_operations_inline_and_named_fragments() {
        assert!(
            validate_str(
                &aliased_query(DEFAULT_MAX_ALIASES),
                DEFAULT_MAX_DEPTH,
                DEFAULT_MAX_ALIASES
            )
            .is_empty()
        );

        let over = validate_str(
            &aliased_query(DEFAULT_MAX_ALIASES + 1),
            DEFAULT_MAX_DEPTH,
            DEFAULT_MAX_ALIASES,
        );
        assert_eq!(over.len(), 1);
        assert!(over[0].message.contains("aliased fields"));
        let ext = over[0].extensions.as_ref().unwrap();
        assert_eq!(
            ext.get("code"),
            Some(&async_graphql::Value::from(QUERY_ALIAS_LIMIT_EXCEEDED_CODE))
        );
        assert_eq!(
            ext.get("maxAliases"),
            Some(&async_graphql::Value::from(DEFAULT_MAX_ALIASES))
        );

        // Custom limit = 2, and fallback when 0 is passed.
        assert!(validate_str(&aliased_query(2), DEFAULT_MAX_DEPTH, 2).is_empty());
        assert_eq!(
            validate_str(&aliased_query(3), DEFAULT_MAX_DEPTH, 2).len(),
            1
        );
        assert!(validate_str(&aliased_query(5), 0, 0).is_empty());

        // Aliases inside fragments & inline fragments & nested selection sets.
        let over_body = aliased_query(DEFAULT_MAX_ALIASES + 1);
        let inner = &over_body[2..over_body.len() - 2];
        let frag_alias_query = format!(
            "fragment AliasedFields on Query {{ ... on Query {{ nested {{ {inner} }} }} }} query {{ ...AliasedFields }}"
        );
        let frag_errs = validate_str(&frag_alias_query, DEFAULT_MAX_DEPTH, DEFAULT_MAX_ALIASES);
        assert_eq!(frag_errs.len(), 1);
        assert_eq!(
            frag_errs[0].extensions.as_ref().unwrap().get("code"),
            Some(&async_graphql::Value::from(QUERY_ALIAS_LIMIT_EXCEEDED_CODE))
        );
    }

    #[test]
    fn query_size_guard_checks_utf8_bytes_and_http_413() {
        assert!(get_query_size_error(&"x".repeat(MAX_QUERY_BYTES), MAX_QUERY_BYTES).is_none());

        let err = get_query_size_error(&"x".repeat(MAX_QUERY_BYTES + 1), MAX_QUERY_BYTES)
            .expect("oversized query error");
        assert!(err.message.contains("maximum allowed size"));
        assert_eq!(
            err.extensions.as_ref().unwrap().get("code"),
            Some(&async_graphql::Value::from(QUERY_TOO_LARGE_CODE))
        );
        assert_eq!(extract_error_http_status(&err), Some(413));
        assert_eq!(
            extract_error_http_status(&ServerError::new("plain", None)),
            None
        );

        // Multi-byte UTF-8 characters count bytes, not chars.
        let utf8_query = "é".repeat(MAX_QUERY_BYTES);
        assert!(get_query_size_error(&utf8_query, MAX_QUERY_BYTES).is_some());
    }

    #[tokio::test]
    async fn validation_extension_enforces_limits_in_schema_execution() {
        struct TestQuery;

        #[Object]
        impl TestQuery {
            async fn nested(&self) -> TestQuery {
                TestQuery
            }
            async fn value(&self) -> &'static str {
                "ok"
            }
        }

        let schema = Schema::build(TestQuery, EmptyMutation, EmptySubscription)
            .extension(ValidationExtensionFactory::default())
            .limit_recursive_depth(256)
            .finish();

        let ok = schema.execute("{ nested { value } }").await;
        assert!(ok.is_ok());

        let oversized = format!("query {{ value }} # {}", "x".repeat(MAX_QUERY_BYTES));
        let large_resp = schema.execute(oversized).await;
        assert_eq!(large_resp.errors.len(), 1);
        assert_eq!(extract_error_http_status(&large_resp.errors[0]), Some(413));

        let deep_resp = schema.execute(nested_query(15)).await;
        assert_eq!(deep_resp.errors.len(), 1);
        assert_eq!(
            deep_resp.errors[0].extensions.as_ref().unwrap().get("code"),
            Some(&async_graphql::Value::from(QUERY_DEPTH_EXCEEDED_CODE))
        );

        let bad_field_and_deep = schema
            .execute("{ nested { nested { nested { nested { nested { nested { nested { nested { nested { nested { nested { nested { missing } } } } } } } } } } } } }")
            .await;
        assert!(!bad_field_and_deep.errors.is_empty());

        // Direct validate_query_source and non-object / out-of-range http status extraction.
        assert!(validate_query_source("{ value }").is_none());
        assert!(validate_query_source(&"x".repeat(MAX_QUERY_BYTES + 1)).is_some());

        let mut bad_http_err = ServerError::new("bad http", None);
        let mut ext = ErrorExtensionValues::default();
        ext.set("http", "not-an-object");
        bad_http_err.extensions = Some(ext);
        assert_eq!(extract_error_http_status(&bad_http_err), None);

        let mut big_status_err = ServerError::new("big status", None);
        let mut ext2 = ErrorExtensionValues::default();
        ext2.set(
            "http",
            async_graphql::Value::Object({
                let mut m = async_graphql::indexmap::IndexMap::new();
                m.insert(Name::new("status"), async_graphql::Value::from(99_999));
                m
            }),
        );
        big_status_err.extensions = Some(ext2);
        assert_eq!(extract_error_http_status(&big_status_err), None);

        // Multi-operation + fragment + inline fragment __typename directive exposure, OperationError & VariableErrors precedence.
        let multi_doc = "
          query One($show: Boolean!) {
            ...Frag
            ... on TestQuery { __typename @include(if: $show) }
          }
          query Two { value }
          fragment Frag on TestQuery { __typename @skip(if: false) }
        ";
        let resp_op_err = schema
            .execute(
                async_graphql::Request::new(multi_doc)
                    .operation_name("One")
                    .variables(Variables::from_json(serde_json::json!({ "show": true })))
                    .data(OperationError(ServerError::new("op rejected", None))),
            )
            .await;
        assert_eq!(resp_op_err.errors[0].message, "op rejected");

        // Static validation errors (depth/alias/unknown field) override OperationError.
        let deep_with_op_err = schema
            .execute(
                async_graphql::Request::new(nested_query(15))
                    .data(OperationError(ServerError::new("op rejected", None))),
            )
            .await;
        assert_eq!(
            deep_with_op_err.errors[0]
                .extensions
                .as_ref()
                .unwrap()
                .get("code"),
            Some(&async_graphql::Value::from(QUERY_DEPTH_EXCEEDED_CODE))
        );
    }
}
