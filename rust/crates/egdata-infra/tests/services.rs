//! Disposable service integration tests. Run with node rust/scripts/test-services.mjs.
use base64::{Engine, engine::general_purpose::STANDARD};
use bson::{Bson, Document, doc};
use egdata_core::{
    ports::{MongoAggregateOptions, MongoFindOptions, MongoStorePort},
    v1::{MongoSortField, NullsOrder, SortDirection, mongo_keyset_filter},
};
use egdata_infra::{
    auth_pg::{BetterAuthVerifier, PgSessionRepository},
    port_adapters::MongoStoreAdapter,
    redis_store::{ConnectionManagerBackend, RedisBackend, RedisRateLimitStore},
};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::sync::Arc;

#[tokio::test]
#[ignore = "requires disposable MongoDB"]
async fn mongo_collation_aggregation_and_compound_keyset() {
    let url = std::env::var("EGDATA_TEST_MONGO").expect("disposable MongoDB URI");
    let config = egdata_infra::mongo::MongoConfig {
        url,
        ca_path: std::env::var("EGDATA_TEST_MONGO_CA").unwrap().into(),
        cert_path: std::env::var("EGDATA_TEST_MONGO_CERT").unwrap().into(),
        database_name: "egdata".into(),
    };
    let (client, _) = egdata_infra::mongo::connect_mongo(&config).await.unwrap();
    let name = format!("egdata_fixture_{}", bson::oid::ObjectId::new());
    let db = client.database(&name);
    db.collection::<Document>("offers")
        .insert_many([
            doc! {"id":"a","studio":"Studio","rank":1},
            doc! {"id":"b","studio":"studio","rank":1},
            doc! {"id":"c","studio":"Unknown","rank":2},
        ])
        .await
        .unwrap();
    let store = MongoStoreAdapter::new(db.clone());
    let counts = store
        .aggregate_with_options(
            "offers",
            vec![
                doc! {"$match":{"studio":"STUDIO"}},
                doc! {"$group":{"_id":"$rank","count":{"$sum":1}}},
            ],
            MongoAggregateOptions {
                allow_disk_use: Some(true),
                collation: Some(doc! {"locale":"en","strength":2}),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(counts, vec![doc! {"_id":1,"count":2}]);
    // Both requests race on the same unique identity, so only the inserting writer receives an ID.
    let filter = doc! {"_id":"fixture-owned-token"};
    let update = doc! {"$set":{"label":"fixture"}};
    let (left, right) = tokio::join!(
        store.upsert_one_returning_id("token_upserts", filter.clone(), update.clone()),
        store.upsert_one_returning_id("token_upserts", filter.clone(), update.clone())
    );
    let ids = [left.unwrap(), right.unwrap()];
    assert_eq!(
        ids.iter().flatten().collect::<Vec<_>>(),
        vec![&Bson::String("fixture-owned-token".into())]
    );
    assert_eq!(
        store
            .upsert_one_returning_id("token_upserts", filter.clone(), update)
            .await
            .unwrap(),
        None
    );
    assert!(
        store
            .upsert_one_returning_id("token_upserts", filter, doc! {"$unsupported":{"x":1}})
            .await
            .is_err()
    );
    let sort = [
        MongoSortField::new("rank", SortDirection::Asc, NullsOrder::First),
        MongoSortField::new("id", SortDirection::Asc, NullsOrder::First),
    ];
    let filter = mongo_keyset_filter(&sort, &[Bson::Int32(1), Bson::String("a".into())]).unwrap();
    let page = store
        .find_many(
            "offers",
            filter,
            MongoFindOptions {
                sort: Some(doc! {"rank":1,"id":1}),
                projection: Some(doc! {"id":1,"_id":0}),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(page, vec![doc! {"id":"b"}, doc! {"id":"c"}]);
    assert_eq!(store.count_documents_with_options("offers",doc!{"studio":"studio"}, Some(doc!{
        "collation":{"locale":"en","strength":2}, "skip":1_i64,"limit":1_i64,"maxTimeMS":1000_i64
    })).await.unwrap(), 1);
    db.collection::<Document>("versions")
        .insert_many([doc! {"version":"10"}, doc! {"version":"2"}])
        .await
        .unwrap();
    let first = store
        .find_one_with_options(
            "versions",
            doc! {},
            MongoFindOptions {
                sort: Some(doc! {"version":1}),
                collation: Some(doc! {"locale":"en","numericOrdering":true}),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.get_str("version"), Ok("2"));
    db.drop().await.unwrap();
    client.shutdown().await;
}

#[tokio::test]
#[ignore = "requires disposable Redis"]
async fn redis_increment_script_sets_and_preserves_window() {
    let url = std::env::var("EGDATA_TEST_REDIS").expect("disposable Redis URI");
    let mut manager = redis::Client::open(url)
        .unwrap()
        .get_connection_manager()
        .await
        .unwrap();
    // The window script caps future timestamps against the Redis server clock.
    let (seconds, micros): (i64, i64) = redis::cmd("TIME").query_async(&mut manager).await.unwrap();
    let server_ms = seconds * 1000 + micros / 1000;
    let backend = Arc::new(ConnectionManagerBackend::new(manager));
    let rate =
        RedisRateLimitStore::new(60000, bson::oid::ObjectId::new().to_hex(), backend.clone());
    let key = rate.key("fixture");
    let first = rate.increment("fixture", 0).await;
    let second = rate.increment("fixture", 1).await;
    assert_eq!((first.total_hits, second.total_hits), (1, 2));
    assert_eq!(backend.get(&key).await.unwrap().as_deref(), Some("2"));
    assert!((1..=60000).contains(&backend.pttl(&key).await.unwrap()));
    rate.decrement("fixture", 2).await;
    assert_eq!(backend.get(&key).await.unwrap().as_deref(), Some("1"));
    let abuse = egdata_infra::redis_store::RedisRiskStore::new(backend.clone());
    let event: egdata_core::abuse::AbuseEvent = serde_json::from_value(serde_json::json!({
        "route":"/fixture","at":server_ms,"deep":false,"support":true,"mismatch":0.,
        "resources":[{"route":"/fixture/items","page":3,"limit":4,"cacheHit":true}]
    }))
    .unwrap();
    let window = egdata_core::ports::AbuseRiskStorePort::append(
        &abuse,
        &format!("fixture-{}", bson::oid::ObjectId::new()),
        &event,
    )
    .await
    .unwrap();
    assert_eq!(window.events, vec![event]);
    assert_eq!(backend.del(&key).await.unwrap(), 1);
}

#[tokio::test]
#[ignore = "requires disposable Postgres"]
async fn postgres_signed_better_auth_cookie_observes_session_revocation() {
    let url = std::env::var("EGDATA_TEST_PG").expect("disposable Postgres URI");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await
        .unwrap();
    // The fixture tables only exist on this one pooled connection.
    sqlx::raw_sql(r#"
        CREATE TEMP TABLE "user" (id text, name text, email text, "emailVerified" boolean, image text, "createdAt" timestamptz, "updatedAt" timestamptz);
        CREATE TEMP TABLE "session" (id text, token text, "userId" text, "expiresAt" timestamptz, "createdAt" timestamptz, "updatedAt" timestamptz, "ipAddress" text, "userAgent" text);
        CREATE TEMP TABLE "account" ("userId" text, "accountId" text, "providerId" text);
        INSERT INTO "user" VALUES ('u','Fixture','fixture@example.invalid',true,NULL,now(),now());
        INSERT INTO "session" VALUES ('s','fixture-token','u',now()+interval '5 minutes',now(),now(),NULL,NULL);
        INSERT INTO "account" VALUES ('u','fixture-epic','epic');
    "#).execute(&pool).await.unwrap();
    let secret = "better-auth-disposable-integration-test";
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(b"fixture-token");
    let signed = format!(
        "fixture-token.{}",
        STANDARD.encode(mac.finalize().into_bytes())
    );
    let cookie = format!(
        "__Secure-better-auth.session_token={}",
        url::form_urlencoded::byte_serialize(signed.as_bytes()).collect::<String>()
    );
    let verifier = BetterAuthVerifier::new(secret, PgSessionRepository::new(pool.clone()));
    let session = verifier
        .get_session(Some(&cookie), true)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.user.id, "u");
    assert_eq!(
        verifier
            .linked_epic_account(&session)
            .await
            .unwrap()
            .as_deref(),
        Some("fixture-epic")
    );
    sqlx::query(r#"DELETE FROM "session" WHERE token = 'fixture-token'"#)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        verifier
            .get_session(Some(&cookie), true)
            .await
            .unwrap()
            .is_none()
    );
    pool.close().await;
}
