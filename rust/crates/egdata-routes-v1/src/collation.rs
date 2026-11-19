//! ICU collation corresponding to Node Intl's default sort/variant options.
//! Locale is explicit so moving the origin between hosts does not silently
//! change names ordering. See NODE_ICU_LOCALE in ApiConfig.

pub use egdata_http_core::shared::collation::for_locale;
