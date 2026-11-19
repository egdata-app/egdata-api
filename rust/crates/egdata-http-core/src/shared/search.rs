//! Shared `search` helpers used by the versioned and unversioned surfaces.
use serde_json::{Value, json};

pub fn text_matches(text: Option<&str>) -> Vec<Value> {
    text.into_iter().map(|title|json!({"bool":{"should":[
        {"multi_match":{"query":title,"fields":["title^4","title.synonym^3","developerDisplayName^2","publisherDisplayName^2","tags.name","description"],"type":"best_fields","fuzziness":"AUTO","operator":"and"}},
        {"match_phrase":{"title":{"query":title,"boost":10,"slop":2}}}
    ],"minimum_should_match":1}})).collect()
}

/// Shared catalog filters in the order used by both Node offer search handlers.
pub fn offer_filters(values: &Value, region: &str, multi: bool, legacy: bool) -> Vec<Value> {
    let mut filters = Vec::new();
    if let Some(value) = values["offerType"].as_str().filter(|v| !v.is_empty()) {
        filters.push(json!({"term":{"offerType.keyword":value}}));
    }
    for (key, field) in [
        ("tags", "tags.id.keyword"),
        ("technologies", "lastBuilds.technologies.technology.keyword"),
    ] {
        if let Some(list) = values[key].as_array().filter(|v| !v.is_empty()) {
            filters.push(json!({"terms_set":{field:{"terms":list,"minimum_should_match_script":{"source":list.len().to_string()}}}}));
        }
    }
    for (key, field) in [
        ("categories", "categories.keyword"),
        ("customAttributes", "customAttributes.keyword"),
    ] {
        if let Some(list) = values[key].as_array().filter(|v| !v.is_empty()) {
            filters.push(json!({"terms":{field:list}}));
        }
    }
    for (key, field) in [
        ("seller", "seller.id.keyword"),
        ("developerDisplayName", "developerDisplayName.keyword"),
        ("publisherDisplayName", "publisherDisplayName.keyword"),
        ("refundType", "refundType.keyword"),
    ] {
        if let Some(value) = values[key].as_str().filter(|v| !v.is_empty()) {
            filters.push(json!({"term":{field:value}}));
        }
    }
    if values["isCodeRedemptionOnly"] == true {
        filters.push(json!({"term":{"isCodeRedemptionOnly":true}}));
    }
    if values["excludeBlockchain"] == true {
        filters.push(
            json!({"bool":{"must_not":[{"term":{"customAttributes.isBlockchainUsed":true}}]}}),
        );
    }
    if values["pastGiveaways"] == true {
        filters.push(json!({"exists":{"field":"freeEntries"}}));
    }
    let mut range = serde_json::Map::new();
    for (key, op) in [("min", "gte"), ("max", "lte")] {
        let n = if multi {
            &values[if key == "min" { "priceMin" } else { "priceMax" }]
        } else {
            &values["price"][key]
        };
        if !n.is_null() {
            let normalized = if let Some(f) = n.as_f64()
                && f.is_finite()
                && f.fract() == 0.0
                && f >= i64::MIN as f64
                && f <= i64::MAX as f64
            {
                let int_val = if f == 0.0 { 0_i64 } else { f as i64 };
                Value::Number(int_val.into())
            } else {
                n.clone()
            };
            range.insert(op.into(), normalized);
        }
    }
    if !range.is_empty() || (legacy && values["price"].is_object()) {
        filters.push(json!({"range":{format!("prices.{region}.price.discountPrice"):range}}));
    }
    let sale = values["onSale"].as_bool();
    if let Some(on_sale) = sale.filter(|b| !multi || *b) {
        filters.push(json!({"range":{format!("prices.{region}.price.discount"):if on_sale || legacy{json!({"gt":0})}else{json!({"lte":0})}}}));
    }
    if !multi {
        for (key, field) in [
            ("isLowestPrice", "isAtLowestPriceUS"),
            ("isLowestPriceEver", "isHistoricalLowestEverUS"),
        ] {
            if values[key] == true {
                filters.push(json!({"term":{field:true}}));
                if sale.is_none() {
                    filters.push(
                        json!({"range":{format!("prices.{region}.price.discount"):{"gt":0}}}),
                    );
                }
            }
        }
    }
    filters
}
