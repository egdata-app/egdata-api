type PriceLike = {
  currencyCode?: string;
  discountPrice?: number | null;
  originalPrice?: number | null;
  payoutCurrencyExchangeRate?: number | null;
};

/**
 * Convert a regional-currency price (in minor units / cents) to USD minor units.
 *
 * Uses `payoutCurrencyExchangeRate` from the price record, which the backend stamps with a
 * live FX rate (Frankfurter / open.er-api) at price-save time and refreshes daily on existing
 * rows. Historical rows carry the rate that was live at the moment of that snapshot, so this
 * function gives correct point-in-time USD values when called on a historical record.
 *
 * Returns `null` only when the input is missing or the rate is unusable (USD fallback handles
 * USD-denominated rows, including Argentina/LATAM/AFRICA which Epic prices in USD natively).
 */
export function toUsdCents(price: PriceLike, source: "discount" | "original" = "discount"): number | null {
  if (!price) return null;
  const raw = source === "original" ? price.originalPrice : price.discountPrice;
  if (typeof raw !== "number" || raw < 0) return null;
  if (price.currencyCode === "USD") return Math.round(raw);
  const rate = price.payoutCurrencyExchangeRate;
  if (typeof rate !== "number" || rate <= 0) return null;
  return Math.round(raw * rate);
}
