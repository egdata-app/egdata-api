//! Request debug logger middleware (`src/middlewares/request-logger.ts`).

use std::time::Instant;

use axum::{body::Body, extract::Request, http::HeaderMap, middleware::Next, response::Response};

/// Cloudflare geolocation headers extracted from incoming requests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloudflareLocation {
    pub country: Option<String>,
    pub continent: Option<String>,
    pub region: Option<String>,
    pub region_code: Option<String>,
    pub city: Option<String>,
    pub postal_code: Option<String>,
    pub metro_code: Option<String>,
    pub timezone: Option<String>,
    pub latitude: Option<String>,
    pub longitude: Option<String>,
}

impl CloudflareLocation {
    /// Extracts Cloudflare geolocation headers from `headers`.
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let h = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        Self {
            country: h("CF-IPCountry"),
            continent: h("CF-IPContinent"),
            region: h("CF-Region"),
            region_code: h("CF-Region-Code"),
            city: h("CF-IPCity"),
            postal_code: h("CF-Postal-Code"),
            metro_code: h("CF-Metro-Code"),
            timezone: h("CF-Timezone"),
            latitude: h("CF-IPLatitude"),
            longitude: h("CF-IPLongitude"),
        }
    }
}

/// Axum middleware emitting `tracing::debug!` telemetry with request & `CF-*` location fields.
pub async fn request_debug_logger(req: Request<Body>, next: Next) -> Response {
    if !tracing::enabled!(tracing::Level::DEBUG) {
        return next.run(req).await;
    }

    let method = req.method().to_string();
    let pathname = req.uri().path().to_string();
    let location = CloudflareLocation::from_headers(req.headers());
    let start = Instant::now();

    let resp = next.run(req).await;
    let duration_ms = ((start.elapsed().as_secs_f64() * 1000.0) * 100.0).round() / 100.0;

    tracing::debug!(
        method = %method,
        pathname = %pathname,
        status = resp.status().as_u16(),
        durationMs = duration_ms,
        country = ?location.country,
        continent = ?location.continent,
        region = ?location.region,
        regionCode = ?location.region_code,
        city = ?location.city,
        postalCode = ?location.postal_code,
        metroCode = ?location.metro_code,
        timezone = ?location.timezone,
        latitude = ?location.latitude,
        longitude = ?location.longitude,
        "Request"
    );

    resp
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, middleware, routing::get};
    use tower::ServiceExt;
    use tracing_subscriber::layer::SubscriberExt;

    #[test]
    fn extracts_cloudflare_location_headers() {
        let mut headers = HeaderMap::new();
        headers.insert("CF-IPCountry", "US".parse().unwrap());
        headers.insert("CF-IPCity", "Austin".parse().unwrap());
        headers.insert("CF-Timezone", "America/Chicago".parse().unwrap());
        let loc = CloudflareLocation::from_headers(&headers);
        assert_eq!(loc.country.as_deref(), Some("US"));
        assert_eq!(loc.city.as_deref(), Some("Austin"));
        assert_eq!(loc.timezone.as_deref(), Some("America/Chicago"));
        assert_eq!(loc.continent, None);
    }

    #[tokio::test]
    async fn logs_when_debug_enabled_and_skips_when_disabled() {
        let app = Router::new()
            .route("/offers", get(|| async { "ok" }))
            .layer(middleware::from_fn(request_debug_logger));

        // Disabled debug level branch
        let warn_sub =
            tracing_subscriber::registry().with(tracing_subscriber::filter::LevelFilter::WARN);
        let _guard_warn = tracing::subscriber::set_default(warn_sub);
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/offers")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        drop(_guard_warn);

        // Enabled debug level branch
        let debug_sub =
            tracing_subscriber::registry().with(tracing_subscriber::filter::LevelFilter::DEBUG);
        let _guard_debug = tracing::subscriber::set_default(debug_sub);
        let resp2 = app
            .oneshot(
                Request::builder()
                    .uri("/offers?page=1")
                    .header("CF-IPCountry", "DE")
                    .header("CF-IPLatitude", "52.52")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp2.status(), axum::http::StatusCode::OK);
    }
}
