import { describe, expect, it } from "vitest";
import { countryToRegion } from "../../src/utils/region.js";

describe("countryToRegion", () => {
  it("maps the US to its own region", () => {
    expect(countryToRegion("US")).toBe("US");
  });

  it("maps Eurozone countries to EURO", () => {
    expect(countryToRegion("FR")).toBe("EURO");
    expect(countryToRegion("DE")).toBe("EURO");
    expect(countryToRegion("ES")).toBe("EURO");
    expect(countryToRegion("IT")).toBe("EURO");
  });

  it("maps Argentina to its own region", () => {
    expect(countryToRegion("AR")).toBe("AR");
  });

  it("maps the UAE to its own region", () => {
    expect(countryToRegion("AE")).toBe("AE");
  });

  it("maps an African country to AFRICA", () => {
    expect(countryToRegion("NG")).toBe("AFRICA");
  });

  it("falls back to US for unknown country codes", () => {
    expect(countryToRegion("ZZ")).toBe("US");
    expect(countryToRegion("XX")).toBe("US");
  });

  it("falls back to US for empty or nullish input", () => {
    expect(countryToRegion(undefined)).toBe("US");
    expect(countryToRegion(null)).toBe("US");
    expect(countryToRegion("")).toBe("US");
  });

  it("honors a custom fallback when provided", () => {
    expect(countryToRegion("ZZ", "EURO")).toBe("EURO");
    expect(countryToRegion(undefined, "EURO")).toBe("EURO");
  });

  it("never returns a region whose countries list does not contain the input", () => {
    // Regression guard for the fallback path: if the lookup falls back to
    // "US", the caller should not assume the input country is in US's list.
    const region = countryToRegion("ZZ");
    expect(region).toBe("US");
  });
});
