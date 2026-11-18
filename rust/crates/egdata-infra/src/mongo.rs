//! MongoDB X.509 TLS connection configuration matching `src/db/index.ts`.

use std::path::PathBuf;

use bson::{Document, RawDocumentBuf};
use futures::{Stream, stream};
use mongodb::{
    Client, Database,
    options::{AuthMechanism, ClientOptions, Credential, Tls, TlsOptions},
};
use thiserror::Error;

// Decode the driver's raw BSON tags, including literal documents containing Extended JSON keys.
pub(crate) fn native_document(raw: RawDocumentBuf) -> mongodb::error::Result<Document> {
    Ok(raw.to_document()?)
}

pub(crate) fn native_documents(
    cursor: mongodb::Cursor<Document>,
) -> impl Stream<Item = mongodb::error::Result<Document>> + Send {
    stream::try_unfold(cursor, |mut cursor| async move {
        if !cursor.advance().await? {
            return Ok(None);
        }
        let document = Document::try_from(cursor.current())?;
        Ok(Some((document, cursor)))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MongoConfig {
    pub url: String,
    pub ca_path: PathBuf,
    pub cert_path: PathBuf,
    pub database_name: String,
}

#[derive(Debug, Error)]
pub enum MongoConfigError {
    #[error("{0} is required")]
    MissingEnv(&'static str),
    #[error("failed to parse mongodb options: {0}")]
    InvalidOptions(#[from] mongodb::error::Error),
    #[error("MongoDB connection failed: {0}")]
    Connection(#[source] mongodb::error::Error),
}

impl MongoConfig {
    /// Builds a `MongoConfig` from `MONGO_URL`, `MONGO_CA`, and `MONGO_CERT`, matching `src/db/index.ts`.
    pub fn from_env_lookup<F>(mut get_env: F) -> Result<Self, MongoConfigError>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let url = get_env("MONGO_URL")
            .filter(|v| !v.is_empty())
            .ok_or(MongoConfigError::MissingEnv("MONGO_URL"))?;
        let ca = get_env("MONGO_CA")
            .filter(|v| !v.is_empty())
            .ok_or(MongoConfigError::MissingEnv("MONGO_CA"))?;
        let cert = get_env("MONGO_CERT")
            .filter(|v| !v.is_empty())
            .ok_or(MongoConfigError::MissingEnv("MONGO_CERT"))?;

        Ok(Self {
            url,
            ca_path: PathBuf::from(ca),
            cert_path: PathBuf::from(cert),
            database_name: "egdata".to_string(),
        })
    }

    /// Formats the `mongodb+srv://` connection URI.
    pub fn connection_uri(&self) -> String {
        if self.url.starts_with("mongodb://") || self.url.starts_with("mongodb+srv://") {
            self.url.clone()
        } else {
            format!("mongodb+srv://{}/{}", self.url, self.database_name)
        }
    }

    /// Builds `ClientOptions` with X.509 authentication and TLS CA/cert paths.
    pub async fn client_options(&self) -> Result<ClientOptions, MongoConfigError> {
        let mut options = ClientOptions::parse(self.connection_uri()).await?;
        let tls_opts = TlsOptions::builder()
            .ca_file_path(self.ca_path.clone())
            .cert_key_file_path(self.cert_path.clone())
            .build();
        options.tls = Some(Tls::Enabled(tls_opts));
        options.credential = Some(
            Credential::builder()
                .mechanism(AuthMechanism::MongoDbX509)
                .source("$external".to_string())
                .build(),
        );
        Ok(options)
    }
}

/// Connects to MongoDB using `ClientOptions`.
pub async fn connect_mongo_with_options(
    options: ClientOptions,
    database_name: &str,
) -> Result<(Client, Database), MongoConfigError> {
    let client = Client::with_options(options)?;
    let db = client.database(database_name);
    Ok((client, db))
}

/// Connects to MongoDB using `MongoConfig` and returns the `Client` and `Database`.
pub async fn connect_mongo(config: &MongoConfig) -> Result<(Client, Database), MongoConfigError> {
    let (client, db, _) = connect_mongo_with_read_policy(config).await?;
    Ok((client, db))
}

/// Preserve the parsed driver's retryReads setting for commands with raw BSON replies.
pub async fn connect_mongo_with_read_policy(
    config: &MongoConfig,
) -> Result<(Client, Database, bool), MongoConfigError> {
    let options = config.client_options().await?;
    let retry_reads = options.retry_reads != Some(false);
    let (client, db) = connect_mongo_with_options(options, &config.database_name).await?;
    // Client::with_options is lazy. Match Node's awaited MongoClient.connect()
    // so invalid TLS credentials or an unavailable primary fail during startup.
    db.run_command(bson::doc! { "ping": 1 })
        .await
        .map_err(MongoConfigError::Connection)?;
    Ok((client, db, retry_reads))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn requires_all_mongo_env_vars() {
        let mut map: HashMap<String, String> = HashMap::new();
        assert!(matches!(
            MongoConfig::from_env_lookup(|k| map.get(k).cloned()),
            Err(MongoConfigError::MissingEnv("MONGO_URL"))
        ));

        map.insert("MONGO_URL".into(), "cluster.example.mongodb.net".into());
        assert!(matches!(
            MongoConfig::from_env_lookup(|k| map.get(k).cloned()),
            Err(MongoConfigError::MissingEnv("MONGO_CA"))
        ));

        map.insert("MONGO_CA".into(), "/certs/ca.pem".into());
        assert!(matches!(
            MongoConfig::from_env_lookup(|k| map.get(k).cloned()),
            Err(MongoConfigError::MissingEnv("MONGO_CERT"))
        ));

        map.insert("MONGO_CERT".into(), "/certs/client.pem".into());
        let cfg = MongoConfig::from_env_lookup(|k| map.get(k).cloned()).unwrap();
        assert_eq!(
            cfg.connection_uri(),
            "mongodb+srv://cluster.example.mongodb.net/egdata"
        );
        assert_eq!(cfg.database_name, "egdata");
    }

    #[tokio::test]
    async fn builds_x509_client_options_for_direct_uri() {
        let cfg = MongoConfig {
            url: "mongodb://127.0.0.1:27017/egdata".into(),
            ca_path: PathBuf::from("/tmp/ca.pem"),
            cert_path: PathBuf::from("/tmp/cert.pem"),
            database_name: "egdata".into(),
        };
        assert_eq!(cfg.connection_uri(), "mongodb://127.0.0.1:27017/egdata");
        let opts = cfg.client_options().await.unwrap();
        assert!(matches!(opts.tls, Some(Tls::Enabled(_))));
        assert_eq!(
            opts.credential.as_ref().and_then(|c| c.mechanism.clone()),
            Some(AuthMechanism::MongoDbX509)
        );
        assert_eq!(
            opts.credential.as_ref().and_then(|c| c.source.as_deref()),
            Some("$external")
        );
    }

    #[tokio::test]
    async fn connect_mongo_handles_errors_and_valid_options() {
        let bad_cfg = MongoConfig {
            url: "mongodb://".into(),
            ca_path: PathBuf::from("/tmp/ca.pem"),
            cert_path: PathBuf::from("/tmp/cert.pem"),
            database_name: "egdata".into(),
        };
        assert!(connect_mongo(&bad_cfg).await.is_err());

        let missing_cert_cfg = MongoConfig {
            url: "mongodb://127.0.0.1:27017/egdata".into(),
            ca_path: PathBuf::from("/definitely-missing/ca.pem"),
            cert_path: PathBuf::from("/definitely-missing/cert.pem"),
            database_name: "egdata".into(),
        };
        assert!(connect_mongo(&missing_cert_cfg).await.is_err());

        let plain_opts = ClientOptions::parse("mongodb://127.0.0.1:27017/egdata")
            .await
            .unwrap();
        let (_client, db) = connect_mongo_with_options(plain_opts, "egdata")
            .await
            .unwrap();
        assert_eq!(db.name(), "egdata");
    }
}
