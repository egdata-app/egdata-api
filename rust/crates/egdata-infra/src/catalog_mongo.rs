//! MongoDB catalog hydration resolver, v1 MongoDB index plan, and OpenSearch v1 search mapping verification.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use bson::{Bson, Document, doc};
use chrono::{SecondsFormat, Utc};
use egdata_core::catalog::{self, CatalogCollation, node_collator, stable_json_with_collation};
pub use egdata_core::catalog::{
    CATALOG_HYDRATION_MAX_ROOT_RECORDS, CatalogCustomAttribute, CatalogHydrationIdentifier,
    CatalogImage, CatalogOfferItemSource, CatalogOfferMapping, CatalogSeller, CatalogTag,
    catalog_hydration_root_key, sha256_hex, stable_json,
};
use indexmap::{IndexMap, IndexSet};
use mongodb::options::{FindOptions, IndexOptions};
use mongodb::{Database, IndexModel};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use tracing::{info, warn};

use crate::search_clients::{OpenSearchMappingClient, SearchClientError};

pub const CATALOG_HYDRATION_SCHEMA_VERSION: u32 = 2;
const QUERY_LIMIT: i64 = 600;
/// Errors returned by catalog MongoDB operations.
#[derive(Debug, Error)]
pub enum CatalogMongoError {
    #[error("mongodb error: {0}")]
    Mongo(#[from] mongodb::error::Error),
    #[error("{0}")]
    Projection(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownRoot {
    pub root_key: String,
    pub graph_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownRecord {
    pub record_key: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHydrationRequest {
    pub schema_version: u32,
    pub identifiers: Vec<CatalogHydrationIdentifier>,
    pub known_roots: Vec<KnownRoot>,
    pub known_records: Vec<KnownRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum CatalogRecord {
    #[serde(rename_all = "camelCase")]
    Offer {
        namespace: String,
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        long_description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        offer_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        seller: Option<CatalogSeller>,
        #[serde(skip_serializing_if = "Option::is_none")]
        developer_display_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        publisher_display_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        product_slug: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        url_slug: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        key_images: Vec<CatalogImage>,
        tags: Vec<CatalogTag>,
        categories: Vec<String>,
        custom_attributes: Vec<CatalogCustomAttribute>,
        #[serde(skip_serializing_if = "Option::is_none")]
        effective_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        creation_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_modified_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        release_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pc_release_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        viewable_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pre_purchase: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        is_code_redemption_only: Option<bool>,
        countries_blacklist: Vec<String>,
        countries_whitelist: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        refund_type: Option<String>,
        offer_mappings: Vec<CatalogOfferMapping>,
    },
    #[serde(rename_all = "camelCase")]
    Item {
        namespace: String,
        id: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        long_description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        technical_details: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        entitlement_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        entitlement_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        item_type: Option<String>,
        key_images: Vec<CatalogImage>,
        categories: Vec<String>,
        custom_attributes: Vec<CatalogCustomAttribute>,
        #[serde(skip_serializing_if = "Option::is_none")]
        creation_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_modified_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        developer: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        developer_id: Option<String>,
        eula_ids: Vec<String>,
        install_modes: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        end_of_support: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        self_refundable: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        application_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unsearchable: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        requires_secure_account: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        entitlement_start_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        entitlement_end_date: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        use_count: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        primary_offer_namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        primary_offer_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Asset {
        namespace: String,
        artifact_id: String,
        platform: String,
        item_namespace: String,
        item_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        download_size_bytes: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        installed_size_bytes: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        primary_offer_namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        primary_offer_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    ReleaseApp {
        namespace: String,
        app_id: String,
        platform: String,
        item_namespace: String,
        item_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        release_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        primary_offer_namespace: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        primary_offer_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    OfferItem {
        offer_namespace: String,
        offer_id: String,
        item_namespace: String,
        item_id: String,
        sources: Vec<CatalogOfferItemSource>,
        is_primary: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHydrationRecord {
    pub record_key: String,
    pub sha256: String,
    pub record: CatalogRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogSafeError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogHydrationRootResult {
    pub schema_version: u32,
    pub root_key: String,
    pub identifier: CatalogHydrationIdentifier,
    pub hydrated_at: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub records: Option<Vec<CatalogHydrationRecord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<CatalogSafeError>,
}

/// Compute the content-addressing key for a Mongo hydration record.
pub fn catalog_record_key(record: &CatalogRecord) -> String {
    match record {
        CatalogRecord::Offer { namespace, id, .. } => {
            catalog::catalog_key("offer", &[namespace, id])
        }
        CatalogRecord::Item { namespace, id, .. } => catalog::catalog_key("item", &[namespace, id]),
        CatalogRecord::Asset {
            namespace,
            artifact_id,
            platform,
            item_namespace,
            item_id,
            ..
        } => catalog::catalog_key(
            "asset",
            &[namespace, artifact_id, platform, item_namespace, item_id],
        ),
        CatalogRecord::ReleaseApp {
            namespace,
            app_id,
            platform,
            item_namespace,
            item_id,
            ..
        } => catalog::catalog_key(
            "release-app",
            &[namespace, app_id, platform, item_namespace, item_id],
        ),
        CatalogRecord::OfferItem {
            offer_namespace,
            offer_id,
            item_namespace,
            item_id,
            ..
        } => catalog::catalog_key(
            "offer-item",
            &[offer_namespace, offer_id, item_namespace, item_id],
        ),
    }
}

pub fn graph_hash_for_records(records: &[CatalogHydrationRecord]) -> String {
    let collator = node_collator();
    graph_hash_for_records_with_collation(records, &collator)
}

fn graph_hash_for_records_with_collation(
    records: &[CatalogHydrationRecord],
    collator: &CatalogCollation,
) -> String {
    catalog::graph_hash_for_entries(
        records
            .iter()
            .map(|r| (r.record_key.as_str(), r.sha256.as_str())),
        collator,
    )
}

impl From<catalog::CatalogRecord> for CatalogRecord {
    fn from(record: catalog::CatalogRecord) -> Self {
        match record {
            catalog::CatalogRecord::Offer(row) => Self::Offer {
                namespace: row.namespace,
                id: row.id,
                title: row.title,
                description: row.description,
                long_description: row.long_description,
                offer_type: row.offer_type,
                seller: row.seller,
                developer_display_name: row.developer_display_name,
                publisher_display_name: row.publisher_display_name,
                product_slug: row.product_slug,
                url_slug: row.url_slug,
                url: row.url,
                key_images: row.key_images,
                tags: row.tags,
                categories: row.categories,
                custom_attributes: row.custom_attributes,
                effective_date: row.effective_date,
                creation_date: row.creation_date,
                last_modified_date: row.last_modified_date,
                release_date: row.release_date,
                pc_release_date: row.pc_release_date,
                viewable_date: row.viewable_date,
                pre_purchase: row.pre_purchase,
                is_code_redemption_only: row.is_code_redemption_only,
                countries_blacklist: row.countries_blacklist,
                countries_whitelist: row.countries_whitelist,
                refund_type: row.refund_type,
                offer_mappings: row.offer_mappings,
            },
            catalog::CatalogRecord::Item(row) => Self::Item {
                namespace: row.namespace,
                id: row.id,
                title: row.title,
                description: row.description,
                long_description: row.long_description,
                technical_details: row.technical_details,
                status: row.status,
                entitlement_name: row.entitlement_name,
                entitlement_type: row.entitlement_type,
                item_type: row.item_type,
                key_images: row.key_images,
                categories: row.categories,
                custom_attributes: row.custom_attributes,
                creation_date: row.creation_date,
                last_modified_date: row.last_modified_date,
                developer: row.developer,
                developer_id: row.developer_id,
                eula_ids: row.eula_ids,
                install_modes: row.install_modes,
                end_of_support: row.end_of_support,
                self_refundable: row.self_refundable,
                application_id: row.application_id,
                unsearchable: row.unsearchable,
                requires_secure_account: row.requires_secure_account,
                entitlement_start_date: row.entitlement_start_date,
                entitlement_end_date: row.entitlement_end_date,
                use_count: row.use_count.and_then(|number| number.as_f64()),
                primary_offer_namespace: row.primary_offer_namespace,
                primary_offer_id: row.primary_offer_id,
            },
            catalog::CatalogRecord::Asset(row) => Self::Asset {
                namespace: row.namespace,
                artifact_id: row.artifact_id,
                platform: row.platform,
                item_namespace: row.item_namespace,
                item_id: row.item_id,
                download_size_bytes: row.download_size_bytes.and_then(|number| number.as_f64()),
                installed_size_bytes: row.installed_size_bytes.and_then(|number| number.as_f64()),
                primary_offer_namespace: row.primary_offer_namespace,
                primary_offer_id: row.primary_offer_id,
            },
            catalog::CatalogRecord::ReleaseApp(row) => Self::ReleaseApp {
                namespace: row.namespace,
                app_id: row.app_id,
                platform: row.platform,
                item_namespace: row.item_namespace,
                item_id: row.item_id,
                release_id: row.release_id,
                primary_offer_namespace: row.primary_offer_namespace,
                primary_offer_id: row.primary_offer_id,
            },
            catalog::CatalogRecord::OfferItem(row) => Self::OfferItem {
                offer_namespace: row.offer_namespace,
                offer_id: row.offer_id,
                item_namespace: row.item_namespace,
                item_id: row.item_id,
                sources: row.sources,
                is_primary: row.is_primary,
            },
        }
    }
}

// The Node projector inspects Mongo driver values before JSON serialization. For example,
// ObjectId and Decimal128 are objects, and an out-of-range BSON Int64 stays a Long.
fn catalog_source_document(doc: Document) -> Value {
    Value::Object(
        doc.into_iter()
            .map(|(name, value)| {
                let value = match (&*name, value) {
                    ("$date", Bson::DateTime(date)) => Value::from(date.timestamp_millis()),
                    (_, value) => catalog_source_value(value),
                };
                (name, value)
            })
            .collect(),
    )
}

fn catalog_source_value(value: Bson) -> Value {
    match value {
        Bson::Document(doc) => catalog_source_document(doc),
        Bson::Array(rows) => Value::Array(rows.into_iter().map(catalog_source_value).collect()),
        Bson::Int32(n) => Value::from(n),
        Bson::Int64(n) if n.unsigned_abs() <= 1 << 53 => Value::from(n),
        Bson::Double(n) => Value::from(n),
        Bson::String(s) | Bson::Symbol(s) => Value::String(s),
        Bson::Boolean(b) => Value::Bool(b),
        Bson::DateTime(d) => serde_json::json!({"$date":d.timestamp_millis()}),
        _ => Value::Null,
    }
}

fn project_mongo_graph(
    offers: impl IntoIterator<Item = Document>,
    items: impl IntoIterator<Item = Document>,
    assets: impl IntoIterator<Item = Document>,
    sub_items: impl IntoIterator<Item = Document>,
    collator: &CatalogCollation,
) -> Result<Vec<catalog::CatalogRecord>, catalog::CatalogProjectionError> {
    let offers = offers
        .into_iter()
        .map(|row| catalog::project_offer_with_collation(&catalog_source_document(row), collator))
        .collect::<Result<_, _>>()?;
    let items = items
        .into_iter()
        .map(|row| catalog::project_item_with_collation(&catalog_source_document(row), collator))
        .collect::<Result<_, _>>()?;
    let assets = assets
        .into_iter()
        .map(|row| catalog::project_asset(&catalog_source_document(row)))
        .collect::<Result<_, _>>()?;
    let sub_items = sub_items.into_iter().map(catalog_source_document);
    catalog::assemble_catalog_graph(offers, items, assets, sub_items, collator)
}

/// Async MongoDB data source abstraction for catalog hydration and v1 indexes.
#[async_trait]
pub trait CatalogMongoDataSource: Send + Sync {
    async fn find_one(
        &self,
        collection: &str,
        filter: Document,
    ) -> Result<Option<Document>, CatalogMongoError>;

    async fn find_limited(
        &self,
        collection: &str,
        filter: Document,
        limit: i64,
    ) -> Result<Vec<Document>, CatalogMongoError>;

    async fn create_index(
        &self,
        collection: &str,
        keys: Document,
        name: &str,
        background: bool,
    ) -> Result<(), CatalogMongoError>;
}

/// Live `mongodb::Database` implementation of [`CatalogMongoDataSource`].
#[derive(Clone)]
pub struct MongoDatabaseSource {
    db: Database,
}

impl MongoDatabaseSource {
    pub fn new(db: Database) -> Self {
        Self { db }
    }
}

#[async_trait]
impl CatalogMongoDataSource for MongoDatabaseSource {
    async fn find_one(
        &self,
        collection: &str,
        filter: Document,
    ) -> Result<Option<Document>, CatalogMongoError> {
        Ok(self
            .db
            .collection::<bson::RawDocumentBuf>(collection)
            .find_one(filter)
            .await?
            .map(crate::mongo::native_document)
            .transpose()?)
    }

    async fn find_limited(
        &self,
        collection: &str,
        filter: Document,
        limit: i64,
    ) -> Result<Vec<Document>, CatalogMongoError> {
        use futures::TryStreamExt;
        let opts = FindOptions::builder().limit(limit).build();
        let cursor = self
            .db
            .collection::<Document>(collection)
            .find(filter)
            .with_options(opts)
            .await?;
        Ok(crate::mongo::native_documents(cursor).try_collect().await?)
    }

    async fn create_index(
        &self,
        collection: &str,
        keys: Document,
        name: &str,
        _background: bool,
    ) -> Result<(), CatalogMongoError> {
        let opts = IndexOptions::builder().name(name.to_string()).build();
        let model = IndexModel::builder().keys(keys).options(opts).build();
        self.db
            .collection::<Document>(collection)
            .create_index(model)
            .await?;
        Ok(())
    }
}

// The Node MongoDB driver promotes BSON symbols to strings before the resolver sees them.
fn driver_string(value: &Bson) -> Option<&str> {
    match value {
        Bson::String(value) | Bson::Symbol(value) => Some(value),
        _ => None,
    }
}

fn doc_str(doc: &Document, key: &str) -> Option<String> {
    doc.get(key).and_then(driver_string).map(str::to_owned)
}

fn item_identity(doc: &Document) -> Option<(String, String)> {
    Some((
        doc_str(doc, "namespace").filter(|s| !s.is_empty())?,
        doc_str(doc, "id").filter(|s| !s.is_empty())?,
    ))
}

fn doc_strings<'a>(doc: &'a Document, key: &str) -> impl Iterator<Item = &'a str> {
    doc.get_array(key)
        .into_iter()
        .flatten()
        .filter_map(driver_string)
}

/// Catalog hydration resolver matching `MongoCatalogHydrationResolver` in `src/catalog/resolver.ts`.
pub struct MongoCatalogHydrationResolver<S: CatalogMongoDataSource> {
    source: S,
    collation: CatalogCollation,
}

impl<S: CatalogMongoDataSource> MongoCatalogHydrationResolver<S> {
    pub fn new(source: S) -> Self {
        Self {
            source,
            collation: node_collator(),
        }
    }

    pub fn new_with_locale(source: S, locale: &str) -> Result<Self, String> {
        Ok(Self {
            source,
            collation: CatalogCollation::for_locale(locale)?,
        })
    }

    pub async fn resolve(
        &self,
        identifier: CatalogHydrationIdentifier,
        request: &CatalogHydrationRequest,
    ) -> CatalogHydrationRootResult {
        let root_key = catalog_hydration_root_key(&identifier);
        let hydrated_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);

        match self
            .resolve_inner(&identifier, &root_key, &hydrated_at, request)
            .await
        {
            Ok(res) => res,
            Err(_) => CatalogHydrationRootResult {
                schema_version: CATALOG_HYDRATION_SCHEMA_VERSION,
                root_key,
                identifier,
                hydrated_at,
                status: "error".into(),
                graph_hash: None,
                record_keys: None,
                records: None,
                error: Some(CatalogSafeError {
                    code: "CATALOG_ROOT_RESOLUTION_FAILED".into(),
                    message: "This catalog root could not be hydrated.".into(),
                }),
            },
        }
    }

    async fn resolve_inner(
        &self,
        identifier: &CatalogHydrationIdentifier,
        root_key: &str,
        hydrated_at: &str,
        request: &CatalogHydrationRequest,
    ) -> Result<CatalogHydrationRootResult, CatalogMongoError> {
        let Some(owner) = self.find_owner(identifier).await? else {
            return Ok(CatalogHydrationRootResult {
                schema_version: CATALOG_HYDRATION_SCHEMA_VERSION,
                root_key: root_key.to_string(),
                identifier: identifier.clone(),
                hydrated_at: hydrated_at.to_string(),
                status: "not-found".into(),
                graph_hash: None,
                record_keys: None,
                records: None,
                error: None,
            });
        };

        let records = self.resolve_records(owner).await?;
        let graph_hash = graph_hash_for_records_with_collation(&records, &self.collation);
        if request
            .known_roots
            .iter()
            .find(|kr| kr.root_key == root_key)
            .is_some_and(|kr| kr.graph_hash == graph_hash)
        {
            return Ok(CatalogHydrationRootResult {
                schema_version: CATALOG_HYDRATION_SCHEMA_VERSION,
                root_key: root_key.to_string(),
                identifier: identifier.clone(),
                hydrated_at: hydrated_at.to_string(),
                status: "unchanged".into(),
                graph_hash: Some(graph_hash),
                record_keys: None,
                records: None,
                error: None,
            });
        }

        let known_records: HashMap<&str, &str> = request
            .known_records
            .iter()
            .map(|r| (r.record_key.as_str(), r.sha256.as_str()))
            .collect();
        let record_keys = records.iter().map(|r| r.record_key.clone()).collect();
        let delta: Vec<CatalogHydrationRecord> = records
            .into_iter()
            .filter(|r| known_records.get(r.record_key.as_str()) != Some(&r.sha256.as_str()))
            .collect();

        Ok(CatalogHydrationRootResult {
            schema_version: CATALOG_HYDRATION_SCHEMA_VERSION,
            root_key: root_key.to_string(),
            identifier: identifier.clone(),
            hydrated_at: hydrated_at.to_string(),
            status: "resolved".into(),
            graph_hash: Some(graph_hash),
            record_keys: Some(record_keys),
            records: Some(delta),
            error: None,
        })
    }

    async fn find_owner(
        &self,
        identifier: &CatalogHydrationIdentifier,
    ) -> Result<Option<Document>, CatalogMongoError> {
        match identifier {
            CatalogHydrationIdentifier::Item { namespace, id } => {
                self.source
                    .find_one("items", doc! { "namespace": namespace, "id": id })
                    .await
            }
            CatalogHydrationIdentifier::Asset {
                namespace,
                artifact_id,
                platform,
            } => {
                let asset = self
                    .source
                    .find_one(
                        "assets",
                        doc! {
                            "namespace": namespace,
                            "artifactId": artifact_id,
                            "platform": platform,
                        },
                    )
                    .await?;
                let Some(item_id) = asset
                    .as_ref()
                    .and_then(|a| doc_str(a, "itemId"))
                    .filter(|id| !id.is_empty())
                else {
                    return Ok(None);
                };
                self.source
                    .find_one("items", doc! { "namespace": namespace, "id": item_id })
                    .await
            }
            CatalogHydrationIdentifier::ReleaseApp {
                namespace,
                app_id,
                platform,
            } => {
                self.source
                    .find_one(
                        "items",
                        doc! {
                            "namespace": namespace,
                            "releaseInfo": {
                                "$elemMatch": {
                                    "appId": app_id,
                                    "platform": platform,
                                }
                            }
                        },
                    )
                    .await
            }
        }
    }

    async fn resolve_records(
        &self,
        owner: Document,
    ) -> Result<Vec<CatalogHydrationRecord>, CatalogMongoError> {
        let (owner_ns, owner_id) = item_identity(&owner)
            .ok_or_else(|| CatalogMongoError::Projection("Owner item is invalid".into()))?;
        let mut observed_offer_ids: IndexSet<String> = doc_strings(&owner, "linkedOffers")
            .map(str::to_owned)
            .collect();

        let direct_offers = self
            .source
            .find_limited(
                "offers",
                doc! {
                    "$or": [
                        { "items": { "$elemMatch": { "id": &owner_id, "namespace": &owner_ns } } },
                        { "namespace": &owner_ns, "items": { "$elemMatch": { "id": &owner_id, "namespace": { "$exists": false } } } }
                    ]
                },
                QUERY_LIMIT,
            )
            .await?;

        let owner_subitems = self
            .source
            .find_limited(
                "offersubitems",
                doc! { "subItems.id": &owner_id },
                QUERY_LIMIT,
            )
            .await?;

        for offer in &direct_offers {
            if let Some(oid) = doc_str(offer, "id").filter(|id| !id.is_empty()) {
                observed_offer_ids.insert(oid);
            }
        }
        for rel in &owner_subitems {
            if let Some(oid) = doc_str(rel, "offerId")
                .or_else(|| doc_str(rel, "_id"))
                .filter(|id| !id.is_empty())
            {
                observed_offer_ids.insert(oid);
            }
        }

        let related_offers = if observed_offer_ids.is_empty() {
            Vec::new()
        } else {
            let ids_bson: Vec<Bson> = observed_offer_ids.into_iter().map(Bson::String).collect();
            self.source
                .find_limited("offers", doc! { "id": { "$in": ids_bson } }, QUERY_LIMIT)
                .await?
        };

        let mut offers_by_identity = IndexMap::new();
        for offer in direct_offers {
            if let Some(identity) = item_identity(&offer) {
                offers_by_identity.insert(identity, offer);
            }
        }
        for offer in related_offers {
            if let Some(identity) = item_identity(&offer)
                && identity.0 == owner_ns
            {
                offers_by_identity.insert(identity, offer);
            }
        }
        let offers: Vec<_> = offers_by_identity.into_values().collect();
        let selected_offer_ids: Vec<String> =
            offers.iter().filter_map(|o| doc_str(o, "id")).collect();

        let sub_items = if selected_offer_ids.is_empty() {
            Vec::new()
        } else {
            let ids_bson: Vec<Bson> = selected_offer_ids
                .iter()
                .cloned()
                .map(Bson::String)
                .collect();
            self.source
                .find_limited(
                    "offersubitems",
                    doc! {
                        "$or": [
                            { "_id": { "$in": &ids_bson } },
                            { "offerId": { "$in": &ids_bson } }
                        ]
                    },
                    QUERY_LIMIT,
                )
                .await?
        };

        let mut references = collect_item_references(&offers, &sub_items);
        references.push((Some(owner_ns.clone()), owner_id.clone()));
        let sibling_ids: Vec<Bson> = references
            .iter()
            .map(|(_, id)| id.clone())
            .collect::<IndexSet<_>>()
            .into_iter()
            .map(Bson::String)
            .collect();

        let linked_items = if selected_offer_ids.is_empty() {
            Vec::new()
        } else {
            let ids_bson: Vec<Bson> = selected_offer_ids
                .iter()
                .cloned()
                .map(Bson::String)
                .collect();
            self.source
                .find_limited(
                    "items",
                    doc! {
                        "namespace": &owner_ns,
                        "linkedOffers": { "$in": ids_bson }
                    },
                    QUERY_LIMIT,
                )
                .await?
        };
        let referenced_items = self
            .source
            .find_limited("items", doc! { "id": { "$in": sibling_ids } }, QUERY_LIMIT)
            .await?;

        let selected_offer_set: HashSet<&str> =
            selected_offer_ids.iter().map(String::as_str).collect();
        let reference_set: HashSet<_> = references
            .iter()
            .map(|(namespace, id)| (namespace.as_deref(), id.as_str()))
            .collect();
        let mut items_by_identity = IndexMap::new();
        for item in std::iter::once(owner)
            .chain(referenced_items)
            .chain(linked_items)
        {
            let Some((ns, id)) = item_identity(&item) else {
                continue;
            };
            let explicitly_referenced = reference_set.contains(&(Some(ns.as_str()), id.as_str()))
                || reference_set.contains(&(None, id.as_str()));
            if explicitly_referenced
                || doc_strings(&item, "linkedOffers").any(|id| selected_offer_set.contains(id))
            {
                items_by_identity.insert((ns, id), item);
            }
        }
        let items: Vec<_> = items_by_identity.into_values().collect();

        let item_filters: Vec<Bson> = items
            .iter()
            .filter_map(item_identity)
            .map(|(ns, id)| Bson::Document(doc! { "namespace": ns, "itemId": id }))
            .collect();
        let assets = self
            .source
            .find_limited("assets", doc! { "$or": item_filters }, QUERY_LIMIT)
            .await?;

        let records = project_mongo_graph(offers, items, assets, sub_items, &self.collation)
            .map_err(|error| CatalogMongoError::Projection(error.0))?;
        let mut unique = IndexMap::new();
        for record in records {
            unique.insert(catalog::catalog_record_key(&record), record);
            if unique.len() > CATALOG_HYDRATION_MAX_ROOT_RECORDS {
                return Err(CatalogMongoError::Projection(
                    "Root exceeds record limit".into(),
                ));
            }
        }
        unique.sort_by(|left, _, right, _| self.collation.compare(left, right));
        unique
            .into_iter()
            .map(|(record_key, record)| {
                let value = serde_json::to_value(&record)
                    .map_err(|e| CatalogMongoError::Projection(e.to_string()))?;
                Ok(CatalogHydrationRecord {
                    record_key,
                    sha256: sha256_hex(&stable_json_with_collation(&value, &self.collation)),
                    record: record.into(),
                })
            })
            .collect()
    }
}

fn collect_item_references(
    offers: &[Document],
    sub_items: &[Document],
) -> Vec<(Option<String>, String)> {
    let mut references = IndexSet::new();
    let mut add = |candidate: &Bson, fallback_ns: Option<&str>| {
        let Some(doc) = candidate.as_document() else {
            return;
        };
        let Some(id) = doc_str(doc, "id").filter(|id| !id.is_empty()) else {
            return;
        };
        let ns = doc_str(doc, "namespace").or_else(|| fallback_ns.map(ToString::to_string));
        references.insert((ns.filter(|s| !s.is_empty()), id));
    };

    for offer in offers {
        let ns = doc_str(offer, "namespace");
        if let Ok(arr) = offer.get_array("items") {
            for candidate in arr {
                add(candidate, ns.as_deref());
            }
        }
    }
    for rel in sub_items {
        let ns = doc_str(rel, "namespace").or_else(|| doc_str(rel, "offerNamespace"));
        if let Ok(arr) = rel.get_array("subItems") {
            for candidate in arr {
                add(candidate, ns.as_deref());
            }
        }
    }
    references.into_iter().collect()
}

/// Ensures the 5 catalog hydration MongoDB indexes (`ensureCatalogHydrationIndexes` in `src/catalog/resolver.ts`).
pub async fn ensure_catalog_hydration_indexes(
    source: &dyn CatalogMongoDataSource,
) -> Result<(), CatalogMongoError> {
    let specs = [
        (
            "items",
            doc! { "namespace": 1, "id": 1 },
            "catalog_item_identity",
        ),
        (
            "offers",
            doc! { "namespace": 1, "id": 1 },
            "catalog_offer_identity",
        ),
        (
            "assets",
            doc! { "namespace": 1, "artifactId": 1, "platform": 1 },
            "catalog_asset_identity",
        ),
        (
            "assets",
            doc! { "namespace": 1, "itemId": 1 },
            "catalog_asset_owner",
        ),
        (
            "offersubitems",
            doc! { "subItems.id": 1 },
            "catalog_subitem_item",
        ),
    ];
    futures::future::try_join_all(
        specs
            .into_iter()
            .map(|(col, keys, name)| source.create_index(col, keys, name, false)),
    )
    .await?;
    Ok(())
}

// --- v1 MongoDB Index Plan (`src/v1/indexes.ts`) ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V1IndexPlanEntry {
    pub collection: &'static str,
    pub keys: &'static [(&'static str, i32)],
    pub name: &'static str,
}

pub const V1_INDEX_PLAN: &[V1IndexPlanEntry] = &[
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("id", 1)],
        name: "v1_offer_id",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("lastModifiedDate", -1), ("id", 1)],
        name: "v1_offer_last_modified_id",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("releaseDate", 1), ("id", 1)],
        name: "v1_offer_release_id",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("releaseDate", -1), ("id", 1)],
        name: "v1_offer_release_desc_id",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("creationDate", -1), ("id", 1)],
        name: "v1_offer_creation_desc_id",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("tags.id", 1)],
        name: "v1_offer_tags",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("namespace", 1), ("offerType", 1)],
        name: "v1_offer_namespace_type",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("seller.id", 1), ("lastModifiedDate", -1), ("id", 1)],
        name: "v1_offer_seller_modified",
    },
    V1IndexPlanEntry {
        collection: "items",
        keys: &[("id", 1)],
        name: "v1_item_id",
    },
    V1IndexPlanEntry {
        collection: "items",
        keys: &[("lastModifiedDate", -1), ("id", 1)],
        name: "v1_item_modified_id",
    },
    V1IndexPlanEntry {
        collection: "items",
        keys: &[("namespace", 1), ("lastModifiedDate", -1), ("id", 1)],
        name: "v1_item_namespace_modified",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("namespace", 1), ("lastModifiedDate", -1), ("id", 1)],
        name: "v1_offer_namespace_modified",
    },
    V1IndexPlanEntry {
        collection: "offers",
        keys: &[("tags.id", 1), ("lastModifiedDate", -1), ("id", 1)],
        name: "v1_offer_tag_modified",
    },
    V1IndexPlanEntry {
        collection: "changelogs_v2",
        keys: &[("metadata.contextType", 1), ("timestamp", -1)],
        name: "v1_changelog_type_timestamp",
    },
    V1IndexPlanEntry {
        collection: "pricev2",
        keys: &[("region", 1), ("offerId", 1), ("updatedAt", -1)],
        name: "v1_price_region_offer_updated",
    },
    V1IndexPlanEntry {
        collection: "pricev2",
        keys: &[("region", 1), ("appliedRules.endDate", 1), ("offerId", 1)],
        name: "v1_price_region_sale_end",
    },
    V1IndexPlanEntry {
        collection: "pricev2_historical",
        keys: &[("offerId", 1), ("region", 1), ("date", -1)],
        name: "v1_price_history_offer_region_date",
    },
    V1IndexPlanEntry {
        collection: "pricev2_historical",
        keys: &[("offerId", 1), ("region", 1), ("price.discountPrice", 1)],
        name: "v1_price_history_offer_region_price",
    },
    V1IndexPlanEntry {
        collection: "changelogs_v2",
        keys: &[("timestamp", -1), ("_id", 1)],
        name: "v1_changelog_timestamp_id",
    },
    V1IndexPlanEntry {
        collection: "changelogs_v2",
        keys: &[("metadata.contextId", 1), ("timestamp", -1)],
        name: "v1_changelog_context_timestamp",
    },
    V1IndexPlanEntry {
        collection: "tags",
        keys: &[("groupName", 1), ("status", 1)],
        name: "v1_tag_group_status",
    },
    V1IndexPlanEntry {
        collection: "tags",
        keys: &[("updated", -1), ("id", 1)],
        name: "v1_tag_updated_id",
    },
    V1IndexPlanEntry {
        collection: "tags",
        keys: &[("groupName", 1), ("referenceCount", -1)],
        name: "v1_tag_group_reference",
    },
    V1IndexPlanEntry {
        collection: "freegames",
        keys: &[("endDate", -1), ("id", -1)],
        name: "v1_freegame_end_id",
    },
    V1IndexPlanEntry {
        collection: "freegames",
        keys: &[("id", 1)],
        name: "v1_freegame_id",
    },
    V1IndexPlanEntry {
        collection: "mobile-freebies",
        keys: &[("endDate", -1), ("offerId", 1)],
        name: "v1_mobile_freebie_end_offer",
    },
    V1IndexPlanEntry {
        collection: "game_positions",
        keys: &[("collectionId", 1), ("position", 1), ("offerId", 1)],
        name: "v1_position_collection_rank",
    },
    V1IndexPlanEntry {
        collection: "game_positions",
        keys: &[("offerId", 1)],
        name: "v1_position_offer",
    },
    V1IndexPlanEntry {
        collection: "builds",
        keys: &[("appName", 1), ("updatedAt", -1)],
        name: "v1_build_app_updated",
    },
    V1IndexPlanEntry {
        collection: "builds",
        keys: &[("appName", 1), ("firstSeenAt", -1), ("_id", -1)],
        name: "v1_build_app_history",
    },
    V1IndexPlanEntry {
        collection: "builds",
        keys: &[("createdAt", 1), ("_id", 1)],
        name: "v1_build_created",
    },
    V1IndexPlanEntry {
        collection: "files",
        keys: &[("fileName", 1)],
        name: "v1_file_name",
    },
    V1IndexPlanEntry {
        collection: "files",
        keys: &[("manifestHash", 1), ("fileName", 1)],
        name: "v1_file_manifest_name",
    },
    V1IndexPlanEntry {
        collection: "files",
        keys: &[("manifestId", 1), ("fileName", 1)],
        name: "v1_file_manifest_id_name",
    },
    V1IndexPlanEntry {
        collection: "sandboxes",
        keys: &[("lastModified", -1)],
        name: "v1_sandbox_modified",
    },
    V1IndexPlanEntry {
        collection: "namespaces",
        keys: &[("_id", 1)],
        name: "v1_namespace_id",
    },
    V1IndexPlanEntry {
        collection: "sellers",
        keys: &[("_id", 1)],
        name: "v1_seller_id",
    },
    V1IndexPlanEntry {
        collection: "collections_v2",
        keys: &[("_id", 1)],
        name: "v1_collection_id",
    },
    V1IndexPlanEntry {
        collection: "reviews",
        keys: &[("id", 1), ("createdAt", -1), ("_id", -1)],
        name: "v1_review_offer_created",
    },
    V1IndexPlanEntry {
        collection: "offersubitems",
        keys: &[("_id", 1)],
        name: "v1_offer_subitems_id",
    },
    V1IndexPlanEntry {
        collection: "offer_requirements",
        keys: &[("namespace", 1), ("offerId", 1), ("platform", 1)],
        name: "v1_offer_requirements",
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnsureV1IndexesResult {
    pub created: usize,
    pub failed: usize,
}

static V1_INDEXES_ENSURED: AtomicBool = AtomicBool::new(false);

/// Ensures all v1 MongoDB indexes using the process-wide guard (`src/v1/indexes.ts`).
pub async fn ensure_v1_indexes(
    source: &dyn CatalogMongoDataSource,
    force: bool,
) -> EnsureV1IndexesResult {
    ensure_v1_indexes_with_guard(source, &V1_INDEXES_ENSURED, force).await
}

pub async fn ensure_v1_indexes_with_guard(
    source: &dyn CatalogMongoDataSource,
    ensured_flag: &AtomicBool,
    force: bool,
) -> EnsureV1IndexesResult {
    if ensured_flag.load(Ordering::Relaxed) && !force {
        return EnsureV1IndexesResult {
            created: 0,
            failed: 0,
        };
    }

    let mut created = 0usize;
    let mut failed = 0usize;
    for plan in V1_INDEX_PLAN {
        let mut keys_doc = Document::new();
        for &(field, order) in plan.keys {
            keys_doc.insert(field, order);
        }
        match source
            .create_index(plan.collection, keys_doc, plan.name, true)
            .await
        {
            Ok(()) => created += 1,
            Err(err) => {
                failed += 1;
                warn!(
                    "[v1] Could not create index {}.{}: {err}",
                    plan.collection, plan.name
                );
            }
        }
    }

    ensured_flag.store(true, Ordering::Relaxed);
    info!("[v1] Index plan checked ({created} ensured, {failed} failed)");
    EnsureV1IndexesResult { created, failed }
}

// --- v1 OpenSearch Search Mappings (`src/v1/search-mappings.ts`) ---

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchFieldRequirement {
    pub path: &'static str,
    pub types: &'static [&'static str],
    pub requires_subfield: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchIndexRequirement {
    pub index: &'static str,
    pub fields: &'static [SearchFieldRequirement],
}

pub const V1_SEARCH_REQUIREMENTS: &[SearchIndexRequirement] = &[
    SearchIndexRequirement {
        index: "egdata.offers",
        fields: &[
            SearchFieldRequirement {
                path: "id.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "title",
                types: &["text"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "description",
                types: &["text"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "lastModifiedDate",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "releaseDate",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "effectiveDate",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "creationDate",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "viewableDate",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "pcReleaseDate",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "offerType.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "tags.id.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "tags.name.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "categories.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "customAttributes.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "seller.id.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "seller.name.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "developerDisplayName.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "publisherDisplayName.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "refundType.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "lastBuilds.technologies.technology.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "freeEntries.endDate",
                types: &["date"],
                requires_subfield: false,
            },
        ],
    },
    SearchIndexRequirement {
        index: "egdata.items",
        fields: &[
            SearchFieldRequirement {
                path: "lastModifiedDate",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "id.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "namespace.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "entitlementType.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
        ],
    },
    SearchIndexRequirement {
        index: "egdata.changelog",
        fields: &[
            SearchFieldRequirement {
                path: "timestamp",
                types: &["date"],
                requires_subfield: false,
            },
            SearchFieldRequirement {
                path: "metadata.contextId.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
            SearchFieldRequirement {
                path: "metadata.contextType.keyword",
                types: &["keyword"],
                requires_subfield: true,
            },
        ],
    },
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchMappingReport {
    pub index: String,
    pub missing: Vec<String>,
    pub incompatible: Vec<String>,
    pub applied: Vec<String>,
}

fn lookup_mapping<'a>(properties: Option<&'a Value>, path: &str) -> Option<&'a Value> {
    let mut segments = path.split('.');
    let mut current = properties?.get(segments.next()?)?;
    for segment in segments {
        current = current["properties"]
            .get(segment)
            .or_else(|| current["fields"].get(segment))?;
    }
    Some(current)
}

fn parent_properties_mut<'a>(
    mapping: &'a mut Map<String, Value>,
    path: &str,
) -> Option<&'a mut Map<String, Value>> {
    let segments: Vec<&str> = path.split('.').collect();
    if segments.is_empty() {
        return None;
    }
    let props_val = mapping
        .entry("properties")
        .or_insert_with(|| Value::Object(Map::new()));
    let mut current = props_val.as_object_mut()?;
    for seg in &segments[..segments.len() - 1] {
        let child = current
            .entry((*seg).to_string())
            .or_insert_with(|| serde_json::json!({ "properties": {} }));
        let child_obj = child.as_object_mut()?;
        let nested_props = child_obj
            .entry("properties")
            .or_insert_with(|| Value::Object(Map::new()));
        current = nested_props.as_object_mut()?;
    }
    Some(current)
}

/// Inspects and optionally applies OpenSearch v1 mappings (`ensureV1SearchMappings` in `src/v1/search-mappings.ts`).
pub async fn ensure_v1_search_mappings(
    client: &dyn OpenSearchMappingClient,
    apply: bool,
) -> Result<Vec<SearchMappingReport>, SearchClientError> {
    let mut reports = Vec::with_capacity(V1_SEARCH_REQUIREMENTS.len());

    for requirement in V1_SEARCH_REQUIREMENTS {
        let mut report = SearchMappingReport {
            index: requirement.index.to_string(),
            missing: Vec::new(),
            incompatible: Vec::new(),
            applied: Vec::new(),
        };

        let mut mapping_val = match client.get_mapping(requirement.index).await? {
            Some(Value::Object(obj)) => Value::Object(obj),
            _ => {
                report.missing.push("* (index does not exist)".into());
                reports.push(report);
                continue;
            }
        };
        let mapping_obj = mapping_val.as_object_mut().expect("checked object");

        for field in requirement.fields {
            if let Some(existing) = lookup_mapping(mapping_obj.get("properties"), field.path) {
                let existing_type = existing.get("type").and_then(Value::as_str).unwrap_or("");
                if existing.get("properties").is_some() || field.types.contains(&existing_type) {
                    continue;
                }
                report
                    .incompatible
                    .push(format!("{} (found {existing_type})", field.path));
                continue;
            }

            report
                .missing
                .push(format!("{} ({})", field.path, field.types.join("|")));
            if !apply {
                continue;
            }
            if field.requires_subfield {
                report.incompatible.push(format!(
                    "{} (requires an explicit keyword subfield mapping)",
                    field.path
                ));
                continue;
            }

            let segments: Vec<&str> = field.path.split('.').collect();
            let last = *segments.last().expect("split is non-empty");
            let direct_parent_is_text = if segments.len() > 1 {
                let parent_path = segments[..segments.len() - 1].join(".");
                lookup_mapping(mapping_obj.get("properties"), &parent_path)
                    .and_then(|v| v.get("type"))
                    .and_then(Value::as_str)
                    == Some("text")
            } else {
                false
            };
            if direct_parent_is_text {
                report.incompatible.push(format!(
                    "{} (cannot add a subfield to an existing text field)",
                    field.path
                ));
                continue;
            }
            if let Some(parent) = parent_properties_mut(mapping_obj, field.path) {
                parent.insert(
                    last.to_string(),
                    serde_json::json!({ "type": field.types[0] }),
                );
                report.applied.push(field.path.to_string());
            }
        }

        if apply
            && !report.applied.is_empty()
            && let Some(props) = mapping_obj.get("properties")
        {
            client.put_mapping(requirement.index, props).await?;
        }

        reports.push(report);
    }

    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn mongo_projector_uses_node_locale_sorting() {
        let values = ["10", "2", "_", "-", "a", "A", "á", "ä", "e", "É", "z"];
        let collator = node_collator();
        let mut sorted = values.to_vec();
        sorted.sort_by(|left, right| collator.compare(left, right));
        assert_eq!(
            sorted,
            ["_", "-", "10", "2", "a", "A", "á", "ä", "e", "É", "z"]
        );
        let images = Value::Array(
            values
                .map(|value| json!({"type":value,"url":format!("https://example.test/{value}")}))
                .into(),
        );
        let tags = Value::Array(values.map(|id| json!({"id":id})).into());
        let attrs = Value::Array(values.map(|key| json!({"key":key,"value":"v"})).into());
        let offer = bson::to_document(&json!({"namespace":"ns", "id":"offer", "title":"Offer",
            "keyImages":images, "tags":tags, "customAttributes":attrs}))
        .unwrap();
        let graph = project_mongo_graph([offer], [], [], [], &collator).unwrap();
        let catalog::CatalogRecord::Offer(row) = &graph[0] else {
            panic!("expected offer")
        };
        assert_eq!(
            row.key_images
                .iter()
                .map(|v| v.image_type.as_str())
                .collect::<Vec<_>>(),
            sorted
        );
        assert_eq!(
            row.tags.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(),
            sorted
        );
        assert_eq!(
            row.custom_attributes
                .iter()
                .map(|v| v.key.as_str())
                .collect::<Vec<_>>(),
            sorted
        );
        assert_eq!(
            stable_json(
                &json!({"10":"ten","2":"two","01":"leading","4294967295":"max","á":"accent","_":"under","-":"dash"})
            ),
            "{\"2\":\"two\",\"10\":\"ten\",\"_\":\"under\",\"-\":\"dash\",\"01\":\"leading\",\"4294967295\":\"max\",\"á\":\"accent\"}"
        );

        let items = [doc! {"namespace":"ns","id":"item","title":"Item"}];
        let offers: Vec<_> = ["á", "_", "-", "2", "10"]
            .into_iter()
            .map(|id| {
                doc! {
                    "namespace":"ns", "id":id, "title":"Offer", "offerType":"BASE_GAME",
                    "prePurchase":false, "items":[{"namespace":"ns","id":"item"}]
                }
            })
            .collect();
        let graph: Vec<CatalogRecord> = project_mongo_graph(offers, items, [], [], &collator)
            .unwrap()
            .into_iter()
            .map(Into::into)
            .collect();
        let primary = graph.iter().find_map(|record| match record {
            CatalogRecord::OfferItem {
                offer_id,
                is_primary: true,
                ..
            } => Some(offer_id.as_str()),
            _ => None,
        });
        assert_eq!(primary, Some("_"));
    }

    #[test]
    fn offer_projection_preserves_purchase_and_country_restrictions() {
        let offer = doc! {
            "namespace": "ns",
            "id": "offer-1",
            "title": "Offer",
            "prePurchase": true,
            "countriesBlacklist": ["US", "CA"],
            "countriesWhitelist": ["GB"],
            "creationDate": { "$date": bson::DateTime::from_millis(1) },
        };

        let projected = project_mongo_graph([offer], [], [], [], &node_collator())
            .unwrap()
            .pop()
            .unwrap();
        let CatalogRecord::Offer {
            creation_date,
            pre_purchase,
            countries_blacklist,
            countries_whitelist,
            ..
        } = CatalogRecord::from(projected)
        else {
            panic!("expected an offer record");
        };
        assert_eq!(creation_date.as_deref(), Some("1970-01-01T00:00:00.001Z"));
        assert_eq!(pre_purchase, Some(true));
        assert_eq!(countries_blacklist, ["CA", "US"]);
        assert_eq!(countries_whitelist, ["GB"]);
    }

    #[test]
    fn catalog_graph_merges_direct_subitem_and_linked_offer_edges() {
        let collator = node_collator();
        let offers = [
            doc! {"namespace":"ns", "id":"offer-1", "title":"Preorder", "prePurchase":true, "offerType":"BASE_GAME", "items":[{"namespace":"ns","id":"item-1"}]},
            doc! {"namespace":"ns", "id":"offer-2", "title":"Released", "prePurchase":false, "offerType":"DLC"},
        ];
        let items = [doc! {
            "namespace":"ns",
            "id":"item-1",
            "title":"Item",
            "linkedOffers":["offer-2"],
        }];
        let subitems = [doc! {
            "_id":"offer-1",
            "subItems":[{"id":"item-1"}],
        }];

        let graph: Vec<CatalogRecord> = project_mongo_graph(offers, items, [], subitems, &collator)
            .unwrap()
            .into_iter()
            .map(Into::into)
            .collect();
        let edges: Vec<_> = graph
            .iter()
            .filter_map(|record| match record {
                CatalogRecord::OfferItem {
                    offer_id,
                    sources,
                    is_primary,
                    ..
                } => Some((offer_id.as_str(), sources, *is_primary)),
                _ => None,
            })
            .collect();
        assert_eq!(edges.len(), 2);
        assert!(edges.iter().any(|(offer, sources, _)| {
            *offer == "offer-1"
                && sources.as_slice()
                    == [
                        CatalogOfferItemSource::Direct,
                        CatalogOfferItemSource::Subitem,
                    ]
        }));
        assert!(
            edges
                .iter()
                .any(|(offer, sources, primary)| *offer == "offer-2"
                    && sources.as_slice() == [CatalogOfferItemSource::Linked]
                    && *primary)
        );
        assert!(
            edges
                .iter()
                .all(|(offer, _, primary)| *offer != "offer-1" || !primary)
        );
    }

    #[derive(Default)]
    struct MockMongoSource {
        collections: Mutex<HashMap<String, Vec<Document>>>,
        created_indexes: Mutex<Vec<(String, String, bool)>>,
        fail_index_names: Mutex<HashSet<String>>,
        reads_until_failure: Mutex<Option<u64>>,
    }

    impl MockMongoSource {
        fn check_read(&self) -> Result<(), CatalogMongoError> {
            if let Some(count) = self.reads_until_failure.lock().unwrap().as_mut() {
                *count -= 1;
                if *count == 0 {
                    return Err(CatalogMongoError::Projection("forced db error".into()));
                }
            }
            Ok(())
        }

        fn insert(&self, collection: &str, doc: Document) {
            self.collections
                .lock()
                .unwrap()
                .entry(collection.to_string())
                .or_default()
                .push(doc);
        }
    }

    fn doc_matches(doc: &Document, filter: &Document) -> bool {
        for (k, v) in filter {
            if k == "$or" {
                let Bson::Array(clauses) = v else {
                    return false;
                };
                if !clauses
                    .iter()
                    .any(|c| c.as_document().is_some_and(|d| doc_matches(doc, d)))
                {
                    return false;
                }
                continue;
            }
            if k == "releaseInfo" {
                let Some(elem) = v
                    .as_document()
                    .and_then(|d| d.get_document("$elemMatch").ok())
                else {
                    return false;
                };
                let Ok(arr) = doc.get_array("releaseInfo") else {
                    return false;
                };
                if !arr
                    .iter()
                    .any(|item| item.as_document().is_some_and(|d| doc_matches(d, elem)))
                {
                    return false;
                }
                continue;
            }
            if k == "items" {
                let Some(elem) = v
                    .as_document()
                    .and_then(|d| d.get_document("$elemMatch").ok())
                else {
                    return false;
                };
                let Ok(arr) = doc.get_array("items") else {
                    return false;
                };
                if !arr
                    .iter()
                    .any(|item| item.as_document().is_some_and(|d| doc_matches(d, elem)))
                {
                    return false;
                }
                continue;
            }
            if k == "subItems.id" {
                let target = v.as_str();
                let Ok(arr) = doc.get_array("subItems") else {
                    return false;
                };
                if !arr
                    .iter()
                    .any(|e| e.as_document().and_then(|d| d.get_str("id").ok()) == target)
                {
                    return false;
                }
                continue;
            }
            if let Some(fdoc) = v.as_document() {
                if let Ok(exists) = fdoc.get_bool("$exists") {
                    if doc.contains_key(k) != exists {
                        return false;
                    }
                    continue;
                }
                if let Ok(in_arr) = fdoc.get_array("$in") {
                    if let Ok(arr) = doc.get_array(k) {
                        if !arr.iter().any(|x| in_arr.contains(x)) {
                            return false;
                        }
                    } else if let Some(val) = doc.get(k) {
                        if !in_arr.contains(val) {
                            return false;
                        }
                    } else {
                        return false;
                    }
                    continue;
                }
            }
            match doc.get(k) {
                Some(Bson::Array(arr)) => {
                    if !arr.contains(v) {
                        return false;
                    }
                }
                Some(existing) if existing == v => {}
                _ => return false,
            }
        }
        true
    }

    #[async_trait]
    impl CatalogMongoDataSource for MockMongoSource {
        async fn find_one(
            &self,
            collection: &str,
            filter: Document,
        ) -> Result<Option<Document>, CatalogMongoError> {
            self.check_read()?;
            let cols = self.collections.lock().unwrap();
            Ok(cols
                .get(collection)
                .and_then(|docs| docs.iter().find(|d| doc_matches(d, &filter)).cloned()))
        }

        async fn find_limited(
            &self,
            collection: &str,
            filter: Document,
            limit: i64,
        ) -> Result<Vec<Document>, CatalogMongoError> {
            self.check_read()?;
            let cols = self.collections.lock().unwrap();
            Ok(cols
                .get(collection)
                .map(|docs| {
                    docs.iter()
                        .filter(|d| doc_matches(d, &filter))
                        .take(limit as usize)
                        .cloned()
                        .collect()
                })
                .unwrap_or_default())
        }

        async fn create_index(
            &self,
            collection: &str,
            _keys: Document,
            name: &str,
            background: bool,
        ) -> Result<(), CatalogMongoError> {
            if self.fail_index_names.lock().unwrap().contains(name) {
                return Err(CatalogMongoError::Projection("index failed".into()));
            }
            self.created_indexes.lock().unwrap().push((
                collection.to_string(),
                name.to_string(),
                background,
            ));
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockOpenSearchMappings {
        mappings: Mutex<HashMap<String, Option<Value>>>,
        applied_puts: Mutex<Vec<(String, Value)>>,
    }

    #[async_trait]
    impl OpenSearchMappingClient for MockOpenSearchMappings {
        async fn get_mapping(&self, index: &str) -> Result<Option<Value>, SearchClientError> {
            Ok(self.mappings.lock().unwrap().get(index).cloned().flatten())
        }

        async fn put_mapping(
            &self,
            index: &str,
            properties: &Value,
        ) -> Result<(), SearchClientError> {
            self.applied_puts
                .lock()
                .unwrap()
                .push((index.to_string(), properties.clone()));
            Ok(())
        }
    }

    #[tokio::test]
    async fn mongo_hydration_hashes_and_delta_match_node_oracle() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../egdata-api/tests/fixtures/hydration-mongo-node.json"
        ))
        .unwrap();
        for case in cases {
            let source = MockMongoSource::default();
            for (collection, rows) in case["tables"].as_object().unwrap() {
                for row in rows.as_array().unwrap() {
                    let Bson::Document(mut row) = Bson::try_from(row.clone()).unwrap() else {
                        panic!("fixture table rows must be documents");
                    };
                    if collection == "items"
                        && let Some(count) = case["generatedPlatforms"].as_u64()
                    {
                        let platforms: Vec<_> = (0..count).map(|i| i.to_string()).collect();
                        row.insert(
                            "releaseInfo",
                            vec![doc! { "appId":"app", "platform":platforms }],
                        );
                    }
                    source.insert(collection, row);
                }
            }
            *source.reads_until_failure.lock().unwrap() = case["failRead"].as_u64();
            let request: CatalogHydrationRequest =
                serde_json::from_value(case["request"].clone()).unwrap();
            let result = MongoCatalogHydrationResolver::new_with_locale(source, "en-US")
                .unwrap()
                .resolve(request.identifiers[0].clone(), &request)
                .await;
            if let Some(records) = &result.records {
                for record in records {
                    assert_eq!(catalog_record_key(&record.record), record.record_key);
                    let value = serde_json::to_value(&record.record).unwrap();
                    assert_eq!(sha256_hex(&stable_json(&value)), record.sha256);
                }
                if request.known_records.is_empty() {
                    assert_eq!(Some(graph_hash_for_records(records)), result.graph_hash);
                }
            }
            let mut actual = serde_json::to_value(result).unwrap();
            let time = actual
                .as_object_mut()
                .unwrap()
                .remove("hydratedAt")
                .unwrap();
            chrono::DateTime::parse_from_rfc3339(time.as_str().unwrap()).unwrap();
            let wire = egdata_core::v1::serialization::node_json(&actual);
            assert_eq!(
                serde_json::from_str::<Value>(&wire).unwrap(),
                case["result"]
            );
        }
    }

    #[tokio::test]
    async fn catalog_hydration_resolver_covers_all_statuses_and_identifiers() {
        let source = MockMongoSource::default();
        let dt = bson::DateTime::from_millis(1_700_000_000_000);
        source.insert(
            "items",
            doc! {
                "namespace": "ns1",
                "id": "item /1",
                "title": "Main Item",
                "categories": [{ "path": "games" }, "edition"],
                "keyImages": [
                    { "type": "DieselGameBoxTall", "url": "https://cdn/img2.png" },
                    { "type": "DieselGameBox", "url": "https://cdn/img.png", "md5": "abc" }
                ],
                "customAttributes": [
                    { "key": "k2", "value": "v2" },
                    { "key": "k1", "value": "v1", "type": "STRING" }
                ],
                "releaseInfo": [
                    null,
                    { "platform": [] },
                    { "id": "rel1", "appId": "App1", "platform": ["Windows"] }
                ],
                "linkedOffers": ["offer2", "offer3"],
                "creationDate": { "$date": 1_700_000_000_000_i64 },
                "entitlementStartDate": { "$date": "2025-01-01T00:00:00Z" },
                "entitlementEndDate": true,
                "lastModifiedDate": dt,
            },
        );
        source.insert(
            "items",
            doc! {
                "namespace": "ns1",
                "id": "isolated",
                "title": "Isolated Item",
                "releaseInfo": [{ "appId": "IsoApp" }],
            },
        );
        source.insert(
            "items",
            doc! {
                "namespace": "ns1",
                "id": "oversized",
                "title": "Oversized Item",
                "releaseInfo": (0..505).map(|i| Bson::Document(doc! { "appId": format!("A{i}"), "platform": ["Win"] })).collect::<Vec<_>>(),
            },
        );
        source.insert(
            "offers",
            doc! {
                "namespace": "ns1",
                "id": "offer1",
                "title": "Base Offer",
                "offerType": "BASE_GAME",
                "prePurchase": false,
                "seller": { "id": "sel1", "name": "Seller" },
                "tags": [{ "id": "t2" }, { "id": "t1", "name": "RPG" }],
                "items": [{ "id": "item /1", "namespace": "ns1" }],
                "offerMappings": [{ "pageSlug": "slug-1", "pageType": "productHome" }],
                "lastModifiedDate": dt,
            },
        );
        source.insert(
            "offers",
            doc! {
                "namespace": "ns1",
                "id": "offer2",
                "title": "Pre-Purchase Offer",
                "offerType": "EDITION",
                "prePurchase": true,
                "items": [],
                "lastModifiedDate": dt,
            },
        );
        source.insert(
            "offers",
            doc! {
                "namespace": "ns1",
                "id": "offer3",
                "title": "DLC Offer",
                "offerType": "DLC",
                "prePurchase": false,
                "items": [],
                "lastModifiedDate": dt,
            },
        );
        source.insert(
            "offersubitems",
            doc! {
                "_id": "offer1",
                "offerId": "offer1",
                "namespace": "ns1",
                "subItems": [null, {}, { "id": "missing_item" }, { "id": "item /1" }],
            },
        );
        source.insert(
            "assets",
            doc! {
                "namespace": "ns1",
                "artifactId": "Art1",
                "platform": "Windows",
                "itemId": "item /1",
                "downloadSizeBytes": 1000_i64,
                "installedSizeBytes": 2000_i64,
            },
        );

        let resolver = MongoCatalogHydrationResolver::new(source);
        let empty_req = CatalogHydrationRequest {
            schema_version: 2,
            identifiers: vec![],
            known_roots: vec![],
            known_records: vec![],
        };

        // 1. Resolve by item
        let item_id = CatalogHydrationIdentifier::Item {
            namespace: "ns1".into(),
            id: "item /1".into(),
        };
        let res = resolver.resolve(item_id.clone(), &empty_req).await;
        assert_eq!(res.status, "resolved");
        let records = res.records.as_ref().unwrap();
        assert_eq!(records.len(), 9);
        let graph_hash = res.graph_hash.clone().unwrap();

        // Primary offer should be offer1 (not offer2 prePurchase)
        let primary_edge = records
            .iter()
            .find_map(|r| match &r.record {
                CatalogRecord::OfferItem {
                    offer_id,
                    is_primary: true,
                    sources,
                    ..
                } if offer_id == "offer1" => Some(sources.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(
            primary_edge,
            vec![
                CatalogOfferItemSource::Direct,
                CatalogOfferItemSource::Subitem
            ]
        );

        // 2. Unchanged status via known_roots
        let unchanged_req = CatalogHydrationRequest {
            schema_version: 2,
            identifiers: vec![],
            known_roots: vec![KnownRoot {
                root_key: res.root_key.clone(),
                graph_hash: graph_hash.clone(),
            }],
            known_records: vec![],
        };
        assert_eq!(
            resolver
                .resolve(item_id.clone(), &unchanged_req)
                .await
                .status,
            "unchanged"
        );

        // 3. Delta filtering via known_records
        let partial_req = CatalogHydrationRequest {
            schema_version: 2,
            identifiers: vec![],
            known_roots: vec![],
            known_records: vec![KnownRecord {
                record_key: records[0].record_key.clone(),
                sha256: records[0].sha256.clone(),
            }],
        };
        let delta_res = resolver.resolve(item_id.clone(), &partial_req).await;
        assert_eq!(delta_res.records.as_ref().unwrap().len(), records.len() - 1);

        // 4. Resolve by asset and release-app
        let asset_res = resolver
            .resolve(
                CatalogHydrationIdentifier::Asset {
                    namespace: "ns1".into(),
                    artifact_id: "Art1".into(),
                    platform: "Windows".into(),
                },
                &empty_req,
            )
            .await;
        assert_eq!(asset_res.status, "resolved");

        let rel_res = resolver
            .resolve(
                CatalogHydrationIdentifier::ReleaseApp {
                    namespace: "ns1".into(),
                    app_id: "App1".into(),
                    platform: "Windows".into(),
                },
                &empty_req,
            )
            .await;
        assert_eq!(rel_res.status, "resolved");

        // 5. Not-found
        let nf = resolver
            .resolve(
                CatalogHydrationIdentifier::Asset {
                    namespace: "ns1".into(),
                    artifact_id: "Missing".into(),
                    platform: "Windows".into(),
                },
                &empty_req,
            )
            .await;
        assert_eq!(nf.status, "not-found");

        // 5b. Isolated item (no offers/assets) + oversized root (>500 records -> error)
        let iso = resolver
            .resolve(
                CatalogHydrationIdentifier::Item {
                    namespace: "ns1".into(),
                    id: "isolated".into(),
                },
                &empty_req,
            )
            .await;
        assert_eq!(iso.status, "resolved");

        let over = resolver
            .resolve(
                CatalogHydrationIdentifier::Item {
                    namespace: "ns1".into(),
                    id: "oversized".into(),
                },
                &empty_req,
            )
            .await;
        assert_eq!(over.status, "error");

        let invalid =
            doc! {"namespace":"ns","id":"invalid","title":"Title","tags":vec![Bson::Null; 100_001]};
        assert!(project_mongo_graph([invalid], [], [], [], &node_collator()).is_err());

        // 6. Error status
        *resolver.source.reads_until_failure.lock().unwrap() = Some(1);
        let err_res = resolver.resolve(item_id, &empty_req).await;
        assert_eq!(err_res.status, "error");
        assert_eq!(
            err_res.error.unwrap().code,
            "CATALOG_ROOT_RESOLUTION_FAILED"
        );
    }

    #[tokio::test]
    async fn indexes_and_search_mappings_parity() {
        let source = MockMongoSource::default();
        ensure_catalog_hydration_indexes(&source).await.unwrap();
        assert_eq!(source.created_indexes.lock().unwrap().len(), 5);

        source.created_indexes.lock().unwrap().clear();
        source
            .fail_index_names
            .lock()
            .unwrap()
            .insert("v1_offer_id".into());
        let flag = AtomicBool::new(false);
        let first = ensure_v1_indexes_with_guard(&source, &flag, false).await;
        assert_eq!(first.created, V1_INDEX_PLAN.len() - 1);
        assert_eq!(first.failed, 1);

        // Guard skips without force
        let skipped = ensure_v1_indexes_with_guard(&source, &flag, false).await;
        assert_eq!(skipped.created, 0);
        assert_eq!(skipped.failed, 0);

        // Force re-runs
        let forced = ensure_v1_indexes(&source, true).await;
        assert_eq!(forced.created + forced.failed, V1_INDEX_PLAN.len());

        // Search mappings
        let os = MockOpenSearchMappings::default();
        {
            let mut map = os.mappings.lock().unwrap();
            map.insert(
                "egdata.offers".into(),
                Some(serde_json::json!({
                    "properties": {
                        "id": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
                        "title": { "type": "keyword" }
                    }
                })),
            );
            map.insert(
                "egdata.items".into(),
                Some(serde_json::json!({
                    "properties": {
                        "id": { "type": "text", "fields": { "keyword": { "type": "keyword" } } }
                    }
                })),
            );
            map.insert("egdata.changelog".into(), Some(Value::Null));
        }

        let dry = ensure_v1_search_mappings(&os, false).await.unwrap();
        assert_eq!(dry.len(), 3);
        assert!(
            !dry[0]
                .missing
                .iter()
                .any(|field| field.starts_with("id.keyword"))
        );
        assert_eq!(dry[2].missing, vec!["* (index does not exist)"]);
        assert!(
            dry[0]
                .incompatible
                .contains(&"title (found keyword)".to_string())
        );
        assert!(os.applied_puts.lock().unwrap().is_empty());

        let applied = ensure_v1_search_mappings(&os, true).await.unwrap();
        assert!(applied[0].applied.contains(&"description".to_string()));
        assert!(applied[0].applied.contains(&"releaseDate".to_string()));
        assert!(
            applied[0]
                .applied
                .contains(&"freeEntries.endDate".to_string())
        );
        assert!(
            applied[0]
                .incompatible
                .iter()
                .any(|s| s.contains("requires an explicit keyword subfield mapping"))
        );
        assert!(!os.applied_puts.lock().unwrap().is_empty());

        // Also cover direct-parent-is-text rejection
        os.mappings.lock().unwrap().insert(
            "egdata.offers".into(),
            Some(serde_json::json!({ "properties": { "freeEntries": { "type": "text" } } })),
        );
        let text_parent = ensure_v1_search_mappings(&os, true).await.unwrap();
        assert!(
            text_parent[0]
                .incompatible
                .iter()
                .any(|s| s.contains("cannot add a subfield to an existing text field"))
        );
    }

    #[tokio::test]
    async fn live_mongo_source_handles_unreachable_db() {
        let opts = mongodb::options::ClientOptions::parse(
            "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=10",
        )
        .await
        .unwrap();
        let client = mongodb::Client::with_options(opts).unwrap();
        let db = client.database("egdata");
        let live = MongoDatabaseSource::new(db);
        assert!(live.find_one("items", doc! {}).await.is_err());
        assert!(live.find_limited("items", doc! {}, 1).await.is_err());
        assert!(
            live.create_index("items", doc! { "id": 1 }, "idx", true)
                .await
                .is_err()
        );
    }
}
