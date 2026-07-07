import { describe, expect, it } from "vitest";
import {
  isEpicGraphQlCloudflareChallenge,
  summarizeEpicGraphQlError,
} from "../src/clients/epic.js";

describe("Epic GraphQL error handling", () => {
  it("detects Cloudflare challenge responses without exposing the HTML body", () => {
    const error = {
      response: {
        status: 403,
        headers: new Headers({
          "cf-mitigated": "challenge",
          "cf-ray": "a1607a8a4ee52a6d-CDG",
          "content-type": "text/html; charset=UTF-8",
          server: "cloudflare",
        }),
        body: '<html><div class="cf_challenge_container">challenge</div></html>',
      },
    };

    expect(isEpicGraphQlCloudflareChallenge(error)).toBe(true);
    expect(summarizeEpicGraphQlError("playerProfile", error)).toEqual({
      status: 403,
      cfMitigated: "challenge",
      cfRay: "a1607a8a4ee52a6d-CDG",
      contentType: "text/html; charset=UTF-8",
      cloudflareChallenge: true,
      message:
        "Epic GraphQL playerProfile was blocked by a Cloudflare challenge.",
    });
  });

  it("does not classify regular GraphQL errors as Cloudflare challenges", () => {
    const error = {
      response: {
        status: 400,
        headers: new Headers({
          "content-type": "application/json",
        }),
        errors: [{ message: "Bad request" }],
      },
    };

    expect(isEpicGraphQlCloudflareChallenge(error)).toBe(false);
    expect(summarizeEpicGraphQlError("playerProfile", error)).toMatchObject({
      status: 400,
      contentType: "application/json",
      cloudflareChallenge: false,
      message: "Epic GraphQL playerProfile failed.",
    });
  });
});
