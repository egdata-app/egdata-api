import { describe, expect, it } from "vitest";
import { routeTemplateForPath } from "../src/middlewares/route-template.js";

describe("routeTemplateForPath", () => {
  it("normalizes offer, profile, seller and sandbox ids", () => {
    expect(
      routeTemplateForPath("/offers/014812a6932f45bebfa6313ee17ddac0/og"),
    ).toBe("/offers/{id}/og");
    expect(
      routeTemplateForPath("/profiles/0da6c383e0f34381b6a502768a4e8930/games"),
    ).toBe("/profiles/{id}/games");
    expect(
      routeTemplateForPath("/sellers/o-vtqh9b4lk8n4jpadfv6cphqs9hsly9"),
    ).toBe("/sellers/{sellerId}");
    expect(routeTemplateForPath("/builds/6aec5ed0b2a31cd95cc0fa0e/files")).toBe(
      "/builds/{id}/files",
    );
  });

  it("leaves static route segments untouched", () => {
    expect(routeTemplateForPath("/search/v2/search")).toBe("/search/v2/search");
    expect(routeTemplateForPath("/countries")).toBe("/countries");
  });
});
