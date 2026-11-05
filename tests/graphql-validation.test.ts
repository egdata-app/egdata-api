import { ApolloServer } from "@apollo/server";
import {
  buildSchema,
  type GraphQLError,
  parse,
  type ValidationRule,
  validate,
} from "graphql";
import { describe, expect, it } from "vitest";
import {
  clampPage,
  clampPageSize,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  resolvePagination,
} from "../src/graphql/pagination.js";
import {
  createDepthLimitRule,
  createMaxAliasesRule,
  createQuerySizeLimitPlugin,
  DEFAULT_MAX_ALIASES,
  DEFAULT_MAX_DEPTH,
  getQuerySizeError,
  graphqlValidationRules,
  MAX_QUERY_BYTES,
  QUERY_TOO_LARGE_CODE,
} from "../src/graphql/validation.js";

const schema = buildSchema(`
  type Query {
    nested: Query
    value: String
  }
`);

function validateQuery(
  query: string,
  rules: readonly ValidationRule[] = graphqlValidationRules,
) {
  return validate(schema, parse(query), [...rules]);
}

function nestedQuery(depth: number) {
  const levels = Math.max(depth - 1, 0);
  return `{ ${"nested { ".repeat(levels)}value${" }".repeat(levels)} }`;
}

function aliasedQuery(count: number) {
  const fields = Array.from(
    { length: count },
    (_, index) => `alias${index}: value`,
  ).join(" ");

  return `{ ${fields} }`;
}

describe("GraphQL depth limit", () => {
  it("allows normal queries within the default depth limit", () => {
    expect(validateQuery("{ nested { nested { value } } }")).toHaveLength(0);
    expect(validateQuery(nestedQuery(DEFAULT_MAX_DEPTH))).toHaveLength(0);
  });

  it("rejects a 20-level deep query", () => {
    const errors = validateQuery(nestedQuery(20));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("depth");
    expect(errors[0].extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
    expect(errors[0].extensions).toMatchObject({
      depth: 20,
      maxDepth: DEFAULT_MAX_DEPTH,
    });
  });

  it("rejects queries one level beyond the configured limit", () => {
    const errors = validateQuery(nestedQuery(DEFAULT_MAX_DEPTH + 1));

    expect(errors).toHaveLength(1);
    expect(errors[0].extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
  });

  it("counts fields nested inside fragment spreads", () => {
    const deepFragmentBody = nestedQuery(20).slice(2, -2);
    const query = `
      fragment DeepFields on Query {
        ${deepFragmentBody}
      }
      query {
        ...DeepFields
      }
    `;

    const errors = validateQuery(query);

    expect(errors).toHaveLength(1);
    expect(errors[0].extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
  });

  it("counts fields nested inside inline fragments", () => {
    const deepFragmentBody = nestedQuery(20).slice(2, -2);
    const query = `{ ... on Query { ${deepFragmentBody} } }`;

    const errors = validateQuery(query);

    expect(errors).toHaveLength(1);
    expect(errors[0].extensions?.code).toBe("QUERY_DEPTH_EXCEEDED");
  });

  it("ignores introspection fields", () => {
    expect(
      validateQuery("{ __schema { types { name } } }", [
        createDepthLimitRule(1),
      ]),
    ).toHaveLength(0);
    expect(
      validateQuery('{ __type(name: "Query") { fields { name } } }', [
        createDepthLimitRule(1),
      ]),
    ).toHaveLength(0);
    expect(
      validateQuery("{ nested { __typename } }", [createDepthLimitRule(1)]),
    ).toHaveLength(0);
  });

  it("does not recurse forever on cyclic fragments", () => {
    const query = `
      query {
        ...A
      }
      fragment A on Query {
        nested {
          ...B
        }
      }
      fragment B on Query {
        nested {
          ...A
        }
      }
    `;

    expect(() =>
      validateQuery(query, [createDepthLimitRule(DEFAULT_MAX_DEPTH)]),
    ).not.toThrow();
  });
});

describe("GraphQL alias limit", () => {
  it("allows queries at the default alias limit", () => {
    expect(validateQuery(aliasedQuery(DEFAULT_MAX_ALIASES))).toHaveLength(0);
  });

  it("rejects queries above the default alias limit", () => {
    const errors = validateQuery(aliasedQuery(DEFAULT_MAX_ALIASES + 1));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("aliased fields");
    expect(errors[0].extensions?.code).toBe("QUERY_ALIAS_LIMIT_EXCEEDED");
    expect(errors[0].extensions).toMatchObject({
      maxAliases: DEFAULT_MAX_ALIASES,
    });
  });

  it("supports a custom alias limit", () => {
    const rule = [createMaxAliasesRule(2)];

    expect(validateQuery(aliasedQuery(2), rule)).toHaveLength(0);
    expect(validateQuery(aliasedQuery(3), rule)).toHaveLength(1);
  });

  it("counts aliased fields declared inside fragments", () => {
    const query = `
      fragment AliasedFields on Query {
        ${aliasedQuery(DEFAULT_MAX_ALIASES + 1).slice(2, -2)}
      }
      query {
        ...AliasedFields
      }
    `;

    const errors = validateQuery(query);

    expect(errors).toHaveLength(1);
    expect(errors[0].extensions?.code).toBe("QUERY_ALIAS_LIMIT_EXCEEDED");
  });
});

describe("graphqlValidationRules", () => {
  it("includes both the depth and alias rules", () => {
    expect(graphqlValidationRules).toHaveLength(2);
  });

  it("reports depth and alias violations together", () => {
    const fields = Array.from(
      { length: DEFAULT_MAX_ALIASES + 1 },
      (_, index) => `alias${index}: ${nestedQuery(20).slice(2, -2)}`,
    ).join(" ");
    const errors = validateQuery(`{ ${fields} }`);

    expect(
      errors.some((error) => error.extensions?.code === "QUERY_DEPTH_EXCEEDED"),
    ).toBe(true);
    expect(
      errors.some(
        (error) => error.extensions?.code === "QUERY_ALIAS_LIMIT_EXCEEDED",
      ),
    ).toBe(true);
  });
});

describe("clampPageSize", () => {
  it("applies the default fallback when the value is missing", () => {
    expect(clampPageSize(undefined)).toBe(10);
    expect(clampPageSize(null)).toBe(10);
    expect(clampPageSize(Number.NaN)).toBe(10);
    expect(clampPageSize(Number.POSITIVE_INFINITY)).toBe(10);
  });

  it("returns positive integers for valid values", () => {
    expect(clampPageSize(25)).toBe(25);
    expect(clampPageSize(3.9)).toBe(3);
  });

  it("caps values at the maximum page size", () => {
    expect(clampPageSize(2_000)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(10_000)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(200, 15, 24)).toBe(24);
  });

  it("never returns zero or negative values", () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
    expect(clampPageSize(-0.5)).toBe(1);
  });

  it("supports custom fallbacks and maximums", () => {
    expect(clampPageSize(undefined, 15)).toBe(15);
    expect(clampPageSize(undefined, 15, 24)).toBe(15);
    expect(clampPageSize(undefined, 500, 100)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(undefined, 0)).toBe(1);
  });
});

describe("clampPage", () => {
  it("defaults to the first page", () => {
    expect(clampPage(undefined)).toBe(1);
    expect(clampPage(null)).toBe(1);
    expect(clampPage(Number.NaN)).toBe(1);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-3)).toBe(1);
  });

  it("keeps valid pages and caps extremely large pages", () => {
    expect(clampPage(42)).toBe(42);
    expect(clampPage(1_000_000)).toBe(MAX_PAGE);
  });
});

describe("resolvePagination", () => {
  it("resolves limits, pages, and skip values", () => {
    expect(resolvePagination(2_000, 5)).toEqual({
      limit: MAX_PAGE_SIZE,
      page: 5,
      skip: 400,
    });
    expect(resolvePagination(undefined, undefined)).toEqual({
      limit: 10,
      page: 1,
      skip: 0,
    });
    expect(resolvePagination(undefined, 20_000)).toEqual({
      limit: 10,
      page: MAX_PAGE,
      skip: (MAX_PAGE - 1) * 10,
    });
  });
});

describe("query size guard", () => {
  it("accepts queries up to the maximum size", () => {
    expect(getQuerySizeError("x".repeat(MAX_QUERY_BYTES))).toBeNull();
  });

  it("returns a QUERY_TOO_LARGE GraphQLError for oversized sources", () => {
    const error = getQuerySizeError("x".repeat(MAX_QUERY_BYTES + 1));

    expect(error).toBeInstanceOf(Error);
    expect((error as GraphQLError).extensions?.code).toBe(QUERY_TOO_LARGE_CODE);
    expect((error as GraphQLError).message).toContain("maximum allowed size");
  });

  it("counts UTF-8 bytes rather than characters", () => {
    const query = "é".repeat(MAX_QUERY_BYTES);

    expect(getQuerySizeError(query)).not.toBeNull();
  });

  it("rejects oversized queries before executing them", async () => {
    const server = new ApolloServer({
      typeDefs: "type Query { ping: String }",
      resolvers: {
        Query: {
          ping: () => "pong",
        },
      },
      includeStacktraceInErrorResponses: false,
      plugins: [createQuerySizeLimitPlugin()],
    });

    await server.start();

    try {
      const oversizedQuery = `query { ping } # ${"x".repeat(MAX_QUERY_BYTES)}`;

      await expect(
        server.executeOperation({ query: oversizedQuery }),
      ).rejects.toMatchObject({
        extensions: { code: QUERY_TOO_LARGE_CODE },
      });

      const result = await server.executeOperation({ query: "{ ping }" });

      expect(result.body.kind).toBe("single");

      if (result.body.kind === "single") {
        expect(result.body.singleResult.data).toEqual({ ping: "pong" });
      }
    } finally {
      await server.stop();
    }
  });
});
