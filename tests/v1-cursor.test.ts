import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../src/v1/cursor.js";
import { ProblemError } from "../src/v1/errors.js";

const binding: CursorBinding = {
  operation: "offers.list",
  filters: { tags: ["a", "b"], onSale: true },
  ordering: "lastModifiedDate:desc,id:asc",
  country: "US",
  locale: "en-US",
  limit: 20,
};

const originalSecret = process.env.V1_CURSOR_SECRET;

beforeEach(() => {
  process.env.V1_CURSOR_SECRET = "test-cursor-secret-that-is-at-least-32-chars";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  if (originalSecret === undefined) delete process.env.V1_CURSOR_SECRET;
  else process.env.V1_CURSOR_SECRET = originalSecret;
});

describe("v1 signed cursors", () => {
  it("round-trips a sort tuple bound to the operation context", () => {
    const cursor = encodeCursor(binding, [
      "2026-04-30T00:00:00.000Z",
      "offer-1",
    ]);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, binding)).toEqual([
      "2026-04-30T00:00:00.000Z",
      "offer-1",
    ]);
  });

  it("rejects tampered payloads and signatures", () => {
    const cursor = encodeCursor(binding, ["2026-04-30T00:00:00.000Z", "x"]);
    const [body, signature] = cursor.split(".");
    const tamperedBody = `${body.slice(0, -1)}A`;
    expect(() => decodeCursor(`${tamperedBody}.${signature}`, binding)).toThrow(
      ProblemError,
    );
    expect(() => decodeCursor(`${body}.${signature}x`, binding)).toThrow(
      ProblemError,
    );
    try {
      decodeCursor(`${tamperedBody}.${signature}`, binding);
    } catch (error) {
      expect((error as ProblemError).code).toBe("INVALID_CURSOR");
    }
  });

  it("expires cursors after 24 hours with a specific problem code", () => {
    const cursor = encodeCursor(binding, [
      "2026-04-30T00:00:00.000Z",
      "offer-1",
    ]);
    vi.setSystemTime(new Date("2026-05-02T12:00:01.000Z"));
    try {
      decodeCursor(cursor, binding);
      throw new Error("expected cursor to expire");
    } catch (error) {
      expect(error).toBeInstanceOf(ProblemError);
      expect((error as ProblemError).code).toBe("EXPIRED_CURSOR");
    }
  });

  it("rejects cursors reused with changed filters, ordering, country, locale, or limit", () => {
    const cursor = encodeCursor(binding, [
      "2026-04-30T00:00:00.000Z",
      "offer-1",
    ]);
    const variants: CursorBinding[] = [
      { ...binding, filters: { tags: ["a"], onSale: true } },
      { ...binding, ordering: "lastModifiedDate:asc,id:asc" },
      { ...binding, country: "GB" },
      { ...binding, locale: "pt-BR" },
      { ...binding, limit: 50 },
    ];

    for (const variant of variants) {
      try {
        decodeCursor(cursor, variant);
        throw new Error("expected mismatch");
      } catch (error) {
        expect((error as ProblemError).code).toBe("CURSOR_MISMATCH");
      }
    }
  });

  it("normalizes filter key order before binding", () => {
    const cursor = encodeCursor(
      { ...binding, filters: { onSale: true, tags: ["a", "b"] } },
      ["2026-04-30T00:00:00.000Z", "offer-1"],
    );
    expect(
      decodeCursor(cursor, {
        ...binding,
        filters: { tags: ["a", "b"], onSale: true },
      }),
    ).toEqual(["2026-04-30T00:00:00.000Z", "offer-1"]);
  });
});
