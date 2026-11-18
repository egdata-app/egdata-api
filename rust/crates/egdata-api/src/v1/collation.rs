//! ICU collation corresponding to Node Intl's default sort/variant options.
//! Locale is explicit so moving the origin between hosts does not silently
//! change names ordering. See NODE_ICU_LOCALE in ApiConfig.
use egdata_core::v1::ProblemError;
use icu_collator::{Collator, CollatorBorrowed};

pub(crate) fn for_locale(locale: &str) -> Result<CollatorBorrowed<'static>, ProblemError> {
    let locale = locale
        .parse::<icu_locale_core::Locale>()
        .map_err(|_| super::system::internal_error())?;
    Collator::try_new(locale.into(), Default::default())
        .map_err(|_| super::system::internal_error())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn names_sort_like_node_intl_fixtures() {
        let fixtures: Vec<Value> =
            serde_json::from_str(include_str!("../../tests/fixtures/collation.json")).unwrap();
        for fixture in fixtures {
            let locale = fixture["locale"].as_str().unwrap();
            let collator = for_locale(locale).unwrap();
            let mut names = fixture["input"].as_array().unwrap().clone();
            names.sort_by(|a, b| collator.compare(a.as_str().unwrap(), b.as_str().unwrap()));
            assert_eq!(names, *fixture["sorted"].as_array().unwrap(), "{locale}");
        }
        assert!(for_locale("bad_locale!").is_err());
    }
}
