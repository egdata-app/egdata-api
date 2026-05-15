import { describe, expect, it } from "vitest";
import { toUsdCents } from "../../src/utils/price-usd.js";

describe("toUsdCents", () => {
  it("returns the discount price unchanged for USD", () => {
    expect(
      toUsdCents({
        currencyCode: "USD",
        discountPrice: 1999,
        originalPrice: 2999,
      }),
    ).toBe(1999);
  });

  it("converts non-USD using payoutCurrencyExchangeRate", () => {
    expect(
      toUsdCents({
        currencyCode: "EUR",
        discountPrice: 1000,
        payoutCurrencyExchangeRate: 1.1,
      }),
    ).toBe(1100);
  });

  it("uses originalPrice when source is 'original'", () => {
    expect(
      toUsdCents(
        {
          currencyCode: "USD",
          discountPrice: 500,
          originalPrice: 999,
        },
        "original",
      ),
    ).toBe(999);
  });

  it("returns null when the rate is missing for non-USD", () => {
    expect(toUsdCents({ currencyCode: "EUR", discountPrice: 1000 })).toBeNull();
  });

  it("returns null when the rate is zero or negative", () => {
    expect(
      toUsdCents({
        currencyCode: "EUR",
        discountPrice: 1000,
        payoutCurrencyExchangeRate: 0,
      }),
    ).toBeNull();
  });

  it("returns null when the price value is missing or negative", () => {
    expect(toUsdCents({ currencyCode: "USD" })).toBeNull();
    expect(toUsdCents({ currencyCode: "USD", discountPrice: -1 })).toBeNull();
  });

  it("rounds the result to the nearest integer cent", () => {
    expect(
      toUsdCents({
        currencyCode: "GBP",
        discountPrice: 1234,
        payoutCurrencyExchangeRate: 1.2345,
      }),
    ).toBe(Math.round(1234 * 1.2345));
  });
});
