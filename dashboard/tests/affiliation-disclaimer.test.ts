import { describe, expect, it } from "vitest";
import {
  AFFILIATION_DISCLAIMER_STORAGE_KEY,
  AFFILIATION_DISCLAIMER_VERSION,
  acknowledgeAffiliationDisclaimer,
  hasAcknowledgedAffiliationDisclaimer,
  shouldShowAffiliationDisclaimer,
} from "../src/lib/affiliation-disclaimer";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

describe("affiliation disclaimer persistence", () => {
  it("shows on first open when storage has no acknowledgment", () => {
    const storage = memoryStorage();
    expect(hasAcknowledgedAffiliationDisclaimer(storage)).toBe(false);
    expect(shouldShowAffiliationDisclaimer(storage)).toBe(true);
  });

  it("persists acknowledgment and hides on subsequent visits", () => {
    const storage = memoryStorage();
    acknowledgeAffiliationDisclaimer(storage);

    expect(storage.getItem(AFFILIATION_DISCLAIMER_STORAGE_KEY)).toBe(
      AFFILIATION_DISCLAIMER_VERSION,
    );
    expect(hasAcknowledgedAffiliationDisclaimer(storage)).toBe(true);
    expect(shouldShowAffiliationDisclaimer(storage)).toBe(false);
  });

  it("prompts again when stored version does not match", () => {
    const storage = memoryStorage({
      [AFFILIATION_DISCLAIMER_STORAGE_KEY]: "0",
    });
    expect(hasAcknowledgedAffiliationDisclaimer(storage)).toBe(false);
    expect(shouldShowAffiliationDisclaimer(storage)).toBe(true);
  });

  it("handles unavailable or throwing storage safely", () => {
    const brokenStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };

    expect(hasAcknowledgedAffiliationDisclaimer(brokenStorage)).toBe(false);
    expect(shouldShowAffiliationDisclaimer(brokenStorage)).toBe(true);
    expect(() => acknowledgeAffiliationDisclaimer(brokenStorage)).not.toThrow();
    expect(shouldShowAffiliationDisclaimer(null)).toBe(true);
    expect(shouldShowAffiliationDisclaimer()).toBe(false);
  });
});
