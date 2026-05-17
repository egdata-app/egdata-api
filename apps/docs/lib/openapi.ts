import type { OpenAPIOptions } from "fumadocs-openapi/server";
import { createOpenAPI } from "fumadocs-openapi/server";
import openapiDocument from "../../../openapi/egdata.openapi.json";

export { openapiDocument };

const input: NonNullable<OpenAPIOptions["input"]> = () => ({
  "egdata.openapi.json": openapiDocument as never,
});

export const openapi = createOpenAPI({
  input,
});
