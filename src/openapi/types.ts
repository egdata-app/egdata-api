import type { OpenAPIV3 } from "openapi-types";

export type Visibility = "public" | "internal" | "private" | "diagnostic";

export type EgdataOperation = OpenAPIV3.OperationObject & {
  "x-egdata-visibility": Visibility;
};

export type EgdataPathItem = OpenAPIV3.PathItemObject & {
  get?: EgdataOperation;
  post?: EgdataOperation;
  put?: EgdataOperation;
  patch?: EgdataOperation;
  delete?: EgdataOperation;
  options?: EgdataOperation;
};

export type EgdataPaths = Record<string, EgdataPathItem>;

export type Method =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";

