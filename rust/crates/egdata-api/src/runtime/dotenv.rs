//! Parse environment files with the Node origin's dotenv syntax.
use regex::Regex;
use std::{collections::BTreeMap, sync::LazyLock};

pub(super) fn parse(bytes: &[u8]) -> BTreeMap<String, String> {
    // The Node parser accepts exports, colon assignments, quoted multiline
    // values and trailing comments. It leaves dollar signs and escapes literal
    // except for newline and carriage-return escapes inside double quotes.
    static ENTRY: LazyLock<Regex> = LazyLock::new(|| {
        let whitespace = r"[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
        let pattern = concat!(
            r"(?m)^WS*(?:exportWS+)?([A-Za-z0-9_.-]+)",
            r"(?:WS*=WS*?|:WS+?)",
            r#"(WS*'(?:\\'|[^'])*'|WS*"(?:\\"|[^"])*"|WS*`(?:\\`|[^`])*`|[^#\r\n]+)?"#,
            r"WS*(?:#[^\n\r\u{2028}\u{2029}]*)?$",
        );
        Regex::new(&pattern.replace("WS", whitespace)).expect("valid dotenv assignment pattern")
    });
    let lines = String::from_utf8_lossy(bytes)
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut values = BTreeMap::new();
    for entry in ENTRY.captures_iter(&lines) {
        let key = &entry[1];
        if key == "__proto__" {
            continue;
        }
        let value = egdata_core::v1::trim_js_whitespace(entry.get(2).map_or("", |m| m.as_str()));
        let unquoted = match value.as_bytes().first() {
            Some(quote @ (b'\'' | b'"' | b'`'))
                if value.len() >= 2 && value.as_bytes().last() == Some(quote) =>
            {
                &value[1..value.len() - 1]
            }
            _ => value,
        };
        let expanded = if value.starts_with('"') {
            unquoted.replace("\\n", "\n").replace("\\r", "\r")
        } else {
            unquoted.to_owned()
        };
        values.insert(key.into(), expanded);
    }
    values
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_node_dotenv_inputs() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/origin-dotenv-node.json"))
                .unwrap();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let bytes = hex::decode(case["hex"].as_str().unwrap()).unwrap();
            assert_eq!(
                serde_json::json!(super::parse(&bytes)),
                case["parsed"],
                "{name}"
            );
        }
    }
}
