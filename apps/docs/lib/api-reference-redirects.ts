import { openapiDocument } from "@/lib/openapi";

type Operation = {
  operationId?: string;
  tags?: string[];
};

type OpenApiDocument = {
  paths?: Record<
    string,
    Partial<Record<(typeof httpMethods)[number], Operation>>
  >;
};

const httpMethods = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
] as const;

let redirectMap: Map<string, string> | undefined;

function slugifyTag(tag: string): string {
  return tag.replace(/\s+/g, "-").toLowerCase();
}

function routePathToLegacySegments(path: string): string[] {
  return path
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/^\{(.+)\}$/, "$1"));
}

function buildRedirectMap() {
  const document = openapiDocument as OpenApiDocument;
  const redirects = new Map<string, string>();

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of httpMethods) {
      const operation = pathItem[method];

      if (!operation?.operationId) {
        continue;
      }

      const tag = operation.tags?.[0] ?? "unknown";
      const legacyPath = [
        "api-reference",
        ...routePathToLegacySegments(path),
        method,
      ].join("/");
      const taggedPath = [
        "api-reference",
        slugifyTag(tag),
        operation.operationId,
      ].join("/");

      redirects.set(legacyPath, `/docs/${taggedPath}`);
    }
  }

  redirectMap = redirects;
  return redirects;
}

export function getApiReferenceRedirect(slug?: string[]) {
  if (!slug?.length) {
    return;
  }

  const path = slug.join("/");
  return (redirectMap ?? buildRedirectMap()).get(path);
}
