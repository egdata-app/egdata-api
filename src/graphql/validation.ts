import type { ApolloServerPlugin, BaseContext } from "@apollo/server";
import type {
  DocumentNode,
  FragmentDefinitionNode,
  OperationDefinitionNode,
} from "graphql";
import {
  type ASTVisitor,
  GraphQLError,
  Kind,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
} from "graphql";

export const DEFAULT_MAX_DEPTH = 12;
export const DEFAULT_MAX_ALIASES = 50;
export const MAX_QUERY_BYTES = 100 * 1024;
export const QUERY_TOO_LARGE_CODE = "QUERY_TOO_LARGE";

const INTROSPECTION_FIELD_NAMES = new Set(["__schema", "__type", "__typename"]);

function resolveLimit(value: number, fallback: number) {
  return Number.isFinite(value) && value >= 1 ? Math.trunc(value) : fallback;
}

function collectFragments(document: DocumentNode) {
  const fragments = new Map<string, FragmentDefinitionNode>();

  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  return fragments;
}

/**
 * Reject operations whose field nesting exceeds `maxDepth`.
 *
 * Fields nested inside fragment spreads and inline fragments are counted at the
 * position where the fragment is used, while introspection fields (`__schema`,
 * `__type`, `__typename`) are ignored entirely.
 */
export function createDepthLimitRule(
  maxDepth: number = DEFAULT_MAX_DEPTH,
): ValidationRule {
  const resolvedMaxDepth = resolveLimit(maxDepth, DEFAULT_MAX_DEPTH);

  return (context: ValidationContext): ASTVisitor => {
    const fragments = collectFragments(context.getDocument());
    const fragmentDepths = new Map<string, number>();

    function measureFragmentDepth(name: string, visiting: Set<string>): number {
      const cached = fragmentDepths.get(name);

      if (cached !== undefined) {
        return cached;
      }

      // Invalid cyclic fragments are reported by other validation rules; avoid
      // recursing forever while still measuring the rest of the document.
      if (visiting.has(name)) {
        return 0;
      }

      const fragment = fragments.get(name);

      if (!fragment) {
        return 0;
      }

      visiting.add(name);
      const depth = measureSelectionSet(fragment.selectionSet, visiting);
      visiting.delete(name);
      fragmentDepths.set(name, depth);

      return depth;
    }

    function measureSelectionSet(
      selectionSet: SelectionSetNode,
      visiting: Set<string>,
    ): number {
      let maxChildDepth = 0;

      for (const selection of selectionSet.selections) {
        if (selection.kind === Kind.FIELD) {
          if (INTROSPECTION_FIELD_NAMES.has(selection.name.value)) {
            continue;
          }

          const childDepth = selection.selectionSet
            ? measureSelectionSet(selection.selectionSet, visiting)
            : 0;
          maxChildDepth = Math.max(maxChildDepth, childDepth + 1);
          continue;
        }

        if (selection.kind === Kind.INLINE_FRAGMENT) {
          maxChildDepth = Math.max(
            maxChildDepth,
            measureSelectionSet(selection.selectionSet, visiting),
          );
          continue;
        }

        if (selection.kind === Kind.FRAGMENT_SPREAD) {
          maxChildDepth = Math.max(
            maxChildDepth,
            measureFragmentDepth(selection.name.value, visiting),
          );
        }
      }

      return maxChildDepth;
    }

    return {
      OperationDefinition(node: OperationDefinitionNode) {
        const depth = measureSelectionSet(node.selectionSet, new Set());

        if (depth > resolvedMaxDepth) {
          context.reportError(
            new GraphQLError(
              `Query depth of ${depth} exceeds the maximum allowed depth of ${resolvedMaxDepth}.`,
              {
                nodes: [node],
                extensions: {
                  code: "QUERY_DEPTH_EXCEEDED",
                  depth,
                  maxDepth: resolvedMaxDepth,
                },
              },
            ),
          );
        }
      },
    };
  };
}

/**
 * Reject documents that contain more than `maxAliases` aliased fields.
 *
 * Fields inside fragment definitions are counted as well, because a fragment
 * can be spread multiple times by an operation.
 */
export function createMaxAliasesRule(
  maxAliases: number = DEFAULT_MAX_ALIASES,
): ValidationRule {
  const resolvedMaxAliases = resolveLimit(maxAliases, DEFAULT_MAX_ALIASES);

  return (context: ValidationContext): ASTVisitor => {
    let aliasCount = 0;
    let reported = false;

    return {
      Field(node) {
        if (!node.alias) {
          return;
        }

        aliasCount += 1;

        if (!reported && aliasCount > resolvedMaxAliases) {
          reported = true;
          context.reportError(
            new GraphQLError(
              `Query contains more than ${resolvedMaxAliases} aliased fields.`,
              {
                nodes: [node],
                extensions: {
                  code: "QUERY_ALIAS_LIMIT_EXCEEDED",
                  aliasCount,
                  maxAliases: resolvedMaxAliases,
                },
              },
            ),
          );
        }
      },
    };
  };
}

export function getQuerySizeError(
  source: string,
  maxBytes: number = MAX_QUERY_BYTES,
): GraphQLError | null {
  const sizeBytes = Buffer.byteLength(source, "utf8");

  if (sizeBytes <= maxBytes) {
    return null;
  }

  return new GraphQLError(
    `Query size of ${sizeBytes} bytes exceeds the maximum allowed size of ${maxBytes} bytes.`,
    {
      extensions: {
        code: QUERY_TOO_LARGE_CODE,
        sizeBytes,
        maxBytes,
        http: { status: 413 },
      },
    },
  );
}

/**
 * Reject requests whose GraphQL source is larger than `maxBytes` (100 KB by
 * default) before parsing, validation, or execution.
 *
 * Apollo Server v5 wraps errors thrown from request lifecycle hooks in a
 * generic "Internal server error" response, so the tagged error is re-thrown
 * from the server level `unexpectedErrorProcessingRequest` hook to preserve
 * the `QUERY_TOO_LARGE` code (and 413 status) for clients.
 */
export function createQuerySizeLimitPlugin<TContext extends BaseContext>(
  maxBytes: number = MAX_QUERY_BYTES,
): ApolloServerPlugin<TContext> {
  const resolvedMaxBytes = resolveLimit(maxBytes, MAX_QUERY_BYTES);

  return {
    async requestDidStart() {
      return {
        async didResolveSource(requestContext) {
          const error = getQuerySizeError(
            requestContext.source,
            resolvedMaxBytes,
          );

          if (error) {
            throw error;
          }
        },
      };
    },
    async unexpectedErrorProcessingRequest({ error }) {
      if (
        error instanceof GraphQLError &&
        error.extensions?.code === QUERY_TOO_LARGE_CODE
      ) {
        throw error;
      }
    },
  };
}

export const graphqlValidationRules: ValidationRule[] = [
  createDepthLimitRule(),
  createMaxAliasesRule(),
];
