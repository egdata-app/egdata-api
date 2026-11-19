//! Shared HTTP building blocks for the versioned (`/v1`) and unversioned API surfaces.
//!
//! This crate owns the middleware stack, the `/v1` request context and the handler
//! helpers both surfaces need. Application state lives in `egdata-api-state`.

pub mod middleware;
pub mod shared;
pub mod v1_helpers;

pub use egdata_api_state::{state, telemetry};
