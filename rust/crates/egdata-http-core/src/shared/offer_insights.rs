
use bson::{Bson, Document, doc};
use egdata_core::v1::ProblemError;
use egdata_core::v1::serialization::js_truthy;
use serde_json::{Value, json};

use crate::shared::system::{doc_to_json, internal_error};
use crate::state::AppState;

pub async fn resolve_requirements(
    state: &AppState,
    namespace: &str,
    offer_id: &str,
    platform: &str,
) -> Result<Value, ProblemError> {
    requirements_for_platform(
        state,
        &Bson::String(namespace.into()),
        offer_id,
        platform,
        RequirementsWire::Legacy,
    )
    .await
}

pub async fn requirements_for_platform(
    state: &AppState,
    namespace: &Bson,
    offer_id: &str,
    platform: &str,
    wire: RequirementsWire,
) -> Result<Value, ProblemError> {
    let read = |filter| async move {
        state
            .mongo
            .find_one("offer_requirements", filter, None)
            .await
            .map(|doc| doc.map(|doc| wire.document(doc)))
            .map_err(|_| internal_error())
    };
    let Some(own) =
        read(doc! {"namespace":namespace,"offerId":offer_id,"platform":platform}).await?
    else {
        return Ok(Value::Null);
    };
    let source = &own["source"];
    let processing = &own["processing"];
    if source.is_null() || processing.is_null() {
        return Err(internal_error());
    }
    let has_tiers = |record: &Value| {
        js_truthy(&record["requirements"]["minimum"])
            || js_truthy(&record["requirements"]["recommended"])
    };
    let dlc = own["offerType"] == "DLC";
    let inactive = matches!(processing["state"].as_str(), Some("stale" | "failed"));
    let own_tiers = has_tiers(&own);
    let use_own = own_tiers || !dlc;
    let mut parent_id = &own["parent"]["parentOfferId"];
    if !own_tiers && (!dlc || inactive) {
        parent_id = &Value::Null;
    }
    let parent_ns = own["parent"]
        .get("parentNamespace")
        .filter(|v| !v.is_null())
        .unwrap_or(&own["namespace"]);
    let relationship = &own["parent"]["relationshipType"];
    let parent = if !use_own && !inactive && js_truthy(parent_id) {
        let key = |v: &Value| Bson::try_from(v.clone()).unwrap_or(Bson::Null);
        read(doc! {"namespace":key(parent_ns),"offerId":key(parent_id),"platform":platform}).await?
    } else {
        None
    };
    let candidate = if !use_own && !inactive && source["sourceType"] == "confirmed_absent" {
        let rows = &source["rawRows"];
        if rows.is_null() {
            return Err(internal_error());
        }
        parent.as_ref().filter(|p| {
            rows.as_array().is_some_and(Vec::is_empty)
                && js_truthy(&own["parent"]["resolvedInheritance"])
                && js_truthy(relationship)
                && p["offerType"] == "BASE_GAME"
                && p["offerId"] == *parent_id
                && p["namespace"] == *parent_ns
                && p["platform"] == own["platform"]
        })
    } else {
        None
    };
    let inherits = if let Some(candidate) = candidate {
        if candidate["processing"].is_null() {
            return Err(internal_error());
        }
        let normalized = matches!(
            candidate["processing"]["state"].as_str(),
            Some("normalized" | "stale")
        );
        if normalized && candidate["requirements"].is_null() {
            return Err(internal_error());
        }
        normalized && has_tiers(candidate)
    } else {
        false
    };
    let resolved = parent.as_ref().filter(|_| inherits).unwrap_or(&own);
    if resolved["source"].is_null() {
        return Err(internal_error());
    }
    let mut result = json!({});
    for key in ["namespace", "offerId", "platform", "offerType"] {
        wire.field(&mut result, key, own.get(key));
    }
    result["inherited"] = json!(inherits);
    result["isInherited"] = json!(inherits);
    result["parentOfferId"] = parent_id.clone();
    result["parent"] = if js_truthy(parent_id) {
        json!({"namespace":parent_ns,"offerId":parent_id,"relationshipType":relationship})
    } else {
        Value::Null
    };
    if inherits {
        result["state"] = if resolved["processing"]["state"] == "stale" {
            json!("stale")
        } else {
            json!("inherited")
        };
    } else if !use_own && !inactive {
        result["state"] = json!("unknown");
    } else {
        wire.field(&mut result, "state", processing.get("state"));
    }
    wire.field(
        &mut result,
        "sourceGeneration",
        processing.get("sourceGeneration"),
    );
    wire.field(
        &mut result,
        "observedAt",
        resolved["source"].get("observedAt"),
    );
    if inherits || use_own {
        wire.field(&mut result, "requirements", resolved.get("requirements"));
    } else {
        result["requirements"] = json!({"minimum":null,"recommended":null});
    }
    Ok(result)
}

#[derive(Clone, Copy)]
pub enum RequirementsWire {
    V1,
    Legacy,
}

impl RequirementsWire {
    fn document(self, doc: Document) -> Value {
        match self {
            Self::V1 => doc_to_json(doc),
            Self::Legacy => egdata_infra::bson_json::bson_doc_to_js_json(&doc),
        }
    }

    fn field(self, output: &mut Value, key: &str, value: Option<&Value>) {
        // JSON.stringify omits undefined, while v1's serializeValue returns null.
        if let Some(value) = value {
            output[key] = value.clone();
        } else if matches!(self, Self::V1) {
            output[key] = Value::Null;
        }
    }
}
