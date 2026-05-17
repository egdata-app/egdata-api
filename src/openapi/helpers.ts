import type { OpenAPIV3 } from "openapi-types";
import { jsonContent } from "./components.js";
import type { EgdataOperation, Visibility } from "./types.js";

type OperationInput = Omit<EgdataOperation, "responses" | "x-egdata-visibility"> & {
  visibility?: Visibility;
  response:
    | OpenAPIV3.ReferenceObject
    | OpenAPIV3.SchemaObject
    | Record<number, OpenAPIV3.ResponseObject>;
};

const defaultErrors: OpenAPIV3.ResponsesObject = {
  "400": {
    description: "Invalid request.",
    content: {
      "application/json": jsonContent({
        $ref: "#/components/schemas/ErrorResponse",
      }),
    },
  },
  "404": {
    description: "The requested resource was not found.",
    content: {
      "application/json": jsonContent({
        $ref: "#/components/schemas/ErrorResponse",
      }),
    },
  },
  "500": {
    description: "Unexpected server error.",
    content: {
      "application/json": jsonContent({
        $ref: "#/components/schemas/ErrorResponse",
      }),
    },
  },
};

export const ref = (name: string): OpenAPIV3.ReferenceObject => ({
  $ref: `#/components/schemas/${name}`,
});

export const parameterRef = (name: string): OpenAPIV3.ReferenceObject => ({
  $ref: `#/components/parameters/${name}`,
});

export const ok = (
  description: string,
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
): Record<number, OpenAPIV3.ResponseObject> => ({
  200: {
    description,
    content: {
      "application/json": jsonContent(schema),
    },
  },
});

export const operation = ({
  visibility = "public",
  response,
  ...input
}: OperationInput): EgdataOperation => {
  const responses =
    "200" in response
      ? (response as OpenAPIV3.ResponsesObject)
      : ok("Successful response.", response);

  return {
    ...input,
    "x-egdata-visibility": visibility,
    responses: {
      ...responses,
      ...defaultErrors,
    },
  };
};

export const arrayOf = (
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject,
): OpenAPIV3.SchemaObject => ({
  type: "array",
  items: schema,
});

export const stringQuery = (
  name: string,
  description: string,
  example?: string,
): OpenAPIV3.ParameterObject => ({
  name,
  in: "query",
  required: false,
  description,
  schema: {
    type: "string",
    ...(example ? { example } : {}),
  },
});

