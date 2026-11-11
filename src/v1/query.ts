import type { Context } from "hono";
import { z } from "zod";
import { countries, regions } from "../utils/countries.js";
import {
  badRequest,
  issuesToProblemIssues,
  ProblemError,
  unsupportedMediaType,
} from "./errors.js";

export const canonicalCountry = (raw: string | undefined | null): string => {
  const country = (raw ?? "US").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country) || !countries.includes(country)) {
    throw badRequest(
      "INVALID_COUNTRY",
      `Unknown country code '${raw}'. Use an ISO 3166-1 alpha-2 code such as US or GB.`,
    );
  }
  return country;
};

export const regionForCountry = (country: string): string | null =>
  Object.keys(regions).find((key) =>
    (regions[key].countries as string[]).includes(country),
  ) ?? null;

export const countryAndRegion = (
  raw: string | undefined,
): { country: string; region: string } => {
  const country = canonicalCountry(raw);
  const region = regionForCountry(country);
  if (!region) {
    throw badRequest(
      "INVALID_COUNTRY",
      `Country '${country}' is not mapped to an Epic pricing region.`,
    );
  }
  return { country, region };
};

export const canonicalLocale = (raw: string | undefined | null): string => {
  const value = (raw ?? "en-US").trim();
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value)) {
    throw badRequest(
      "INVALID_LOCALE",
      `Invalid locale '${raw}'. Use a BCP 47 tag such as en-US or pt-BR.`,
    );
  }
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical ?? "en-US";
  } catch {
    throw badRequest(
      "INVALID_LOCALE",
      `Invalid locale '${raw}'. Use a BCP 47 tag such as en-US or pt-BR.`,
    );
  }
};

export const querySchema = {
  pagination: {
    limit: z.string().optional(),
    cursor: z.string().optional(),
  },
  regional: {
    country: z.string().optional(),
    locale: z.string().optional(),
  },
} as const;

export function parseStrictQuery<T extends z.ZodRawShape>(
  c: Context,
  shape: T,
): z.output<z.ZodObject<T>> {
  const schema = z.object(shape).strict();
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new ProblemError({
      status: 400,
      code: "INVALID_QUERY",
      detail: "One or more query parameters are invalid or not supported.",
      errors: issuesToProblemIssues(parsed.error.issues),
    });
  }
  return parsed.data as z.output<z.ZodObject<T>>;
}

export function parseBoolean(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw badRequest(
    "INVALID_QUERY",
    `The \`${name}\` parameter must be true or false.`,
    [{ parameter: name, code: "INVALID", message: "Expected a boolean." }],
  );
}

export function parseInteger(
  value: string | undefined,
  name: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^-?\d+$/.test(value.trim())) {
    throw badRequest(
      "INVALID_QUERY",
      `The \`${name}\` parameter must be an integer.`,
      [{ parameter: name, code: "INVALID", message: "Expected an integer." }],
    );
  }
  const parsed = Number(value);
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } =
    options;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(
      "INVALID_QUERY",
      `The \`${name}\` parameter must be between ${min} and ${max}.`,
      [{ parameter: name, code: "INVALID", message: "Out of range." }],
    );
  }
  return parsed;
}

export function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const values = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)).sort() : undefined;
}

export function requireJsonContentType(c: Context): void {
  const contentType = c.req.header("content-type");
  if (!contentType) {
    throw unsupportedMediaType(
      "A JSON request body is required. Send Content-Type: application/json.",
    );
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType?.endsWith("+json")) {
    throw unsupportedMediaType(
      "This endpoint accepts application/json request bodies only.",
    );
  }
}

export async function readJsonBody(c: Context): Promise<unknown> {
  requireJsonContentType(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("MALFORMED_JSON", "The request body is not valid JSON.");
  }
  return body;
}

export function requireIdParam(c: Context, name = "id"): string {
  const value = c.req.param(name)?.trim();
  if (!value) {
    throw badRequest(
      "MISSING_PARAMETER",
      `The \`${name}\` path parameter is required.`,
    );
  }
  if (value.length > 200) {
    throw badRequest(
      "INVALID_PARAMETER",
      `The \`${name}\` path parameter is too long.`,
    );
  }
  return value;
}

export function regionalParams(query: { country?: string; locale?: string }): {
  country: string;
  region: string;
  locale: string;
} {
  const { country, region } = countryAndRegion(query.country);
  return { country, region, locale: canonicalLocale(query.locale) };
}
