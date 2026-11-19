import { describe, expect, it } from "vitest";
import { serializeOffer, serializeValue } from "../src/v1/serialization.js";

describe("v1 offer serialization expiryDate", () => {
  it("serializes expiryDate as an ISO string when present and null when omitted", () => {
    const withDate = serializeOffer({
      id: "offer-1",
      namespace: "ns-1",
      title: "Offer 1",
      offerType: "BASE_GAME",
      expiryDate: new Date("2026-12-31T23:59:59.000Z"),
    });
    expect(withDate.expiryDate).toBe("2026-12-31T23:59:59.000Z");

    const withIsoString = serializeOffer({
      id: "offer-2",
      namespace: "ns-1",
      title: "Offer 2",
      offerType: "BASE_GAME",
      expiryDate: "2027-01-15T10:30:00Z",
    });
    expect(withIsoString.expiryDate).toBe("2027-01-15T10:30:00.000Z");

    const withoutDate = serializeOffer({
      id: "offer-3",
      namespace: "ns-1",
      title: "Offer 3",
      offerType: "BASE_GAME",
    });
    expect(withoutDate.expiryDate).toBeNull();
  });

  it("normalizes expiryDate inside arbitrary serialized values", () => {
    const serialized = serializeValue({
      expiryDate: new Date("2026-06-01T00:00:00Z"),
    }) as Record<string, unknown>;
    expect(serialized.expiryDate).toBe("2026-06-01T00:00:00.000Z");
  });
});
