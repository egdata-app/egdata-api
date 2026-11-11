import ts from "typescript";
import { parse } from "graphql";
import { posix } from "node:path";
import { createHash } from "node:crypto";

export type Snapshot = Map<string, string>;

export type Endpoint = {
  apiVersion: "legacy" | "v1";
  operationId: string;
  method: string;
  path: string;
  sources: string[];
  status: "active" | "removed";
};

export const endpointKey = (e: Pick<Endpoint, "apiVersion" | "operationId">) =>
  `${e.apiVersion}:${e.operationId}`;

export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val)
            .sort()
            .map((key) => [key, val[key]]),
        )
      : val,
  );

export const normalize = (path: string) =>
  ("/" + path.split("/").filter(Boolean).join("/")).replace(
    /:([\w]+)/g,
    "{$1}",
  );

const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
]);

export function resolveLocal(
  files: Snapshot,
  file: string,
  spec: string,
): string | undefined {
  if (!spec.startsWith(".")) return;
  const root = posix.normalize(
    posix.join(posix.dirname(file), spec.replace(/\.js$/, "")),
  );
  return [
    root,
    `${root}.ts`,
    `${root}.tsx`,
    `${root}.json`,
    `${root}/index.ts`,
    `${root}/index.tsx`,
  ].find((f) => files.has(f));
}

export function dependencies(files: Snapshot): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const [file, content] of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const deps = new Set<string>();
    const tree = ts.createSourceFile(
      file,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node: ts.Node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveLocal(files, file, node.moduleSpecifier.text);
        if (target) deps.add(target);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          node.expression.getText(tree) === "require")
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) {
          const target = resolveLocal(files, file, arg.text);
          if (target) deps.add(target);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    graph.set(file, deps);
  }
  return graph;
}

export function closure(
  graph: Map<string, Set<string>>,
  roots: string[],
): Set<string> {
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dep of graph.get(file) ?? []) visit(dep);
  }
  roots.forEach(visit);
  return seen;
}

/** Static discovery avoids executing the API, opening DB connections, or importing handlers. */
export function routeInventory(files: Snapshot): Endpoint[] {
  const found = new Map<string, Endpoint>();
  const seen = new Set<string>();
  const registered = JSON.parse(
    files.get("changes/endpoints.json") ?? "[]",
  ) as Endpoint[];

  function collect(file: string, prefix: string) {
    const key = `${file}|${prefix}`;
    if (seen.has(key) || !files.has(file)) return;
    seen.add(key);
    const tree = ts.createSourceFile(
      file,
      files.get(file)!,
      ts.ScriptTarget.Latest,
      true,
    );

    const imports = new Map<string, string>();
    for (const node of tree.statements) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveLocal(files, file, node.moduleSpecifier.text);
        if (target && node.importClause?.name) {
          imports.set(node.importClause.name.text, target);
        }
        const bindings = node.importClause?.namedBindings;
        if (target && bindings && ts.isNamedImports(bindings)) {
          for (const e of bindings.elements) imports.set(e.name.text, target);
        }
      }
    }

    function add(method: string, path: string) {
      if (path.startsWith("/v1/")) return;
      const id =
        registered.find(
          (e) =>
            e.apiVersion === "legacy" &&
            e.method === method &&
            e.path === path &&
            e.status === "active",
        )?.operationId ??
        `legacy${method[0]}${method.slice(1).toLowerCase()}${path.replace(/[^A-Za-z0-9]+/g, "_") || "Root"}_${hash(`${method} ${path}`).slice(0, 8)}`;
      found.set(`${method} ${path}`, {
        apiVersion: "legacy",
        operationId: id,
        method,
        path,
        sources: [file],
        status: "active",
      });
    }

    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        if (
          !["app", "router"].includes(node.expression.expression.getText(tree))
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        const name = node.expression.name.text;
        const path = node.arguments[0];
        if (path && ts.isStringLiteral(path)) {
          if (methods.has(name)) {
            add(name.toUpperCase(), normalize(`${prefix}/${path.text}`));
          }
          if (name === "route") {
            const mounted = node.arguments[1];
            if (mounted && ts.isIdentifier(mounted)) {
              const target = imports.get(mounted.text);
              if (target && !target.startsWith("src/v1/")) {
                collect(target, normalize(`${prefix}/${path.text}`));
              }
            }
          }
          if (name === "use" && path.text === "/graphql") {
            for (const method of ["GET", "POST"]) add(method, "/graphql");
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(tree);
  }

  collect("src/index.ts", "");

  // Existing classifications distinguish public/non-JSON operations from internal/account routes.
  const classificationSource = files.get("src/openapi/route-inventory.ts");
  if (classificationSource) {
    const tree = ts.createSourceFile(
      "classifications.ts",
      classificationSource,
      ts.ScriptTarget.Latest,
      true,
    );
    const rules: Array<Record<string, string>> = [];

    function visit(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(tree) === "routeClassifications" &&
        node.initializer &&
        ts.isArrayLiteralExpression(node.initializer)
      ) {
        for (const item of node.initializer.elements) {
          if (ts.isObjectLiteralExpression(item)) {
            const rule: Record<string, string> = {};
            for (const prop of item.properties) {
              if (
                ts.isPropertyAssignment(prop) &&
                ts.isStringLiteral(prop.initializer)
              ) {
                rule[prop.name.getText(tree)] = prop.initializer.text;
              }
            }
            rules.push(rule);
          }
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(tree);

    for (const [key, e] of found) {
      const rule = rules.find(
        (rule) =>
          (!rule.method || rule.method === "*" || rule.method === e.method) &&
          new RegExp(
            "^" +
              rule.path
                .split("**")
                .map((part) =>
                  part
                    .split("*")
                    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                    .join("[^/]+"),
                )
                .join(".*") +
              "$",
          ).test(e.path),
      );
      if (rule && ["private", "internal"].includes(rule.visibility)) {
        found.delete(key);
      }
    }
  }

  for (const version of ["legacy", "v1"] as const) {
    const contract = files.get(
      `openapi/egdata${version === "v1" ? ".v1" : ""}.openapi.json`,
    );
    if (!contract) continue;
    const document = JSON.parse(contract);
    for (const [path, rawItem] of Object.entries(document.paths ?? {}) as [
      string,
      Record<string, any>,
    ][]) {
      const item: Record<string, any> = rawItem.$ref
        ? dereference(rawItem, document)
        : rawItem;
      for (const [method, operation] of Object.entries(item)) {
        if (!methods.has(method) || !operation.operationId) continue;
        const old = found.get(`${method.toUpperCase()} ${path}`);
        const sources = old?.sources ?? [];
        if (version === "v1") {
          for (const [file, source] of files) {
            if (
              file.startsWith("src/v1/operations/") &&
              source.includes(`"${operation.operationId}"`)
            ) {
              sources.push(file);
            }
          }
          // Adapters import legacy handlers transitively; retain the exact registry module too.
          sources.push("src/v1/router.ts");
        }
        found.set(`${method.toUpperCase()} ${path}`, {
          apiVersion: version,
          operationId: operation.operationId,
          method: method.toUpperCase(),
          path,
          sources,
          status: "active",
        });
      }
    }
  }
  return [...found.values()].sort((a, b) =>
    endpointKey(a).localeCompare(endpointKey(b)),
  );
}

function dereference(
  value: any,
  document: any,
  stack = new Set<string>(),
): any {
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    if (!value.$ref.startsWith("#/")) {
      throw new Error(
        `External contract reference must be vendored: ${value.$ref}`,
      );
    }
    if (stack.has(value.$ref)) return { $recursiveRef: value.$ref };
    const target = value.$ref
      .slice(2)
      .split("/")
      .reduce(
        (v: any, k: string) => v?.[k.replace(/~1/g, "/").replace(/~0/g, "~")],
        document,
      );
    if (!target) {
      throw new Error(`Unresolved contract reference: ${value.$ref}`);
    }
    return dereference(
      {
        ...target,
        ...Object.fromEntries(
          Object.entries(value).filter(([k]) => k !== "$ref"),
        ),
      },
      document,
      new Set([...stack, value.$ref]),
    );
  }
  if (Array.isArray(value)) {
    return value.map((v) => dereference(v, document, stack));
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([k]) =>
          ![
            "description",
            "summary",
            "example",
            "examples",
            "tags",
            "externalDocs",
          ].includes(k),
      )
      .map(([k, v]) => [k, dereference(v, document, stack)]),
  );
}

export function contractOperations(files: Snapshot): Map<string, string> {
  const result = new Map<string, string>();
  for (const version of ["legacy", "v1"]) {
    const content = files.get(
      `openapi/egdata${version === "v1" ? ".v1" : ""}.openapi.json`,
    );
    if (!content) continue;
    const doc = JSON.parse(content);
    for (const [path, rawItem] of Object.entries(doc.paths ?? {}) as [
      string,
      Record<string, any>,
    ][]) {
      const item: Record<string, any> = rawItem.$ref
        ? dereference(rawItem, doc)
        : rawItem;
      for (const [method, op] of Object.entries(item)) {
        if (!methods.has(method) || !op.operationId) continue;
        const security = op.security ?? doc.security ?? [];
        const securitySchemes = Object.fromEntries(
          [
            ...new Set(
              security.flatMap((requirement: Record<string, unknown>) =>
                Object.keys(requirement),
              ),
            ),
          ].map((name) => [
            String(name),
            doc.components?.securitySchemes?.[String(name)],
          ]),
        );
        result.set(
          `${version}:${op.operationId}`,
          canonical(
            dereference(
              {
                path,
                method,
                ...op,
                parameters: [
                  ...(item.parameters ?? []),
                  ...(op.parameters ?? []),
                ],
                security,
                securitySchemes,
                servers: op.servers ?? item.servers ?? doc.servers ?? [],
              },
              doc,
            ),
          ),
        );
      }
    }
  }
  return result;
}

export function graphqlContract(files: Snapshot): string | undefined {
  const content = files.get("src/graphql/typedefs.ts");
  if (!content) return;
  const tree = ts.createSourceFile(
    "typedefs.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  let sdl: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(tree) === "typeDefs" &&
      node.initializer &&
      ts.isNoSubstitutionTemplateLiteral(node.initializer)
    ) {
      sdl = node.initializer.text;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!sdl) {
    throw new Error(
      "GraphQL schema extraction is unknown; update the inventory parser explicitly",
    );
  }
  return JSON.stringify(parse(sdl, { noLocation: true }), (key, value) =>
    key === "description" ? undefined : value,
  );
}
