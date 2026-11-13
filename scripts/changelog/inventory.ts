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

const NON_SHARED_INDEX_TARGETS = new Set([
  "src/catalog/resolver.ts",
  "src/graphql/index.ts",
  "src/graphql/loaders.ts",
  "src/graphql/persisted-queries.ts",
  "src/middlewares/apollo.ts",
  "src/openapi/index.ts",
  "src/routes/auth.ts",
]);

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    return (
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((e) => e.isTypeOnly)
    );
  }
  return false;
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    return (
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every((e) => e.isTypeOnly)
    );
  }
  return false;
}

function isTypePosition(node: ts.Node): boolean {
  let curr: ts.Node | undefined = node.parent;
  while (curr) {
    if (ts.isTypeNode(curr) || ts.isImportClause(curr)) return true;
    curr = curr.parent;
  }
  return false;
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
    const bindingTargets = new Map<string, string>();
    const mountedRouteArgs = new Set<ts.Identifier>();
    const nonMountedUsedBindings = new Set<string>();

    function visit(node: ts.Node) {
      if (
        ts.isImportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        if (!isTypeOnlyImport(node)) {
          const target = resolveLocal(files, file, node.moduleSpecifier.text);
          if (target) {
            const clause = node.importClause;
            if (!clause) {
              deps.add(target);
            } else {
              if (clause.name) bindingTargets.set(clause.name.text, target);
              if (clause.namedBindings) {
                if (ts.isNamespaceImport(clause.namedBindings)) {
                  bindingTargets.set(clause.namedBindings.name.text, target);
                } else if (ts.isNamedImports(clause.namedBindings)) {
                  for (const e of clause.namedBindings.elements) {
                    if (!e.isTypeOnly) bindingTargets.set(e.name.text, target);
                  }
                }
              }
            }
          }
        }
        return;
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !isTypeOnlyExport(node)
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
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "route" &&
        node.arguments.length >= 2 &&
        ts.isIdentifier(node.arguments[1])
      ) {
        mountedRouteArgs.add(node.arguments[1]);
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);

    function collectUsages(node: ts.Node) {
      if (ts.isImportDeclaration(node)) return;
      if (
        ts.isIdentifier(node) &&
        !mountedRouteArgs.has(node) &&
        !isTypePosition(node)
      ) {
        const parent = node.parent;
        const isPropertyKey =
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node);
        if (!isPropertyKey && bindingTargets.has(node.text)) {
          nonMountedUsedBindings.add(node.text);
        }
      }
      ts.forEachChild(node, collectUsages);
    }
    collectUsages(tree);

    const mountedBindingNames = new Set(
      [...mountedRouteArgs].map((id) => id.text),
    );
    const bindingsByTarget = new Map<string, string[]>();
    for (const [binding, target] of bindingTargets) {
      const list = bindingsByTarget.get(target) ?? [];
      list.push(binding);
      bindingsByTarget.set(target, list);
    }

    for (const [target, bindings] of bindingsByTarget) {
      const mountedOnly =
        bindings.length > 0 &&
        bindings.every(
          (b) => mountedBindingNames.has(b) && !nonMountedUsedBindings.has(b),
        );
      if (mountedOnly) continue;
      if (file === "src/index.ts" && NON_SHARED_INDEX_TARGETS.has(target)) {
        continue;
      }
      if (
        (file === "src/v1/router.ts" || file === "src/openapi/v1.ts") &&
        target === "src/v1/operations/index.ts"
      ) {
        continue;
      }
      if (
        file === "dashboard/worker/proxy.ts" &&
        target === "dashboard/worker/v1.ts"
      ) {
        continue;
      }
      deps.add(target);
    }
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

/** Returns true when a TypeScript file's emitted JS (without comments or types) changed. */
export function hasRuntimeTsChange(
  file: string,
  before: string | undefined,
  after: string | undefined,
): boolean {
  if (before === undefined || after === undefined) return before !== after;
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ESNext,
    jsx: ts.JsxEmit.Preserve,
    removeComments: true,
  };
  const emit = (source: string) =>
    ts.transpileModule(source, { fileName: file, compilerOptions }).outputText;
  return emit(before) !== emit(after);
}

/** Static discovery avoids executing the API, opening DB connections, or importing handlers. */
export function routeInventory(files: Snapshot): Endpoint[] {
  const found = new Map<string, Endpoint>();
  const registered = JSON.parse(
    files.get("changes/endpoints.json") ?? "[]",
  ) as Endpoint[];

  function scanRoutes(
    startFile: string,
    startPrefix: string,
    routerNames: string[],
    allowV1: boolean,
    onRoute: (method: string, path: string, file: string, sources?: string[]) => void,
  ) {
    const localSeen = new Set<string>();
    function walk(file: string, prefix: string) {
      const key = `${file}|${prefix}`;
      if (localSeen.has(key) || !files.has(file)) return;
      localSeen.add(key);
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
          node.moduleSpecifier &&
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

      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression)
        ) {
          if (
            !routerNames.includes(node.expression.expression.getText(tree))
          ) {
            ts.forEachChild(node, visit);
            return;
          }
          const name = node.expression.name.text;
          const path = node.arguments[0];
          if (path && ts.isStringLiteral(path)) {
            if (methods.has(name)) {
              const fullPath = normalize(`${prefix}/${path.text}`);
              if (allowV1 || !fullPath.startsWith("/v1/")) {
                onRoute(name.toUpperCase(), fullPath, file);
              }
            }
            if (name === "route") {
              const mounted = node.arguments[1];
              if (mounted && ts.isIdentifier(mounted)) {
                const target = imports.get(mounted.text);
                if (target && (allowV1 || !target.startsWith("src/v1/"))) {
                  walk(target, normalize(`${prefix}/${path.text}`));
                }
              }
            }
            if (name === "use" && path.text === "/graphql") {
              const graphqlSources = files.has("src/graphql/index.ts")
                ? [
                    "src/graphql/index.ts",
                    ...(files.has("src/graphql/loaders.ts")
                      ? ["src/graphql/loaders.ts"]
                      : []),
                    ...(files.has("src/middlewares/apollo.ts")
                      ? ["src/middlewares/apollo.ts"]
                      : []),
                  ]
                : [file];
              for (const method of ["GET", "POST"]) {
                onRoute(method, "/graphql", file, graphqlSources);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(tree);
    }

    walk(startFile, startPrefix);
  }

  scanRoutes("src/index.ts", "", ["app", "router"], false, (method, path, file, customSources) => {
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
      sources: customSources ?? [file],
      status: "active",
    });
  });

  const v1HandlerFiles = new Map<string, string>();
  scanRoutes("src/v1/router.ts", "/v1", ["app", "router", "v1"], true, (method, path, file) => {
    v1HandlerFiles.set(`${method} ${path === "/v1/" ? "/v1" : path}`, file);
  });

  const discoveredSources = new Map(
    [...found].map(([k, v]) => [k, v.sources]),
  );

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
        const routeKey = `${method.toUpperCase()} ${path}`;
        const old = found.get(routeKey);
        const sources = [...(old?.sources ?? [])];
        if (version === "legacy" && !sources.length) {
          if (
            path === "/auth/challenge" &&
            files.has("src/services/anti-abuse-runtime.ts")
          ) {
            sources.push("src/services/anti-abuse-runtime.ts");
          } else {
            sources.push(...(discoveredSources.get(routeKey) ?? []));
          }
        }
        if (version === "v1") {
          for (const [file, source] of files) {
            if (
              file.startsWith("src/v1/operations/") &&
              source.includes(`"${operation.operationId}"`)
            ) {
              sources.push(file);
            }
          }
          const handlerFile = v1HandlerFiles.get(routeKey);
          if (handlerFile && !sources.includes(handlerFile)) {
            sources.push(handlerFile);
          } else if (!handlerFile && files.has("src/v1/router.ts")) {
            sources.push("src/v1/router.ts");
          }
        }
        found.set(routeKey, {
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
