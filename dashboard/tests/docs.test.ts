import { describe, expect, it } from "vitest";
import {
  allDocs,
  fieldIssueIndexMarkdown,
  findDoc,
  findProblemDoc,
  groupDocs,
  loadDocSource,
  problemIndexMarkdown,
} from "../src/lib/docs/catalog";
import { guideDocs } from "../src/lib/docs/guides";
import { parseFrontmatter, renderMarkdown } from "../src/lib/docs/markdown";
import {
  fieldIssueDocs,
  problemDocs,
  streamResultDocs,
} from "../src/lib/docs/problems";

describe("docs catalog", () => {
  it("uses unique, URL-safe slugs for every page", () => {
    const slugs = allDocs.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(findDoc(slug)).toBeDefined();
    }
  });

  it("resolves common shorthand to the stable problem page", () => {
    expect(findDoc("invalid-key")?.slug).toBe("invalid-api-key");
    expect(findDoc("missing-key")?.slug).toBe("missing-api-key");
  });

  it("aliases graphql-profiles to profiles and excludes anti-abuse", () => {
    expect(findDoc("graphql-profiles")?.slug).toBe("profiles");
    expect(findDoc("anti-abuse")).toBeUndefined();
  });

  it("restricts findProblemDoc to problem, stream, issue, and index slugs", () => {
    expect(findProblemDoc("missing-api-key")?.code).toBe("MISSING_API_KEY");
    expect(findProblemDoc("catalog-root-too-large")?.kind).toBe("stream");
    expect(findProblemDoc("invalid")?.kind).toBe("issue");
    expect(findProblemDoc("problems")?.slug).toBe("problems");
    expect(findProblemDoc("field-issues")?.slug).toBe("field-issues");
    expect(findProblemDoc("get-started")).toBeUndefined();
    expect(findProblemDoc("profiles")).toBeUndefined();
  });

  it("leaves camelCase operation IDs for the API explorer", () => {
    expect(findDoc("getOffer")).toBeUndefined();
    expect(findDoc("listOffers")).toBeUndefined();
  });

  it("derives each problem URL from its stable code", () => {
    for (const entry of problemDocs) {
      const code = entry.code;
      expect(code).toBeTruthy();
      expect(entry.slug).toBe(code?.toLowerCase().replaceAll("_", "-"));
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.summary).toBeTruthy();
      expect(entry.fix).toBeTruthy();
      expect(findDoc(entry.slug)?.code).toBe(entry.code);
    }
  });

  it("keeps every guide attached to a category and a body", async () => {
    for (const entry of guideDocs) {
      expect(entry.category).toBeTruthy();
      const source = await loadDocSource(entry);
      expect(source.markdown.trim().length).toBeGreaterThan(0);
    }
  });

  it("groups documented pages in a deterministic order", () => {
    const groups = groupDocs(allDocs);
    expect(groups.map((group) => group.category)).toEqual([
      "Start here",
      "Find data",
      "Request essentials",
      "Track changes",
      "Advanced",
      "Errors",
      "Credentials",
      "Permissions",
      "Request validation",
      "Pagination",
      "Resource lookup",
      "Payload and protocol",
      "Quota and service",
      "Stream results",
      "Field issues",
    ]);
    expect(
      groups.find((group) => group.category === "Errors")?.entries,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "v1-problems" }),
        expect.objectContaining({ slug: "problems" }),
        expect.objectContaining({ slug: "field-issues" }),
      ]),
    );
  });

  it("gives every generated code page a rendered body", async () => {
    for (const entry of [
      ...problemDocs,
      ...streamResultDocs,
      ...fieldIssueDocs,
    ]) {
      const source = await loadDocSource(entry);
      const rendered = renderMarkdown(source.markdown);
      expect(rendered.html.length).toBeGreaterThan(0);
      expect(rendered.html).not.toContain("\uE000");
    }
  });

  it("links every problem and field issue from the index pages", () => {
    const problems = problemIndexMarkdown();
    for (const entry of problemDocs) {
      expect(problems).toContain(`(/docs/${entry.slug})`);
    }

    for (const entry of streamResultDocs) {
      expect(problems).toContain(`(/docs/${entry.slug})`);
    }

    const issues = fieldIssueIndexMarkdown();
    for (const entry of fieldIssueDocs) {
      expect(issues).toContain(`(/docs/${entry.slug})`);
    }
  });

  it("documents gateway entitlement, quota, and account-status problem codes", () => {
    const expectedCodes = [
      "PLAN_ENTITLEMENT_REQUIRED",
      "PERIOD_QUOTA_EXCEEDED",
      "EXPENSIVE_BUDGET_EXCEEDED",
      "ACCOUNT_STATUS_UNAVAILABLE",
      "EMAIL_VERIFICATION_REQUIRED",
      "AGREEMENT_REQUIRED",
    ];
    const problems = problemIndexMarkdown();
    for (const code of expectedCodes) {
      const entry = problemDocs.find((item) => item.code === code);
      expect(entry, `missing problemDocs entry for ${code}`).toBeDefined();
      expect(problems).toContain(`(/docs/${entry?.slug})`);
      expect(problems).toContain(`[${code}]`);
    }
  });
});

describe("docs markdown", () => {
  it("strips copied frontmatter and renders anchor ids", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "title: Example",
        "description: Demo",
        "---",
        "## Hello `world`",
        "Body.",
        "",
      ].join("\n"),
    );
    expect(parsed.title).toBe("Example");
    expect(parsed.description).toBe("Demo");
    expect(parsed.markdown).toContain("## Hello");

    const rendered = renderMarkdown(parsed.markdown);
    expect(rendered.html).toContain('id="hello-world"');
    expect(rendered.headings).toEqual([
      { id: "hello-world", depth: 2, text: "Hello world" },
    ]);
  });

  it("renders GFM tables and keeps duplicate headings addressable", () => {
    const rendered = renderMarkdown(
      [
        "| A | B |",
        "| --- | --- |",
        "| 1 | 2 |",
        "",
        "## Same",
        "",
        "## Same",
        "",
      ].join("\n"),
    );
    expect(rendered.html).toContain("<table>");
    expect(rendered.html).toContain('id="same"');
    expect(rendered.html).toContain('id="same-2"');
  });

  it("renders lists, inline formatting, links, and fenced code safely", () => {
    const rendered = renderMarkdown(
      [
        "- First **bold** item",
        "- Second item with `code` and a [link](/docs/problems)",
        "",
        "1. Ordered",
        "2. Items",
        "",
        "```json",
        '{ "type": "unsafe <tag> & value" }',
        "```",
        "",
      ].join("\n"),
    );

    expect(rendered.html).toContain("<ul>");
    expect(rendered.html).toContain(
      "<li>First <strong>bold</strong> item</li>",
    );
    expect(rendered.html).toContain('<a href="/docs/problems">link</a>');
    expect(rendered.html).toContain("<code>code</code>");
    expect(rendered.html).toContain("<ol>");
    expect(rendered.html).toContain(
      "{ &quot;type&quot;: &quot;unsafe &lt;tag&gt; &amp; value&quot; }",
    );
    expect(rendered.html).not.toContain("<tag>");
  });

  it("renders every guide without throwing and keeps links and URLs on v1", async () => {
    for (const entry of guideDocs) {
      const source = await loadDocSource(entry);
      const parsed = parseFrontmatter(source.markdown);
      const rendered = renderMarkdown(parsed.markdown);
      expect(rendered.html.length).toBeGreaterThan(0);
      expect(rendered.html).not.toContain("\uE000");

      for (const match of parsed.markdown.matchAll(
        /\[[^\]]+\]\(\/docs\/([a-z0-9-]+)(?:#[^)\s]*)?\)/g,
      )) {
        const slug = match[1];
        expect(
          findDoc(slug),
          `broken /docs/${slug} link in ${entry.slug}`,
        ).toBeDefined();
      }

      const legacyUrls = [
        ...parsed.markdown.matchAll(
          /https:\/\/api\.egdata\.app\/(?!v1(?:\/|$|\b)|problems\/|open-api\.json)[^\s"'`)>]+/g,
        ),
      ].map((m) => m[0]);
      expect(legacyUrls, `legacy api.egdata.app URL in ${entry.slug}`).toEqual(
        [],
      );
    }
  });
});
