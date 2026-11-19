//! Sandbox handlers. Cache payloads and query order follow src/v1/routes/sandboxes.ts.
use super::*;
use crate::{
    offers::ordered,
    system::{fetch_prices_by_offer_id, internal_error, localize_offers},
};
use egdata_core::v1::{Pagination, ProblemIssue, localization_meta, parse_csv};
use std::{cmp::Ordering, future::Future};

enum Operation {
    List,
    Detail,
    Items,
    Offers,
    Assets,
    BaseGame,
    Achievements,
    Changelog,
    Builds,
    Stats,
}
pub(super) fn route_group(prefix: &str) -> RouteGroup {
    RouteGroup::new(prefix)
        .get("/sandboxes", |State(s), r| {
            dispatch(s, None, r, Operation::List)
        })
        .get(
            "/sandboxes/{sandboxId}",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Detail),
        )
        .get(
            "/sandboxes/{sandboxId}/items",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Items),
        )
        .get(
            "/sandboxes/{sandboxId}/offers",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Offers),
        )
        .get(
            "/sandboxes/{sandboxId}/assets",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Assets),
        )
        .get(
            "/sandboxes/{sandboxId}/base-game",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::BaseGame),
        )
        .get(
            "/sandboxes/{sandboxId}/achievements",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Achievements),
        )
        .get(
            "/sandboxes/{sandboxId}/changelog",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Changelog),
        )
        .get(
            "/sandboxes/{sandboxId}/builds",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Builds),
        )
        .get(
            "/sandboxes/{sandboxId}/stats",
            |State(s), Path(id): Path<String>, r| dispatch(s, Some(id), r, Operation::Stats),
        )
}
type Payload = Result<(Value, Option<Value>), ProblemError>;
async fn dispatch(s: AppState, id: Option<String>, req: Request, op: Operation) -> Response {
    let rid = req_id(req.extensions().get());
    match execute(&s, id.as_deref(), req.uri(), op).await {
        Ok((data, meta)) => json_success(req.method(), req.uri().path(), &rid, data, meta),
        Err(e) => error(e, req.uri(), rid),
    }
}
async fn execute(s: &AppState, id: Option<&str>, uri: &Uri, op: Operation) -> Payload {
    let (keys, bounds): (&[&str], &[(&str, usize)]) = match op {
        Operation::List | Operation::Changelog => (&["limit", "cursor"], &[]),
        Operation::Items => (
            &[
                "limit",
                "cursor",
                "entitlementType",
                "status",
                "platforms",
                "title",
            ],
            &[
                ("entitlementType", 500),
                ("status", 500),
                ("platforms", 500),
                ("title", 200),
            ],
        ),
        Operation::Offers => (
            &["limit", "cursor", "country", "locale", "offerType", "title"],
            &[("offerType", 500), ("title", 200)],
        ),
        Operation::Assets | Operation::Builds => {
            (&["limit", "cursor", "platform"], &[("platform", 500)])
        }
        Operation::BaseGame => (&["country", "locale"], &[]),
        _ => (&[], &[]),
    };
    let id = if matches!(op, Operation::List | Operation::Detail) {
        id.unwrap_or("").to_owned()
    } else {
        require_id_param(id, "sandboxId")?
    };
    let q = crate::helpers::parse_validated_query(uri, keys, |params| {
        bounds
            .iter()
            .filter(|(key, max)| {
                params
                    .get(*key)
                    .is_some_and(|v| v.encode_utf16().count() > *max)
            })
            .map(|(key, max)| ProblemIssue {
                parameter: Some((*key).into()),
                pointer: Some(format!("/{key}")),
                code: "TOO_BIG".into(),
                message: format!("Too big: expected string to have <={max} characters"),
            })
            .collect()
    })?;
    match op {
        Operation::List => list(s, &q).await,
        Operation::Detail => detail(s, &require_id_param(Some(&id), "sandboxId")?).await,
        Operation::Items | Operation::Offers => {
            listing(s, &id, &q, matches!(op, Operation::Offers)).await
        }
        Operation::Assets => assets(s, &id, &q).await,
        Operation::BaseGame => base_game(s, &id, &q).await,
        Operation::Achievements => achievements(s, &id).await,
        Operation::Changelog => changelog(s, &id, &q).await,
        Operation::Builds => builds(s, &id, &q).await,
        Operation::Stats => stats(s, &id).await,
    }
}
async fn cached<F, Fut>(
    s: &AppState,
    operation: &str,
    parts: BTreeMap<&str, Value>,
    ttl: u64,
    loader: F,
) -> Result<Value, ProblemError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<Value, ProblemError>>,
{
    let key = v1_cache_key(operation, &parts);
    if let Some(hit) = v1_cache_get(s.cache.as_ref(), &key).await {
        return Ok(hit);
    }
    let value = loader().await?;
    v1_cache_set(s.cache.as_ref(), &key, &value, ttl).await;
    Ok(value)
}
async fn find(
    s: &AppState,
    c: &str,
    f: Document,
    o: MongoFindOptions,
) -> Result<Vec<Value>, ProblemError> {
    s.mongo
        .find_many(c, f, o)
        .await
        .map(json_docs)
        .map_err(|_| internal_error())
}
async fn one(
    s: &AppState,
    c: &str,
    f: Document,
    p: Option<Document>,
) -> Result<Option<Value>, ProblemError> {
    s.mongo
        .find_one(c, f, p)
        .await
        .map(|d| d.map(bjson))
        .map_err(|_| internal_error())
}
async fn sorted_one(
    s: &AppState,
    c: &str,
    f: Document,
    sort: Document,
) -> Result<Option<Document>, ProblemError> {
    s.mongo
        .find_one_with_options(
            c,
            f,
            MongoFindOptions {
                sort: Some(sort),
                ..Default::default()
            },
        )
        .await
        .map_err(|_| internal_error())
}
async fn require_sandbox(s: &AppState, id: &str) -> Result<(), ProblemError> {
    for collection in ["sandboxes", "namespaces"] {
        if one(s, collection, doc! {"_id":{"$eq":id}}, Some(doc! {"_id":1}))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    Err(egdata_core::v1::not_found(
        "SANDBOX_NOT_FOUND",
        format!("No sandbox matches '{id}'."),
    ))
}
fn page_binding(
    operation: &str,
    filters: BTreeMap<String, Value>,
    ordering: &str,
    limit: u32,
) -> CursorBinding {
    binding(operation, Some(filters), ordering, "", "", limit)
}
fn cursor_filter(
    s: &AppState,
    p: &Pagination,
    b: &CursorBinding,
    sort: &[MongoSortField],
) -> Result<Option<Document>, ProblemError> {
    p.cursor
        .as_deref()
        .map(|token| {
            let tuple = decode_for(s, token, b)?;
            let values = sort
                .iter()
                .enumerate()
                .map(|(index, field)| {
                    let scalar = tuple.get(index).unwrap_or(&CursorSortValue::Null);
                    match field.field.as_str() {
                        "lastModifiedDate" | "timestamp" | "updatedAt" => match scalar {
                            CursorSortValue::String(text) => iso_or_null(&json!(text))
                                .and_then(|iso| chrono::DateTime::parse_from_rfc3339(&iso).ok())
                                .map(|d| {
                                    Bson::DateTime(bson::DateTime::from_chrono(
                                        d.with_timezone(&chrono::Utc),
                                    ))
                                })
                                .unwrap_or(Bson::Null),
                            CursorSortValue::Number(number) => number
                                .as_f64()
                                .filter(|n| n.abs() <= 8.64e15)
                                .map(|n| Bson::DateTime(bson::DateTime::from_millis(n as i64)))
                                .unwrap_or(Bson::Null),
                            CursorSortValue::Null => Bson::Null,
                        },
                        "_id" => scalar
                            .as_str()
                            .and_then(|text| bson::oid::ObjectId::parse_str(text).ok())
                            .map(Bson::ObjectId)
                            .unwrap_or_else(|| crate::system::cursor_scalar_bson(scalar)),
                        _ => crate::system::cursor_scalar_bson(scalar),
                    }
                })
                .collect::<Vec<_>>();
            mongo_keyset_filter(sort, &values)
        })
        .transpose()
}
fn page_meta_for(
    s: &AppState,
    b: &CursorBinding,
    more: bool,
    tuple: Vec<CursorSortValue>,
    total: Value,
) -> Result<Value, ProblemError> {
    Ok(json!(
        page_meta(
            b.limit,
            more,
            if more {
                Some(encode_for(s, b, &tuple)?)
            } else {
                None
            }
        )
        .with_total(total)
    ))
}
fn field_string(v: &Value, key: &str) -> Option<String> {
    v[key].as_str().map(str::to_owned)
}
fn nonempty(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}
fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect()
}
use egdata_core::v1::serialization::js_string;

async fn list(s: &AppState, q: &BTreeMap<String, String>) -> Payload {
    let p = parse_pagination_map(q, 100)?;
    let sort = [MongoSortField::new(
        "_id",
        SortDirection::Asc,
        NullsOrder::Last,
    )];
    let b = page_binding("sandboxes.list", BTreeMap::new(), "_id:asc", p.limit);
    let result = cached(
        s,
        "sandboxes.list",
        BTreeMap::from([("limit", json!(p.limit)), ("cursor", json!(p.cursor))]),
        60,
        || async {
            // Namespace IDs are strings, including 24-hex strings; never coerce them to ObjectId.
            let f = if let Some(c) = p.cursor.as_deref() {
                let t = decode_for(s, c, &b)?;
                mongo_keyset_filter(
                    &sort,
                    &[crate::system::cursor_scalar_bson(
                        t.first().unwrap_or(&CursorSortValue::Null),
                    )],
                )
                .expect("namespace pagination has one sort field and one cursor value")
            } else {
                Document::new()
            };
            let (rows,total)=counted_page(s,"sandboxes.list",&[],60,"namespaces",Some(doc!{}),
                PageRead::Find(f,MongoFindOptions{sort:Some(mongo_sort_spec(&sort)),limit:Some(i64::from(p.limit)+1),..Default::default()})).await?;
            let rows=json_docs(rows);
            let page = trim_page(rows, p.limit as usize);
            let tuple = page
                .items
                .last()
                .map(|v| vec![js_string(&v["_id"]).into()])
                .unwrap_or_default();
            Ok(json!({"data":page.items,"pagination":page_meta_for(s,&b,page.has_more,tuple,total)?}))
        },
    )
    .await?;
    Ok((
        result["data"].clone(),
        Some(
            json!({"count":result["data"].as_array().map_or(0,Vec::len),"pagination":result["pagination"]}),
        ),
    ))
}
async fn detail(s: &AppState, id: &str) -> Payload {
    let result = cached(
        s,
        "sandboxes.detail",
        BTreeMap::from([("sandboxId", json!(id))]),
        300,
        || async {
            for (collection, source) in [("sandboxes", "sandbox"), ("namespaces", "namespace")] {
                if let Some(document) = one(s, collection, doc! {"_id":{"$eq":id}}, None).await? {
                    return Ok(json!({"document":document,"source":source}));
                }
            }
            Ok(Value::Null)
        },
    )
    .await?;
    if result.is_null() {
        return Err(egdata_core::v1::not_found(
            "SANDBOX_NOT_FOUND",
            format!("No sandbox matches '{id}'."),
        ));
    }
    Ok((
        result["document"].clone(),
        Some(json!({"source":result["source"]})),
    ))
}
async fn listing(s: &AppState, id: &str, q: &BTreeMap<String, String>, is_offer: bool) -> Payload {
    let rp = if is_offer {
        Some(regional_params(
            q.get("country").map(String::as_str),
            q.get("locale").map(String::as_str),
        )?)
    } else {
        None
    };
    let p = parse_pagination_map(q, 100)?;
    let title = q.get("title").map(|s| s.trim()).filter(|s| !s.is_empty());
    let mut parts = BTreeMap::from([
        ("sandboxId", json!(id)),
        ("title", json!(title)),
        ("limit", json!(p.limit)),
        ("cursor", json!(p.cursor)),
    ]);
    let mut filters = BTreeMap::from([
        ("sandboxId".into(), json!(id)),
        ("title".into(), json!(title)),
    ]);
    let mut f = doc! {"namespace":id};
    let fields: &[(&str, &str)] = if is_offer {
        &[("offerType", "offerType")]
    } else {
        &[
            ("entitlementType", "entitlementType"),
            ("status", "status"),
            ("platforms", "releaseInfo"),
        ]
    };
    for (key, field) in fields {
        let values = parse_csv(q.get(*key).map(String::as_str));
        parts.insert(*key, json!(values));
        filters.insert((*key).into(), json!(values));
        if let Some(values) = values {
            f.insert(
                *field,
                if *key == "platforms" {
                    doc! {"$elemMatch":{"platform":{"$in":values}}}
                } else {
                    doc! {"$in":values}
                },
            );
        }
    }
    if let Some(t) = title {
        f.insert("title", doc! {"$regex":regex::escape(t),"$options":"i"});
    }
    let (collection, operation) = if is_offer {
        ("offers", "sandboxes.offers")
    } else {
        ("items", "sandboxes.items")
    };
    let count_parts: Vec<_> = parts
        .iter()
        .filter(|(key, _)| !matches!(**key, "limit" | "cursor"))
        .map(|(key, v)| (*key, v.clone()))
        .collect();
    let mut b = page_binding(operation, filters, "lastModifiedDate:desc,id:asc", p.limit);
    if let Some(r) = &rp {
        b.country = r.country.clone();
        b.locale = r.locale.clone();
        parts.insert("region", json!(r.region));
        parts.insert("locale", json!(r.locale));
    }
    require_sandbox(s, id).await?;
    let result=cached(s,operation,parts,60,|| async {
        let base=f.clone();
        let f = if let Some(after) = cursor_filter(s, &p, &b, &*ITEM_SORT)? {
            doc! {"$and":[f,after]}
        } else {
            f
        };
        let (rows,total)=counted_page(s,operation,&count_parts,60,collection,Some(base),
            PageRead::Find(f,MongoFindOptions{sort:Some(mongo_sort_spec(&*ITEM_SORT)),limit:Some(i64::from(p.limit)+1),..Default::default()})).await?;
        let page = trim_page(rows, p.limit as usize);
        let tuple = page
            .items
            .last()
            .map(|v| {
                vec![
                    v.get("lastModifiedDate").and_then(crate::offer_price_history::stored_date).into(),
                    v.get_str("id").ok().filter(|s|!s.is_empty()).map(str::to_owned).into(),
                ]
            })
            .unwrap_or_default();
        let pagination = page_meta_for(s, &b, page.has_more, tuple, total)?;
        if let Some(r) = &rp {
            let rows: Vec<_> = page.items.into_iter().map(bjson).collect();
            let ids = rows
                .iter()
                .filter_map(|v| nonempty(&v["id"]).map(str::to_owned))
                .collect::<Vec<_>>();
            let prices = fetch_prices_by_offer_id(s, &ids, &r.region).await?;
            let raw: Vec<_> = rows
                .iter()
                .map(|v| {
                    let mut o = ordered(v);
                    o["price"] = prices
                        .get(v["id"].as_str().unwrap_or(""))
                        .cloned()
                        .unwrap_or(Value::Null);
                    o
                })
                .collect();
            let loc = localize_offers(s, &raw, &r.locale).await?;
            Ok(
                json!({"offers":loc.iter().map(|o|serialize_offer(o,o.get("price"),true)).collect::<Vec<_>>(),"pagination":pagination,"localization":localization_meta(loc.first())}),
            )
        } else {
            Ok(
                json!({"data":page.items.iter().map(crate::item_serialization::stored_item).collect::<Vec<_>>(),"pagination":pagination}),
            )
        }
    }).await?;
    if let Some(r) = rp {
        let data = result["offers"].clone();
        let meta = merge_metadata(
            json!({"count":data.as_array().map_or(0,Vec::len),"country":r.country,"region":r.region,"locale":r.locale}),
            result["localization"].clone(),
        );
        let mut meta = meta;
        meta["pagination"] = result["pagination"].clone();
        Ok((data, Some(meta)))
    } else {
        Ok((
            result["data"].clone(),
            Some(
                json!({"count":result["data"].as_array().map_or(0,Vec::len),"pagination":result["pagination"]}),
            ),
        ))
    }
}

type AssetTuple = [Option<String>; 3];
fn asset_tuple(v: &Value) -> AssetTuple {
    [
        iso_or_null(&v["updatedAt"]),
        field_string(v, "artifactId"),
        field_string(v, "platform"),
    ]
}
fn compare_assets(a: &AssetTuple, b: &AssetTuple) -> Ordering {
    for i in 0..3 {
        let order = match (&a[i], &b[i]) {
            (None, None) => Ordering::Equal,
            (None, _) => Ordering::Greater,
            (_, None) => Ordering::Less,
            (Some(a), Some(b)) => {
                let cmp = a.encode_utf16().cmp(b.encode_utf16());
                if i == 0 { cmp.reverse() } else { cmp }
            }
        };
        if !order.is_eq() {
            return order;
        }
    }
    Ordering::Equal
}
async fn merged_assets(
    s: &AppState,
    id: &str,
    platforms: Option<&[String]>,
) -> Result<Vec<Value>, ProblemError> {
    let (items, assets) = tokio::join!(
        find(
            s,
            "items",
            doc! {"namespace":{"$eq":id}},
            MongoFindOptions {
                projection: Some(doc! {"id":1,"namespace":1,"releaseInfo":1,"title":1}),
                ..Default::default()
            }
        ),
        find(
            s,
            "assets",
            doc! {"namespace":{"$eq":id}},
            MongoFindOptions::default()
        )
    );
    let items = items?;
    let mut assets = assets?;
    let stored: HashSet<_> = assets
        .iter()
        .filter_map(|v| nonempty(&v["artifactId"]).map(str::to_owned))
        .collect();
    for item in items {
        for release in item["releaseInfo"].as_array().into_iter().flatten() {
            let Some(app) = nonempty(&release["appId"]) else {
                continue;
            };
            if stored.contains(app) {
                continue;
            }
            for platform in release["platform"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(nonempty)
            {
                assets.push(json!({"artifactId":app,"downloadSizeBytes":0,"installedSizeBytes":0,"itemId":item["id"],"namespace":item.get("namespace").filter(|v|!v.is_null()).cloned().unwrap_or(json!(id)),"platform":platform,"_id":format!("virtual:{}:{app}:{platform}",item.get("id").map(js_string).unwrap_or("undefined".into())),"title":item["title"],"updatedAt":"1970-01-01T00:00:00.000Z"}));
            }
        }
    }
    if let Some(platforms) = platforms {
        assets.retain(|a| {
            platforms.contains(
                &a.get("platform")
                    .map(js_string)
                    .unwrap_or("undefined".into()),
            )
        });
    }
    assets.sort_by(|a, b| compare_assets(&asset_tuple(a), &asset_tuple(b)));
    Ok(assets)
}
async fn assets(s: &AppState, id: &str, q: &BTreeMap<String, String>) -> Payload {
    let p = parse_pagination_map(q, 100)?;
    let platforms = parse_csv(q.get("platform").map(String::as_str));
    let b = page_binding(
        "sandboxes.assets",
        BTreeMap::from([
            ("sandboxId".into(), json!(id)),
            ("platforms".into(), json!(platforms)),
        ]),
        "updatedAt:desc,artifactId:asc,platform:asc",
        p.limit,
    );
    require_sandbox(s, id).await?;
    let result = cached(
        s,
        "sandboxes.assets",
        BTreeMap::from([("sandboxId", json!(id)), ("platforms", json!(platforms))]),
        300,
        || async { Ok(json!(merged_assets(s, id, platforms.as_deref()).await?)) },
    )
    .await?;
    let mut rows = result.as_array().cloned().unwrap_or_default();
    let total = json!(rows.len());
    if let Some(c) = p.cursor.as_deref() {
        let last = decode_for(s, c, &b)?;
        let t = std::array::from_fn(|i| {
            last.get(i)
                .and_then(CursorSortValue::as_str)
                .map(str::to_owned)
        });
        rows.retain(|r| compare_assets(&asset_tuple(r), &t).is_gt());
    }
    let page = trim_page(rows, p.limit as usize);
    let tuple = page
        .items
        .last()
        .map(|v| {
            asset_tuple(v)
                .into_iter()
                .map(CursorSortValue::from)
                .collect()
        })
        .unwrap_or_default();
    let meta = json!({"count":page.items.len(),"pagination":page_meta_for(s,&b,page.has_more,tuple,total)?});
    Ok((json!(page.items), Some(meta)))
}
async fn base_game(s: &AppState, id: &str, q: &BTreeMap<String, String>) -> Payload {
    let rp = regional_params(
        q.get("country").map(String::as_str),
        q.get("locale").map(String::as_str),
    )?;
    require_sandbox(s, id).await?;
    let result=cached(s,"sandboxes.base-game",BTreeMap::from([("sandboxId",json!(id)),("region",json!(rp.region)),("locale",json!(rp.locale))]),60,|| async {
        let regular=sorted_one(s,"offers",doc!{"namespace":{"$eq":id},"offerType":"BASE_GAME","prePurchase":{"$ne":true},"isCodeRedemptionOnly":false},doc!{"creationDate":1,"id":1}).await?;
        let selected = if regular.is_some() {
            regular
        } else {
            sorted_one(
                s,
                "offers",
                doc! {"namespace":{"$eq":id},"offerType":"BASE_GAME","prePurchase":true},
                doc! {"creationDate":1,"id":1},
            )
            .await?
        };
        if let Some(offer) = selected {
            let price=sorted_one(s,"pricev2",doc!{"offerId":{"$eq":offer.get("id").cloned().unwrap_or(Bson::Null)},"region":&rp.region},doc!{"updatedAt":-1}).await?.map(bjson);
            let loc = localize_offers(s, &[ordered(&bjson(offer))], &rp.locale).await?;
            return Ok(
                json!({"kind":"offer","data":serialize_offer(&loc[0],price.as_ref(),true),"localization":localization_meta(loc.first())}),
            );
        }
        let item=sorted_one(s,"items",doc!{"namespace":{"$eq":id},"entitlementType":"EXECUTABLE","releaseInfo.0":{"$exists":true}},doc!{"creationDate":1,"id":1}).await?;
        Ok(if let Some(item) = item {
            let mut data = crate::item_serialization::stored_item(&item);
            data["isItem"] = json!(true);
            json!({"kind":"item","data":data,"localization":{}})
        } else {
            json!({"kind":"missing"})
        })
    }).await?;
    if result["kind"] == "missing" {
        return Err(egdata_core::v1::not_found(
            "BASE_GAME_NOT_FOUND",
            format!("No base game is available for sandbox '{id}'."),
        ));
    }
    Ok((
        result["data"].clone(),
        Some(merge_metadata(
            json!({"country":rp.country,"region":rp.region,"locale":rp.locale,"isItem":result["kind"]=="item"}),
            result["localization"].clone(),
        )),
    ))
}
async fn achievements(s: &AppState, id: &str) -> Payload {
    require_sandbox(s, id).await?;
    let data = cached(
        s,
        "sandboxes.achievements",
        BTreeMap::from([("sandboxId", json!(id))]),
        300,
        || async {
            Ok(json!(
                find(
                    s,
                    "achievementsets",
                    doc! {"sandboxId":{"$eq":id}},
                    MongoFindOptions::default()
                )
                .await?
            ))
        },
    )
    .await?;
    let count = data.as_array().map_or(0, Vec::len);
    Ok((data, Some(json!({"count":count}))))
}
async fn changelog_context_ids(s: &AppState, id: &str) -> Result<Value, ProblemError> {
    let offers = find(
        s,
        "offers",
        doc! {"namespace":id},
        MongoFindOptions {
            projection: Some(doc! {"id":1,"items":1}),
            sort: Some(doc! {"lastModifiedDate":-1}),
            limit: Some(100),
            ..Default::default()
        },
    )
    .await?;
    let offer_items: Vec<_> = offers
        .iter()
        .flat_map(|o| o["items"].as_array().into_iter().flatten())
        .filter_map(|i| nonempty(&i["id"]).map(str::to_owned))
        .collect();
    let items = find(
        s,
        "items",
        doc! {"$or":[{"id":{"$in":offer_items}},{"namespace":{"$eq":id}}]},
        MongoFindOptions {
            projection: Some(doc! {"id":1,"namespace":1,"releaseInfo":1}),
            sort: Some(doc! {"lastModifiedDate":-1}),
            limit: Some(100),
            ..Default::default()
        },
    )
    .await?;
    let item_ids: Vec<_> = items
        .iter()
        .filter_map(|i| nonempty(&i["id"]).map(str::to_owned))
        .collect();
    let assets = if item_ids.is_empty() {
        vec![]
    } else {
        find(
            s,
            "assets",
            doc! {"itemId":{"$in":&item_ids}},
            MongoFindOptions {
                projection: Some(doc! {"artifactId":1}),
                ..Default::default()
            },
        )
        .await?
    };
    let apps = unique(
        items
            .iter()
            .flat_map(|i| i["releaseInfo"].as_array().into_iter().flatten())
            .filter_map(|r| nonempty(&r["appId"]).map(str::to_owned)),
    );
    let builds = if apps.is_empty() {
        vec![]
    } else {
        find(
            s,
            "builds",
            doc! {"appName":{"$in":apps}},
            MongoFindOptions {
                projection: Some(doc! {"_id":1}),
                ..Default::default()
            },
        )
        .await?
    };
    Ok(json!(unique(
        std::iter::once(id.to_owned())
            .chain(
                offers
                    .iter()
                    .filter_map(|o| nonempty(&o["id"]).map(str::to_owned))
            )
            .chain(item_ids)
            .chain(
                assets
                    .iter()
                    .filter_map(|a| nonempty(&a["artifactId"]).map(str::to_owned))
            )
            .chain(
                builds
                    .iter()
                    .map(|b| b.get("_id").map(js_string).unwrap_or("undefined".into()))
            )
    )))
}
async fn resolve_context(s: &AppState, metadata: &Value) -> Value {
    let (Some(kind), Some(id)) = (
        nonempty(&metadata["contextType"]),
        nonempty(&metadata["contextId"]),
    ) else {
        return Value::Null;
    };
    let (collection, filter, projection) = match kind {
        "offer" => (
            "offers",
            doc! {"id":{"$eq":id}},
            doc! {"id":1,"title":1,"keyImages":1,"offerType":1,"namespace":1},
        ),
        "item" => (
            "items",
            doc! {"id":{"$eq":id}},
            doc! {"id":1,"title":1,"keyImages":1,"namespace":1},
        ),
        "asset" => (
            "assets",
            doc! {"$or":[{"artifactId":{"$eq":id}},{"id":{"$eq":id}}]},
            doc! {"id":1,"artifactId":1,"namespace":1},
        ),
        "build" => {
            let f = if let Ok(oid) = bson::oid::ObjectId::parse_str(id) {
                doc! {"$or":[{"_id":oid},{"_id":{"$eq":id}}]}
            } else {
                doc! {"_id":{"$eq":id}}
            };
            ("builds", f, doc! {"_id":1,"appName":1,"buildVersion":1})
        }
        _ => return Value::Null,
    };
    one(s, collection, filter, Some(projection))
        .await
        .ok()
        .flatten()
        .unwrap_or(Value::Null)
}
async fn changelog(s: &AppState, id: &str, q: &BTreeMap<String, String>) -> Payload {
    let p = parse_pagination_map(q, 100)?;
    let b = page_binding(
        "sandboxes.changelog",
        BTreeMap::from([("sandboxId".into(), json!(id))]),
        "timestamp:desc,_id:desc",
        p.limit,
    );
    require_sandbox(s, id).await?;
    let result=cached(s,"sandboxes.changelog",BTreeMap::from([("sandboxId",json!(id)),("limit",json!(p.limit)),("cursor",json!(p.cursor))]),60,|| async {
        let ids = cached(
            s,
            "sandboxes.changelog.context",
            BTreeMap::from([("sandboxId", json!(id))]),
            300,
            || changelog_context_ids(s, id),
        )
        .await?;
        let base =
            doc! {"metadata.contextId":{"$in":bson::to_bson(&ids).map_err(|_|internal_error())?}};
        let filter = if let Some(after) = cursor_filter(s, &p, &b, &*CHANGELOG_SORT)? {
            doc! {"$and":[&base,after]}
        } else {
            base.clone()
        };
        let (rows,total)=counted_page(s,"sandboxes.changelog",&[("sandboxId",json!(id))],60,"changelogs_v2",Some(base),PageRead::Aggregate(vec![
                    doc! {"$match":filter},
                    doc! {"$sort":mongo_sort_spec(&*CHANGELOG_SORT)},
                    doc! {"$limit":i64::from(p.limit)+1},
                    doc! {"$project":{"_id":1,"metadata":1,"timestamp":1}},
                ])).await?;
        let rows=json_docs(rows);
        let page = trim_page(rows, p.limit as usize);
        let tuple = page
            .items
            .last()
            .map(|v| {
                vec![
                    iso_or_null(&v["timestamp"]).into(),
                    field_string(v, "_id").into(),
                ]
            })
            .unwrap_or_default();
        let mut hits = Vec::new();
        for mut row in page.items {
            let context = resolve_context(s, &row["metadata"]).await;
            if !row["metadata"].is_object() {
                row["metadata"] = json!({});
            }
            row["metadata"]["context"] = context;
            hits.push(row);
        }
        Ok(json!({"hits":hits,"pagination":page_meta_for(s,&b,page.has_more,tuple,total)?}))
    }).await?;
    Ok((
        json!({"hits":result["hits"]}),
        Some(
            json!({"count":result["hits"].as_array().map_or(0,Vec::len),"pagination":result["pagination"]}),
        ),
    ))
}
async fn builds(s: &AppState, id: &str, q: &BTreeMap<String, String>) -> Payload {
    let p = parse_pagination_map(q, 100)?;
    let platforms = parse_csv(q.get("platform").map(String::as_str));
    let b = page_binding(
        "sandboxes.builds",
        BTreeMap::from([
            ("sandboxId".into(), json!(id)),
            ("platforms".into(), json!(platforms)),
        ]),
        "updatedAt:desc,_id:desc",
        p.limit,
    );
    require_sandbox(s, id).await?;
    let result = cached(
        s,
        "sandboxes.builds",
        BTreeMap::from([
            ("sandboxId", json!(id)),
            ("platforms", json!(platforms)),
            ("limit", json!(p.limit)),
            ("cursor", json!(p.cursor)),
        ]),
        60,
        || async {
            let mut f = doc! {"namespace":id};
            if let Some(platforms) = &platforms {
                f.insert(
                    "releaseInfo",
                    doc! {"$elemMatch":{"platform":{"$in":platforms}}},
                );
            }
            let items = find(
                s,
                "items",
                f,
                MongoFindOptions {
                    projection: Some(doc! {"releaseInfo":1}),
                    ..Default::default()
                },
            )
            .await?;
            let apps = unique(
                items
                    .iter()
                    .flat_map(|i| i["releaseInfo"].as_array().into_iter().flatten())
                    .filter_map(|r| nonempty(&r["appId"]).map(str::to_owned)),
            );
            let sort = [
                MongoSortField::new("updatedAt", SortDirection::Desc, NullsOrder::Last),
                MongoSortField::new("_id", SortDirection::Desc, NullsOrder::Last),
            ];
            let base = doc! {"appName":{"$in":&apps}};
            let f=if let Some(after)=cursor_filter(s,&p,&b,&sort)? {doc!{"$and":[&base,after]}} else {base.clone()};
            let (rows,total)=counted_page(s,"sandboxes.builds",&[("sandboxId",json!(id)),("platforms",json!(platforms))],60,"builds",(!apps.is_empty()).then_some(base),
                PageRead::Find(f,MongoFindOptions{sort:Some(mongo_sort_spec(&sort)),limit:Some(i64::from(p.limit)+1),..Default::default()})).await?;
            let rows=json_docs(rows);
            let page = trim_page(rows, p.limit as usize);
            let tuple = page
                .items
                .last()
                .map(|v| {
                    vec![
                        iso_or_null(&v["updatedAt"]).into(),
                        js_string(&v["_id"]).into(),
                    ]
                })
                .unwrap_or_default();
            let summaries = page
                .items
                .iter()
                .map(|row| {
                    crate::builds::stored_build_summary(row, None).map(|v| serialize_value(&v))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(json!({"data":summaries,"pagination":page_meta_for(s,&b,page.has_more,tuple,total)?}))
        },
    )
    .await?;
    Ok((
        result["data"].clone(),
        Some(
            json!({"count":result["data"].as_array().map_or(0,Vec::len),"pagination":result["pagination"]}),
        ),
    ))
}
async fn stats(s: &AppState, id: &str) -> Payload {
    require_sandbox(s, id).await?;
    let data=cached(s,"sandboxes.stats",BTreeMap::from([("sandboxId",json!(id))]),300,|| async {
        let (offers, items, sets, assets) = tokio::join!(
            s.mongo
                .count_documents("offers", doc! {"namespace":{"$eq":id}}),
            find(
                s,
                "items",
                doc! {"namespace":{"$eq":id}},
                MongoFindOptions {
                    projection: Some(doc! {"releaseInfo":1}),
                    ..Default::default()
                }
            ),
            find(
                s,
                "achievementsets",
                doc! {"sandboxId":{"$eq":id}},
                MongoFindOptions::default()
            ),
            find(
                s,
                "assets",
                doc! {"namespace":{"$eq":id}},
                MongoFindOptions {
                    projection: Some(doc! {"artifactId":1}),
                    ..Default::default()
                }
            )
        );
        let offers = offers.map_err(|_| internal_error())?;
        let items = items?;
        let sets = sets?;
        let assets = assets?;
        let stored: HashSet<_> = assets
            .iter()
            .filter_map(|a| nonempty(&a["artifactId"]))
            .collect();
        let mut apps = Vec::new();
        let mut virtual_assets = 0;
        for item in &items {
            for r in item["releaseInfo"].as_array().into_iter().flatten() {
                let Some(app) = nonempty(&r["appId"]) else {
                    continue;
                };
                apps.push(app.to_owned());
                if !stored.contains(app) {
                    virtual_assets += r["platform"].as_array().map_or(0, Vec::len);
                }
            }
        }
        let builds = s
            .mongo
            .count_documents("builds", doc! {"appName":{"$in":unique(apps)}})
            .await
            .map_err(|_| internal_error())?;
        Ok(
            json!({"offers":offers,"items":items.len(),"assets":assets.len()+virtual_assets,"builds":builds,"achievements":sets.iter().map(|s|s["achievements"].as_array().map_or(0,Vec::len)).sum::<usize>()}),
        )
    }).await?;
    Ok((data, None))
}
