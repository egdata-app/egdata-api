import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OpenAPIV3 } from "openapi-types";

export type MountedRoute = { method: string; path: string; file: string };
type Operation = {
  method: "GET" | "POST";
  operationId: string;
  path: string;
  scope: string;
  expensivePolicy?: "offers-list" | "search" | "heavy" | "bulk";
  paginated?: boolean;
  parameters?: Array<{ name: string }>;
  legacy?: string[];
};
type Manifest = {
  legacyDocument: OpenAPIV3.Document;
  v1Document: OpenAPIV3.Document;
  legacyRoutes: MountedRoute[];
  v1Routes: MountedRoute[];
  v1Operations: Operation[];
  v1Coverage: { missingHandlers: string[]; undocumentedHandlers: string[] };
};
let manifest: Manifest | undefined;
export function rustContracts(): Manifest {
  return (manifest ??= JSON.parse(
    execFileSync(
      "cargo",
      [
        "run",
        "--locked",
        "--quiet",
        "-p",
        "egdata-api",
        "--bin",
        "generate-openapi",
        "--",
        "--tooling-manifest",
      ],
      {
        cwd: fileURLToPath(new URL("../rust/", import.meta.url)),
        encoding: "utf8",
        maxBuffer: 24 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
      },
    ),
  ));
}
export function registrationJson(): string {
  const { legacyRoutes, v1Routes } = rustContracts();
  return JSON.stringify({ legacyRoutes, v1Routes }, null, 2) + "\n";
}
