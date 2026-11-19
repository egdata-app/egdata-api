//! Bounded launcher metadata resolution, shared with the eventual legacy route.
//! Source: src/routes/build-launcher-records.ts.
pub use egdata_http_core::shared::build_launcher::*;

use super::{
    RouteGroup,
    helpers::{V1RequestContext, json_success, parse_strict_query_uri, problem_response},
};
use crate::state::AppState;
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::header,
    response::Response,
};
use egdata_core::v1::{ProblemError, require_json_content_type};
use serde_json::{Value, json};

pub fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix).post("/builds/resolve-launcher-records", resolve)
}
async fn resolve(State(state): State<AppState>, request: Request) -> Response {
    let uri = request.uri().clone();
    let method = request.method().clone();
    let id = request
        .extensions()
        .get::<V1RequestContext>()
        .map(|c| c.request_id.clone())
        .unwrap_or_default();
    let result = async {
        parse_strict_query_uri(&uri, &[])?;
        require_json_content_type(
            request
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok()),
        )?;
        let bytes = to_bytes(request.into_body(), usize::MAX)
            .await
            .map_err(|_| malformed())?;
        let body: Value = serde_json::from_slice(&bytes).map_err(|_| malformed())?;
        let candidates = validate(body)?;
        let mut results = Vec::new();
        for candidate in candidates {
            results.push(resolve_candidate(&state, &candidate).await?);
        }
        Ok::<_, ProblemError>(results)
    }
    .await;
    match result {
        Ok(results) => json_success(
            &method,
            uri.path(),
            &id,
            json!({"results":results}),
            Some(json!({"count":results.len()})),
        ),
        Err(e) => problem_response(&e, uri.path(), Some(&id)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use egdata_api_oracle::RecordedReads;
    use crate::{test_support::test_app_state, state::ApiConfig};
    use axum::{body::Body, http::StatusCode};
    use bson::{Bson, Document, doc};
    use std::sync::Arc;
    use tower::ServiceExt;
    fn candidate() -> Value {
        json!({"requestId":"r","buildAppName":"app","buildVersion":"1","platform":"Windows","catalogHint":{"artifactId":"artifact","catalogItemId":"item","catalogNamespace":"ns"}})
    }
    fn item_query() -> Document {
        doc! {"id":{"$eq":"item"},"namespace":{"$eq":"ns"}}
    }
    fn asset_query(id: &str) -> Document {
        doc! {"itemId":{"$eq":id}}
    }
    fn direct_query() -> Document {
        doc! {"items.id":{"$eq":"item"},"offerType":{"$in":["BASE_GAME","DLC"]}}
    }
    fn sub_query() -> Document {
        doc! {"subItems.id":{"$eq":"item"}}
    }
    fn state(steps: Vec<(&str, Document, Vec<Document>)>) -> (AppState, Arc<RecordedReads>) {
        let trace:Vec<_>=steps.into_iter().map(|(collection, filter, rows)| {
            let options=if collection=="offersubitems" {json!({"projection":{"_id":1}})} else {json!({})};
            json!({"call":{"method":"many","collection":collection,"query":Bson::Document(filter).into_relaxed_extjson(),"options":options},
                "result":rows.into_iter().map(|doc|Bson::Document(doc).into_relaxed_extjson()).collect::<Vec<_>>()})
        }).collect();
        let store = Arc::new(RecordedReads::from_case(
            &json!({"name":"launcher record selection","trace":trace}),
        ));
        let mut state = test_app_state(ApiConfig::default());
        state.mongo = store.clone();
        (state, store)
    }
    #[tokio::test]
    async fn registered_launcher_selections_match_node() {
        egdata_api_oracle::replay_mongo_oracle(include_str!(
            "../../egdata-api/tests/fixtures/launcher-selection-http-node.json"
        ))
        .await;
    }

    #[test]
    fn validation_matches_node_zod_fixtures() {
        let fixtures: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/launcher-validation.json"
        ))
        .unwrap();
        for (i, fixture) in fixtures.into_iter().enumerate() {
            match validate(fixture["input"].clone()) {
                Ok(actual) => assert_eq!(json!(actual), fixture["output"], "fixture {i}"),
                Err(error) => assert_eq!(
                    json!(error.errors.as_ref().unwrap()),
                    fixture["errors"],
                    "fixture {i}"
                ),
            }
        }
    }
    #[tokio::test]
    async fn returns_individual_not_found_ambiguous_and_unsupported_results() {
        for (rows, assets, expected) in [
            (vec![], None, "not-found"),
            (vec![doc! {}, doc! {}], None, "ambiguous"),
            (
                vec![doc! {"id":"item","namespace":"ns"}],
                Some(vec![]),
                "unsupported",
            ),
            (
                vec![doc! {"id":"item","namespace":"ns"}],
                Some(vec![
                    doc! {"platform":"Windows","artifactId":"artifact"},
                    doc! {"platform":"windows","artifactId":"artifact"},
                ]),
                "ambiguous",
            ),
        ] {
            let mut steps = vec![("items", item_query(), rows)];
            if let Some(assets) = assets {
                steps.push(("assets", asset_query("item"), assets));
            }
            let (state, store) = state(steps);
            assert_eq!(
                resolve_candidate(&state, &candidate()).await.unwrap(),
                json!({"requestId":"r","status":expected})
            );
            store.assert_finished();
        }
    }
    #[tokio::test]
    async fn resolves_base_game_with_offer_attribute_precedence() {
        let item = doc! {"id":"item","namespace":"ns","title":"Game","entitlementType":"EXECUTABLE","customAttributes":[{"key":"CanRunOffline","value":"true"},{"key":"FolderName","value":" Folder "}]};
        let offer = doc! {"id":"offer","offerType":"BASE_GAME","customAttributes":[{"key":"CanRunOffline","value":"FALSE"},{"key":"IgnoredProcessNames","value":"[\"keep\",\"\",5,\" spaced \"]"},{"key":"OwnershipToken","value":"true"}]};
        let (state, store) = state(vec![
            ("items", item_query(), vec![item]),
            (
                "assets",
                asset_query("item"),
                vec![
                    doc! {"platform":"Linux","artifactId":"other"},
                    doc! {"platform":"Windows","artifactId":"artifact"},
                ],
            ),
            ("offers", direct_query(), vec![offer]),
            ("offersubitems", sub_query(), vec![]),
        ]);
        let result = resolve_candidate(&state, &candidate()).await.unwrap();
        assert_eq!(
            result,
            json!({"requestId":"r","status":"resolved","record":{"artifactId":"artifact","catalogItemId":"item","catalogNamespace":"ns","displayName":"Game","kind":"base-game","appCategories":["public","games","applications"],"mainGame":null,"mandatoryAppFolderName":"Folder","canRunOffline":false,"requiresAuth":true,"ownershipToken":true,"ignoredProcessNames":["keep"," spaced "]}})
        );
        store.assert_finished();
    }
    #[tokio::test]
    async fn indirect_lookup_preserves_database_id_types_and_later_offer_values() {
        let object_id = bson::oid::ObjectId::new();
        let (state, store) = state(vec![
            (
                "offers",
                direct_query(),
                vec![doc! {"id":42_i32,"title":"old"}, doc! {"id":"second"}],
            ),
            (
                "offersubitems",
                sub_query(),
                vec![doc! {"_id":42_i32}, doc! {"_id":object_id}],
            ),
            (
                "offers",
                doc! {"id":{"$in":[42_i32,object_id]},"offerType":{"$in":["BASE_GAME","DLC"]}},
                vec![doc! {"id":"42","title":"updated"}, doc! {"id":""}],
            ),
        ]);
        assert_eq!(
            offers_for_item(&state, "item").await.unwrap(),
            vec![json!({"id":"42","title":"updated"}), json!({"id":"second"})]
        );
        store.assert_finished();
    }

    #[tokio::test]
    async fn indirect_addon_resolves_executable_parent_and_classifies_digital_extras_first() {
        let item =
            doc! {"id":"item","namespace":"ns","categories":[{"path":"DigitalExtra/soundtrack"}]};
        let base = doc! {"id":"base","offerType":"BASE_GAME","items":[{"id":"item"},{"id":"parent"},{"id":"extra"}]};
        let (state, store) = state(vec![
            ("items", item_query(), vec![item]),
            (
                "assets",
                asset_query("item"),
                vec![doc! {"platform":"Windows","artifactId":"artifact"}],
            ),
            (
                "offers",
                direct_query(),
                vec![doc! {"id":"dlc","offerType":"DLC"}],
            ),
            ("offersubitems", sub_query(), vec![doc! {"_id":"base"}]),
            (
                "offers",
                doc! {"id":{"$in":["base"]},"offerType":{"$in":["BASE_GAME","DLC"]}},
                vec![base],
            ),
            (
                "items",
                doc! {"id":{"$in":["item","parent","extra"]}},
                vec![
                    doc! {"id":"parent","namespace":"ns","entitlementType":"EXECUTABLE"},
                    doc! {"id":"extra","namespace":"ns"},
                ],
            ),
            (
                "assets",
                asset_query("parent"),
                vec![doc! {"artifactId":"parent-artifact","platform":"Windows"}],
            ),
        ]);
        let result = resolve_candidate(&state, &candidate()).await.unwrap();
        assert_eq!(result["record"]["kind"], "digital-extra");
        assert_eq!(
            result["record"]["mainGame"],
            json!({"artifactId":"parent-artifact","catalogItemId":"parent","catalogNamespace":"ns"})
        );
        store.assert_finished();
    }
    #[tokio::test]
    async fn unhinted_candidates_use_literal_app_id_and_windows_regex() {
        let query = doc! {"releaseInfo":{"$elemMatch":{"appId":{"$eq":"app.*"},"platform":{"$regex":bson::Regex{pattern:"^Win".into(),options:"i".into()}}}}};
        let (state, store) = state(vec![("items", query, vec![])]);
        let mut c = candidate();
        c.as_object_mut().unwrap().shift_remove("catalogHint");
        c["buildAppName"] = json!("app.*");
        assert_eq!(
            resolve_candidate(&state, &c).await.unwrap()["status"],
            "not-found"
        );
        store.assert_finished();
    }
    #[tokio::test]
    async fn http_validates_before_database_and_returns_bounded_results() {
        let (state, store) = state(vec![("items", item_query(), vec![])]);
        let app = super::super::router(&state).with_state(state);
        for (query, body, expected) in [
            (
                "?unknown=x",
                json!({"candidates":[candidate()]}),
                StatusCode::BAD_REQUEST,
            ),
            ("", json!({"candidates":[]}), StatusCode::BAD_REQUEST),
            ("", json!({"candidates":[candidate()]}), StatusCode::OK),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(format!("/v1/builds/resolve-launcher-records{query}"))
                        .method("POST")
                        .header("content-type", "application/json")
                        .header("x-egdata-key-id", "key_test1234")
                        .header("x-egdata-key-tier", "free")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            let body: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            if expected == StatusCode::OK {
                assert_eq!(
                    body["data"],
                    json!({"results":[{"requestId":"r","status":"not-found"}]})
                );
                assert_eq!(body["meta"]["count"], 1);
            }
        }
        store.assert_finished();
    }
    #[tokio::test]
    async fn interrupted_launcher_bodies_return_each_routes_validation_error() {
        for (path, expected) in [
            ("/builds/resolve-launcher-records", "VALIDATION_ERROR"),
            ("/v1/builds/resolve-launcher-records", "MALFORMED_JSON"),
        ] {
            let (state, store) = state(vec![]);
            let request = Request::post(path)
                .header("x-egdata-key-id", "key_test1234")
                .header("x-egdata-key-tier", "free")
                .header("content-type", "application/json")
                .body(Body::from_stream(futures::stream::once(async {
                    Err::<axum::body::Bytes, _>(std::io::Error::other("fixture connection closed"))
                })))
                .unwrap();
            let app = if path.starts_with("/v1/") {
                crate::router(&state).with_state(state)
            } else {
                egdata_api::runtime::application(state)
            };
            let res = app.oneshot(request).await.unwrap();
            assert_eq!(res.status(), StatusCode::BAD_REQUEST);
            let body: Value =
                serde_json::from_slice(&to_bytes(res.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body.get("error").unwrap_or(&body)["code"], expected);
            store.assert_finished();
        }
    }

    #[test]
    fn attribute_and_category_edge_cases_match_source() {
        assert_eq!(process_names(&json!("a, b, , c")), vec!["a", "b", "c"]);
        assert!(process_names(&Value::Null).is_empty());
        assert!(
            classify(
                &json!({"entitlementType":"EXECUTABLE","itemType":"DURABLE"}),
                &[]
            )
            .is_none()
        );
        assert_eq!(
            classify(&json!({"categories":["games/addon"]}), &[]),
            Some("addon")
        );
        assert_eq!(
            classify(&json!({}), &[json!({"offerType":"BASE_GAME"})]),
            Some("base-game")
        );
    }
}
