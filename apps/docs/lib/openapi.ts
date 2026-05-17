import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createOpenAPI } from "fumadocs-openapi/server";

const repositoryOpenAPIPath = resolve(
  process.cwd(),
  "../../openapi/egdata.openapi.json",
);
const fallbackOpenAPIPath = resolve(process.cwd(), "openapi/fallback.openapi.json");

export const openapiSpecPath = existsSync(repositoryOpenAPIPath)
  ? repositoryOpenAPIPath
  : fallbackOpenAPIPath;

export const openapi = createOpenAPI({
  input: [openapiSpecPath],
});
