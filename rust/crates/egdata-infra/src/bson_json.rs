//! MongoDB driver JSON conversion for legacy routes.
pub use egdata_core::bson_json::*;

#[cfg(test)]
mod tests {
    use super::*;
    use bson::Bson;
    use bson::{
        Binary, Decimal128, JavaScriptCodeWithScope, Regex, Timestamp, doc, oid::ObjectId,
        spec::BinarySubtype,
    };
    use chrono::TimeZone;
    use serde_json::{Value, json};

    #[test]
    fn real_node_bson_driver_wire_bytes() {
        use egdata_core::v1::serialization::{bson_to_serialized_json, node_json};
        let rows: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/bson-driver-wire-node.json"
        ))
        .unwrap();
        for row in rows {
            let wire = hex::decode(row["bson"].as_str().unwrap()).unwrap();
            let doc =
                crate::mongo::native_document(bson::RawDocumentBuf::from_bytes(wire).unwrap())
                    .unwrap();
            assert_eq!(
                node_json(&bson_doc_to_js_json(&doc)),
                row["legacy"],
                "legacy {}",
                row["name"]
            );
            assert_eq!(
                node_json(&bson_to_serialized_json(&Bson::Document(doc))),
                row["v1"],
                "v1 {}",
                row["name"]
            );
        }
    }

    #[test]
    fn json_numbers_match_the_node_parsers_precision() {
        use egdata_core::v1::serialization::node_json;
        let rows: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/json-integers-node.json"
        ))
        .unwrap();
        for row in rows {
            let number = serde_json::from_str(row["input"].as_str().unwrap()).unwrap();
            assert_eq!(node_json(&number), row["output"], "{}", row["input"]);
        }
    }

    #[test]
    fn converts_primitives_and_numbers_intact() {
        let oid = ObjectId::parse_str("507f1f77bcf86cd799439011").unwrap();
        let chrono_dt = chrono::Utc
            .with_ymd_and_hms(2025, 3, 14, 15, 9, 26)
            .unwrap()
            + chrono::Duration::milliseconds(42);
        let dt = bson::DateTime::from_chrono(chrono_dt);

        let doc = doc! {
            "_id": oid,
            "int32": 42_i32,
            "int64": 9_007_199_254_740_991_i64,
            "float": 3.25_f64,
            "nan": f64::NAN,
            "bool": true,
            "str": "hello",
            "nullVal": Bson::Null,
            "undef": Bson::Undefined,
            "date": dt,
            "nested": { "k": "v" },
            "arr": [1_i32, Bson::Undefined, "x"],
        };

        let json = bson_doc_to_js_json(&doc);
        let obj = json.as_object().unwrap();
        assert_eq!(obj.get("_id").unwrap(), "507f1f77bcf86cd799439011");
        assert_eq!(obj.get("int32").unwrap(), 42);
        assert_eq!(obj.get("int64").unwrap(), 9_007_199_254_740_991_i64);
        assert_eq!(obj.get("float").unwrap(), 3.25);
        assert_eq!(obj.get("nan").unwrap(), &Value::Null);
        assert_eq!(obj.get("bool").unwrap(), true);
        assert_eq!(obj.get("str").unwrap(), "hello");
        assert_eq!(obj.get("nullVal").unwrap(), &Value::Null);
        assert!(!obj.contains_key("undef"));
        assert_eq!(obj.get("date").unwrap(), "2025-03-14T15:09:26.042Z");
        assert_eq!(obj.get("nested").unwrap(), &serde_json::json!({"k": "v"}));
        assert_eq!(obj.get("arr").unwrap(), &serde_json::json!([1, null, "x"]));
    }

    #[test]
    fn converts_remaining_bson_variants() {
        let dec: Decimal128 = "12.34".parse().unwrap();
        let bin = Binary {
            subtype: BinarySubtype::Generic,
            bytes: vec![1, 2, 3],
        };
        let ts = Timestamp {
            time: 100,
            increment: 2,
        };
        let re = Regex {
            pattern: "abc".into(),
            options: "i".into(),
        };
        let js_scope = JavaScriptCodeWithScope {
            code: "return 1;".into(),
            scope: doc! {},
        };

        assert_eq!(
            bson_to_js_json(&Bson::RegularExpression(re)),
            serde_json::json!({})
        );
        assert_eq!(
            bson_to_js_json(&Bson::JavaScriptCode("x".into())),
            json!({"code":"x"})
        );
        assert_eq!(
            bson_to_js_json(&Bson::JavaScriptCodeWithScope(js_scope)),
            json!({"code":"return 1;", "scope":{}})
        );
        assert_eq!(
            bson_to_js_json(&Bson::Timestamp(ts)),
            json!({"$timestamp": "429496729602"})
        );
        assert_eq!(
            bson_to_js_json(&Bson::Binary(bin)),
            Value::String("AQID".into())
        );
        assert_eq!(
            bson_to_js_json(&Bson::Symbol("sym".into())),
            Value::String("sym".into())
        );
        assert_eq!(
            bson_to_js_json(&Bson::Decimal128(dec)),
            json!({"$numberDecimal":"12.34"})
        );
        assert_eq!(bson_to_js_json(&Bson::MinKey), json!({}));
        assert_eq!(bson_to_js_json(&Bson::MaxKey), json!({}));
    }
}
