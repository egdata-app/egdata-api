//! Offer hydration classification and logical operation collapsing for anti-abuse scoring.

use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use super::scorer::{AbuseEvent, AbuseResource};

/// Non-paginated offer subroutes eligible for hydration collapsing.
pub const HYDRATION_ROUTES: &[&str] = &[
    "",
    "price",
    "assets",
    "tops",
    "features",
    "reviews",
    "reviews/permissions",
    "polls",
    "has-regular",
    "in-bundle",
    "media",
    "suggestions",
    "regional-price",
    "price-history",
    "hltb",
    "igdb",
    "genres",
    "age-rating",
    "price/fairness",
    "collections/top-new-releases",
    "collections/top-sellers",
    "collections/most-played",
    "collections/top-wishlisted",
    "collections/most-popular",
];

fn offer_hydration_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/offers/([a-f0-9]{32})(?:/(.*))?$").expect("valid regex"))
}

/// Identifies eligible non-paginated offer hydration requests.
pub fn offer_hydration_resource(
    path: &str,
    method: &str,
    query: &[(String, String)],
) -> Option<PartialHydrationResource> {
    if method != "GET" {
        return None;
    }
    let captures = offer_hydration_regex().captures(path)?;
    let offer_id = &captures[1];
    let subroute = captures.get(2).map_or("", |m| m.as_str());
    if !HYDRATION_ROUTES.contains(&subroute) {
        return None;
    }
    let has_pagination = query.iter().any(|(k, v)| {
        matches!(k.as_str(), "offset" | "cursor" | "limit") || (k == "page" && v != "1")
    });
    if has_pagination {
        return None;
    }
    Some(PartialHydrationResource {
        hydration_id: offer_id.to_string(),
        hydration_route: if subroute.is_empty() {
            "offer".to_string()
        } else {
            subroute.to_string()
        },
    })
}

/// Hydration metadata attached to an `AbuseResource`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PartialHydrationResource {
    pub hydration_id: String,
    pub hydration_route: String,
}

impl PartialHydrationResource {
    /// Applies hydration fields onto an existing `AbuseResource`.
    pub fn apply_to(&self, resource: &mut AbuseResource) {
        resource.hydration_id = Some(self.hydration_id.clone());
        resource.hydration_route = Some(self.hydration_route.clone());
    }
}

struct HydrationWindow {
    at: i64,
    routes: HashSet<String>,
}

/// Pure, bounded projection of the 60s event window collapsing typing chains and offer hydration bursts.
pub fn logical_operations(events: &[AbuseEvent]) -> Vec<AbuseEvent> {
    let mut operations: Vec<AbuseEvent> = Vec::with_capacity(events.len());
    let mut hydration: HashMap<String, HydrationWindow> = HashMap::new();
    let mut previous_search: Option<(usize, i64)> = None;

    for event in events {
        let single_resource: Option<AbuseResource> = match event.resources.as_deref() {
            Some(list) if list.len() == 1 => Some(list[0].clone()),
            Some(list) if !list.is_empty() => None,
            _ => Some(event.resource.clone()),
        };

        if let Some(ref res) = single_resource {
            if res.search == Some(true) {
                if let Some((prev_idx, prev_at)) = previous_search
                    && event.at - prev_at < 800
                {
                    operations[prev_idx].resources = Some(vec![res.clone()]);
                    previous_search = Some((prev_idx, event.at));
                    continue;
                }
                let mut op = event.clone();
                op.resources = Some(vec![res.clone()]);
                let idx = operations.len();
                operations.push(op);
                previous_search = Some((idx, event.at));
                continue;
            }

            if let (Some(hid), Some(hroute)) = (&res.hydration_id, &res.hydration_route) {
                if let Some(prev) = hydration.get_mut(hid)
                    && event.at - prev.at < 2000
                {
                    if !prev.routes.contains(hroute) {
                        prev.routes.insert(hroute.clone());
                        continue;
                    }
                } else {
                    let mut routes = HashSet::new();
                    routes.insert(hroute.clone());
                    hydration.insert(
                        hid.clone(),
                        HydrationWindow {
                            at: event.at,
                            routes,
                        },
                    );
                }
            }
        }

        operations.push(event.clone());
    }

    operations
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(at: i64, route: &str) -> AbuseEvent {
        AbuseEvent {
            resource: AbuseResource {
                route: route.to_string(),
                ..Default::default()
            },
            at,
            deep: true,
            support: false,
            resources: None,
            mismatch: 0.0,
            trap: None,
            method: Some("GET".into()),
        }
    }

    #[test]
    fn test_offer_hydration_resource() {
        let id = "0123456789abcdef0123456789abcdef";
        let path_root = format!("/offers/{id}");
        let res = offer_hydration_resource(&path_root, "GET", &[]).unwrap();
        assert_eq!(res.hydration_id, id);
        assert_eq!(res.hydration_route, "offer");

        let mut target = AbuseResource::default();
        res.apply_to(&mut target);
        assert_eq!(target.hydration_id.as_deref(), Some(id));
        assert_eq!(target.hydration_route.as_deref(), Some("offer"));

        let path_price = format!("/offers/{id}/price");
        let res_price =
            offer_hydration_resource(&path_price, "GET", &[("page".into(), "1".into())]).unwrap();
        assert_eq!(res_price.hydration_route, "price");

        assert!(offer_hydration_resource(&path_root, "POST", &[]).is_none());
        assert!(offer_hydration_resource("/offers/short", "GET", &[]).is_none());
        assert!(offer_hydration_resource(&format!("/offers/{id}/unknown"), "GET", &[]).is_none());
        assert!(
            offer_hydration_resource(&path_root, "GET", &[("cursor".into(), "abc".into())])
                .is_none()
        );
        assert!(
            offer_hydration_resource(&path_root, "GET", &[("page".into(), "2".into())]).is_none()
        );
    }

    #[test]
    fn test_logical_operations_collapsing() {
        let mut s1 = ev(1000, "/search/v2/search:aaa");
        s1.resource.search = Some(true);
        let mut s2 = ev(1400, "/search/v2/search:bbb");
        s2.resource.search = Some(true);
        let mut s3 = ev(2500, "/search/v2/search:ccc");
        s3.resource.search = Some(true);

        let mut h1 = ev(3000, "/offers/{id}");
        h1.resource.hydration_id = Some("offer1".into());
        h1.resource.hydration_route = Some("offer".into());

        let mut h2 = ev(3200, "/offers/{id}/price");
        h2.resource.hydration_id = Some("offer1".into());
        h2.resource.hydration_route = Some("price".into());

        // Same hydration subroute within 2s is NOT collapsed
        let mut h3 = ev(3300, "/offers/{id}/price");
        h3.resource.hydration_id = Some("offer1".into());
        h3.resource.hydration_route = Some("price".into());

        // Outside 2s window starts a fresh hydration group
        let mut h4 = ev(6000, "/offers/{id}/assets");
        h4.resource.hydration_id = Some("offer1".into());
        h4.resource.hydration_route = Some("assets".into());

        // Multi-resource GraphQL batch passes through untouched
        let mut batch = ev(7000, "/graphql");
        batch.resources = Some(vec![
            AbuseResource {
                route: "a".into(),
                ..Default::default()
            },
            AbuseResource {
                route: "b".into(),
                ..Default::default()
            },
        ]);

        // Single-element resources vector behaves identically to inline resource
        let mut single_vec_search = ev(8000, "/search/v2/search");
        single_vec_search.resources = Some(vec![AbuseResource {
            route: "/search/v2/search:ddd".into(),
            search: Some(true),
            ..Default::default()
        }]);

        let ops = logical_operations(&[s1, s2, s3, h1, h2, h3, h4, batch, single_vec_search]);
        // s1+s2 collapsed (1), s3 (1), h1 (1), h2 collapsed (0), h3 kept (1), h4 kept (1), batch kept (1), single_vec_search (1) -> 7
        assert_eq!(ops.len(), 7);
        assert_eq!(
            ops[0].resources.as_ref().unwrap()[0].route,
            "/search/v2/search:bbb"
        );
        assert_eq!(
            ops[1].resources.as_ref().unwrap()[0].route,
            "/search/v2/search:ccc"
        );
    }
}
