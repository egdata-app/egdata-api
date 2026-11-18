//! GraphQL-js coerces JSON variables before resolving any fields. Invalid values are
//! withheld from async-graphql's argument validator so document errors take precedence.
use async_graphql::{
    ErrorExtensionValues, Pos, ServerError,
    parser::types::{BaseType, OperationDefinition, Type},
};
use chrono::{DateTime, Utc};
use egdata_core::v1::{
    query::format_js_number,
    serialization::{js_iso_datetime, node_json},
};
use serde_json::{Map, Value, json};

const MAX_ERRORS: usize = 50;

pub struct VariableErrors(pub(crate) Vec<ServerError>);

impl VariableErrors {
    pub fn for_operation(operation: &OperationDefinition, variables: &mut Value) -> Self {
        let mut errors = Self(Vec::new());
        let mut coerced = Map::new();
        for definition in &operation.variable_definitions {
            if errors.0.len() > MAX_ERRORS {
                break;
            }
            let var = &definition.node;
            let name = var.name.node.as_str();
            let ty = &var.var_type.node;
            let previous = errors.0.len();
            let default = var
                .default_value
                .as_ref()
                .and_then(|v| v.node.clone().into_json().ok());
            let value = variables.get(name).or(default.as_ref());
            let result = match value {
                None if !ty.nullable => {
                    errors.push(
                        format!("Variable \"${name}\" of required type \"{ty}\" was not provided."),
                        definition.pos,
                    );
                    None
                }
                None => None,
                Some(Value::Null) if !ty.nullable => {
                    errors.push(
                        format!("Variable \"${name}\" of non-null type \"{ty}\" must not be null."),
                        definition.pos,
                    );
                    None
                }
                Some(value) => {
                    let mut context = Variable {
                        name,
                        pos: definition.pos,
                        errors: &mut errors,
                    };
                    Some(context.coerce(ty, value, name))
                }
            };
            if errors.0.len() == previous
                && let Some(value) = result
            {
                coerced.insert(name.into(), value);
            }
        }
        *variables = Value::Object(coerced);
        errors
    }

    fn push(&mut self, message: String, pos: Pos) {
        let (mut error, code) = match self.0.len() {
            n if n < MAX_ERRORS => (ServerError::new(message, Some(pos)), "BAD_USER_INPUT"),
            MAX_ERRORS => (
                ServerError::new(
                    "Too many errors processing variables, error limit reached. Execution aborted.",
                    None,
                ),
                "INTERNAL_SERVER_ERROR",
            ),
            _ => return,
        };
        let mut extensions = ErrorExtensionValues::default();
        extensions.set("code", code);
        error.extensions = Some(extensions);
        self.0.push(error);
    }
}

struct Variable<'a> {
    name: &'a str,
    pos: Pos,
    errors: &'a mut VariableErrors,
}

impl Variable<'_> {
    fn coerce(&mut self, ty: &Type, value: &Value, path: &str) -> Value {
        if value.is_null() {
            if !ty.nullable {
                self.invalid(
                    value,
                    path,
                    format!("Expected non-nullable type \"{ty}\" not to be null."),
                );
            }
            return Value::Null;
        }
        match &ty.base {
            BaseType::List(item) => {
                let Some(values) = value.as_array() else {
                    return Value::Array(vec![self.coerce(item, value, path)]);
                };
                let mut list = Vec::with_capacity(values.len());
                for (index, value) in values.iter().enumerate() {
                    if self.errors.0.len() > MAX_ERRORS {
                        break;
                    }
                    list.push(self.coerce(item, value, &format!("{path}[{index}]")));
                }
                Value::Array(list)
            }
            BaseType::Named(name) => match scalar_or_enum(name.as_str(), value) {
                Ok(value) => value,
                Err(detail) => {
                    self.invalid(value, path, detail);
                    Value::Null
                }
            },
        }
    }

    fn invalid(&mut self, value: &Value, path: &str, detail: String) {
        let location = if path == self.name {
            String::new()
        } else {
            format!(" at \"{path}\"")
        };
        self.errors.push(
            format!(
                "Variable \"${}\" got invalid value {}{location}; {detail}",
                self.name,
                crate::schema::inspect(value, 0)
            ),
            self.pos,
        );
    }
}

fn scalar_or_enum(name: &str, value: &Value) -> Result<Value, String> {
    let inspected = || crate::schema::inspect(value, 0);
    match name {
        "Int" => {
            let number = value.as_f64().filter(|v| v.fract() == 0.).ok_or_else(|| {
                format!("Int cannot represent non-integer value: {}", inspected())
            })?;
            if !(f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&number) {
                return Err(format!(
                    "Int cannot represent non 32-bit signed integer value: {}",
                    format_js_number(number)
                ));
            }
            Ok(json!(number as i32))
        }
        "Float" if !value.is_number() => Err(format!(
            "Float cannot represent non numeric value: {}",
            inspected()
        )),
        "String" if !value.is_string() => Err(format!(
            "String cannot represent a non string value: {}",
            inspected()
        )),
        "Boolean" if !value.is_boolean() => Err(format!(
            "Boolean cannot represent a non boolean value: {}",
            inspected()
        )),
        "ID" if !value.is_string() => value
            .as_f64()
            .filter(|v| v.fract() == 0.)
            .map(|v| json!(format_js_number(v)))
            .ok_or_else(|| format!("ID cannot represent value: {}", inspected())),
        "DateTime" => {
            let date = value.as_str().ok_or_else(|| {
                format!(
                    "DateTime cannot represent non string or Date type {}",
                    node_json(value)
                )
            })?;
            if date
                .as_bytes()
                .get(10)
                .is_some_and(|c| c.eq_ignore_ascii_case(&b'T'))
                && date.get(17..19).is_some_and(|s| s != "60")
                && let Ok(utc) = DateTime::parse_from_rfc3339(date)
            {
                Ok(json!(js_iso_datetime(utc.with_timezone(&Utc))))
            } else {
                Err(format!(
                    "DateTime cannot represent an invalid date-time-string {date}."
                ))
            }
        }
        "String" | "Boolean" | "Float" | "ID" | "JSON" => Ok(value.clone()),
        _ => {
            let Some(enums) =
                crate::schema::named_type(name).and_then(|ty| ty["enumValues"].as_array())
            else {
                return Ok(value.clone());
            };
            let options = enums
                .iter()
                .filter_map(|e| e["name"].as_str())
                .collect::<Vec<_>>();
            if let Some(text) = value.as_str() {
                if options.contains(&text) {
                    return Ok(value.clone());
                }
                Err(format!(
                    "Value \"{text}\" does not exist in \"{name}\" enum.{}",
                    enum_suggestions(text, &options)
                ))
            } else {
                let text = inspected();
                Err(format!(
                    "Enum \"{name}\" cannot represent non-string value: {text}.{}",
                    enum_suggestions(&text, &options)
                ))
            }
        }
    }
}

fn enum_suggestions(input: &str, options: &[&str]) -> String {
    let size = input.encode_utf16().count();
    let limit = size * 2 / 5 + 1;
    let lower = input.to_lowercase();
    let mut matches = options
        .iter()
        .filter_map(|&name| {
            if name.len().abs_diff(size) > limit {
                return None;
            }
            let distance = if name.eq_ignore_ascii_case(input) {
                1
            } else {
                strsim::osa_distance(&lower, &name.to_ascii_lowercase())
            };
            (distance <= limit).then_some((distance, name))
        })
        .collect::<Vec<_>>();
    matches.sort_unstable();
    let suggestions = matches
        .iter()
        .take(5)
        .map(|(_, s)| format!("\"{s}\""))
        .collect::<Vec<_>>();
    let joined = match suggestions.as_slice() {
        [] => return String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} or {b}"),
        [first @ .., last] => format!("{}, or {last}", first.join(", ")),
    };
    format!(" Did you mean the enum value {joined}?")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn typename_directive_variable_is_validated_before_execution() {
        let schema = crate::schema::build_schema(true).unwrap();
        for (input, expected) in [
            (json!(true), json!({"field":"Query"})),
            (json!(false), json!({})),
            (json!(1), Value::Null),
        ] {
            let source = "query($show:Boolean!){field: __typename @include(if:$show)}";
            let doc = async_graphql::parser::parse_query(source).unwrap();
            let operation = doc.operations.iter().next().unwrap().1;
            let mut vars = json!({"show":input});
            let errors = VariableErrors::for_operation(&operation.node, &mut vars);
            let request = async_graphql::Request::new(source)
                .data(errors)
                .variables(async_graphql::Variables::from_json(vars));
            let response = schema.execute(request).await;
            if input.is_number() {
                assert_eq!(response.errors.len(), 1);
                assert_eq!(
                    response.errors[0].extensions.as_ref().unwrap().get("code"),
                    Some(&async_graphql::Value::from("BAD_USER_INPUT"))
                );
            } else {
                assert!(response.is_ok(), "{:?}", response.errors);
                assert_eq!(response.data.into_json().unwrap(), expected);
            }
        }
    }
    #[test]
    fn graphql_variable_coercion_node_oracle() {
        let fixture: Vec<Value> =
            serde_json::from_str(include_str!("../../../oracles/graphql-variables-node.json"))
                .unwrap();
        for case in fixture {
            let name = &case["name"];
            let document =
                async_graphql::parser::parse_query(case["query"].as_str().unwrap()).unwrap();
            let operation = document.operations.iter().next().unwrap().1;
            let mut variables = case["variables"].clone();
            let errors = VariableErrors::for_operation(&operation.node, &mut variables);
            if let Some(expected) = case.get("errors") {
                let actual = errors
                    .0
                    .iter()
                    .map(|e| {
                        let mut result = json!({"message":e.message});
                        if !e.locations.is_empty() {
                            result["locations"] = json!(e.locations);
                        }
                        result
                    })
                    .collect::<Vec<_>>();
                assert_eq!(json!(actual), *expected, "{name}");
            } else {
                assert!(errors.0.is_empty(), "{name}: {:?}", errors.0);
                assert_eq!(variables, case["coerced"], "{name}");
            }
        }
    }

    #[test]
    fn variable_error_limit_and_enum_suggestion_branches() {
        // Trigger > MAX_ERRORS (50) across both variable definitions and list elements.
        let var_defs = (0..55)
            .map(|i| format!("$v{i}: Int!"))
            .collect::<Vec<_>>()
            .join(", ");
        let source = format!("query({var_defs}) {{ __typename }}");
        let doc = async_graphql::parser::parse_query(&source).unwrap();
        let op = doc.operations.iter().next().unwrap().1;
        let mut vars = json!({});
        let errors = VariableErrors::for_operation(&op.node, &mut vars);
        assert_eq!(errors.0.len(), MAX_ERRORS + 1);
        assert_eq!(
            errors.0.last().unwrap().message,
            "Too many errors processing variables, error limit reached. Execution aborted."
        );

        let list_doc =
            async_graphql::parser::parse_query("query($xs: [Int!]!) { __typename }").unwrap();
        let list_op = list_doc.operations.iter().next().unwrap().1;
        let mut list_vars = json!({ "xs": vec![Value::Null; 55] });
        let list_errors = VariableErrors::for_operation(&list_op.node, &mut list_vars);
        assert_eq!(list_errors.0.len(), MAX_ERRORS + 1);

        // Non-enum custom type falls through unchanged.
        assert_eq!(
            scalar_or_enum("UnknownCustomScalar", &json!({"a": 1})).unwrap(),
            json!({"a": 1})
        );

        // Enum suggestion formatting: 1, 2 ("or"), 3+ (", or").
        assert_eq!(
            enum_suggestions("X", &["XA", "XB"]),
            " Did you mean the enum value \"XA\" or \"XB\"?"
        );
        assert_eq!(
            enum_suggestions("X", &["XA", "XB", "XC"]),
            " Did you mean the enum value \"XA\", \"XB\", or \"XC\"?"
        );

        // Direct VariableErrors::push beyond MAX_ERRORS + 1 returns early.
        let mut direct_errs = VariableErrors(Vec::new());
        for _ in 0..=MAX_ERRORS + 2 {
            direct_errs.push("err".into(), Pos::default());
        }
        assert_eq!(direct_errs.0.len(), MAX_ERRORS + 1);
    }
}
