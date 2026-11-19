use super::{
    Routes,
    catalog::integer,
    common::{Error, Result},
    system::query,
};
use crate::state::AppState;
use axum::{
    body::Body,
    extract::State,
    http::{Uri, header},
    response::Response,
};
use bson::doc;
use egdata_core::{
    ports::MongoFindOptions,
    sitemap::{OFFER_SITEMAP_PAGE_LIMIT, get_offer_sitemap_entries},
};
use egdata_infra::bson_json::{bson_datetime_to_iso_string, bson_doc_to_js_json};

pub(super) fn routes() -> Routes {
    Routes::new("")
        .get("/sitemap.xml", paged)
        .get("/items-sitemap.xml", paged)
        .get("/items/sitemap.xml", paged)
        .get("/promotions-sitemap.xml", promotions)
}
fn xml(body: String, cache: &'static str) -> Response {
    Response::builder()
        .header(header::CONTENT_TYPE, "application/xml")
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{body}"
        )))
        .unwrap()
}
async fn paged(State(s): State<AppState>, uri: Uri) -> Result<Response> {
    let path = uri.path();
    let offer = path == "/sitemap.xml";
    let collection = if offer { "offers" } else { "items" };
    let limit = if offer {
        OFFER_SITEMAP_PAGE_LIMIT as i64
    } else {
        1000
    };
    let body = if let Some(page) = query(&uri, "page").filter(|v| !v.is_empty()) {
        let skip = integer(Some(&page), 1)
            .and_then(|p| p.checked_sub(1))
            .and_then(|p| p.checked_mul(limit))
            .and_then(|p| p.try_into().ok())
            .ok_or(Error::Internal)?;
        let docs = s
            .mongo
            .find_many(
                collection,
                doc! {},
                MongoFindOptions {
                    projection: Some(doc! {"id":1,"lastModifiedDate":1}),
                    sort: Some(doc! {"lastModifiedDate":-1}),
                    limit: Some(limit),
                    skip: Some(skip),
                    ..Default::default()
                },
            )
            .await?;
        let mut entries = Vec::new();
        for row in &docs {
            let date = bson_datetime_to_iso_string(
                *row.get_datetime("lastModifiedDate")
                    .map_err(|_| Error::Internal)?,
            )
            .ok_or(Error::Internal)?;
            let id = row.get_str("id").unwrap_or("undefined");
            if offer {
                for entry in get_offer_sitemap_entries(id) {
                    let links = entry
                        .alternates
                        .iter()
                        .map(|a| {
                            format!(
                                "<xhtml:link rel=\"alternate\" hreflang=\"{}\" href=\"{}\" />",
                                a.hreflang, a.href
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n        ");
                    entries.push(format!("\n      <url>\n        <loc>{}</loc>\n        {links}\n        <lastmod>{date}</lastmod>\n      </url>\n      ",entry.loc));
                }
            } else {
                entries.push(format!("<url>\n        <loc>https://egdata.app/items/{id}</loc>\n        <lastmod>{date}</lastmod>\n      </url>\n      \n      "));
            }
        }
        let xmlns = if offer {
            " xmlns:xhtml=\"http://www.w3.org/1999/xhtml\""
        } else {
            ""
        };
        format!(
            "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"{xmlns}>\n  {}\n</urlset>",
            entries.join("\n")
        )
    } else {
        let count = s.mongo.count_documents(collection, doc! {}).await?;
        let entries = (1..=count.div_ceil(limit as u64))
            .map(|p| format!("<sitemap><loc>https://api.egdata.app{path}?page={p}</loc></sitemap>"))
            .collect::<String>();
        format!(
            "<sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n  {entries}\n</sitemapindex>"
        )
    };
    Ok(xml(
        body,
        "public, max-age=86400, stale-while-revalidate=604800",
    ))
}
async fn promotions(State(s): State<AppState>) -> Result<Response> {
    let mut body = String::from("  <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">");
    let mut skip = 0;
    loop {
        let tags = s
            .mongo
            .find_many(
                "tags",
                doc! {"groupName":"event","referenceCount":{"$gt":0}},
                MongoFindOptions {
                    limit: Some(1000),
                    skip: Some(skip),
                    sort: Some(doc! {"updated":-1}),
                    ..Default::default()
                },
            )
            .await?;
        for tag in &tags {
            let tag = bson_doc_to_js_json(tag);
            let id = tag
                .get("id")
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| v.to_string())
                })
                .unwrap_or_else(|| "undefined".into());
            body.push_str(&format!("\n        <url>\n          <loc>https://egdata.app/promotions/{id}</loc>\n        </url>"));
        }
        if tags.len() != 1000 {
            break;
        }
        skip += 1000;
    }
    body.push_str("</urlset>");
    Ok(xml(body, "max-age=86400, stale-while-revalidate=604800"))
}
