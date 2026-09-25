import { regions } from "./countries.js";

export interface PriceAvailability {
  countriesWhitelist?: readonly string[] | null;
  countriesBlacklist?: readonly string[] | null;
}

export function isPriceCountryEligible(
  offer: PriceAvailability,
  country: string,
): boolean {
  const normalized = country.toUpperCase();
  const whitelist =
    offer.countriesWhitelist?.map((value) => value.toUpperCase()) ?? [];
  const blacklist =
    offer.countriesBlacklist?.map((value) => value.toUpperCase()) ?? [];
  return (
    !blacklist.includes(normalized) &&
    (whitelist.length === 0 || whitelist.includes(normalized))
  );
}

export function isPriceRegionEligible(
  offer: PriceAvailability,
  region: string,
): boolean {
  return Boolean(
    regions[region]?.countries.some((country: string) =>
      isPriceCountryEligible(offer, country),
    ),
  );
}

export function priceAvailabilityKey(offer: PriceAvailability): string {
  return JSON.stringify([
    [...(offer.countriesWhitelist ?? [])]
      .map((country) => country.toUpperCase())
      .sort(),
    [...(offer.countriesBlacklist ?? [])]
      .map((country) => country.toUpperCase())
      .sort(),
  ]);
}
