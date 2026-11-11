import schema from "../../changes/record.schema.json";
import type { ChangeRecord } from "../../scripts/changelog/core.js";

export type { ChangeRecord };

type Rule = {
  type?: string | string[];
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  format?: string;
  minItems?: number;
  uniqueItems?: boolean;
  items?: Rule;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, Rule>;
};

// Interprets the checked-in schema without eval/new Function (Workers forbid it).
// Only the draft-07 keywords used by our schema are supported; reject unknown keywords.
export function validateChangeRecord(value: unknown): ChangeRecord {
  function check(rule: Rule, value: unknown, path: string) {
    const supported = new Set([
      "$schema",
      "$id",
      "type",
      "additionalProperties",
      "required",
      "properties",
      "enum",
      "pattern",
      "minLength",
      "maxLength",
      "format",
      "minItems",
      "uniqueItems",
      "items",
    ]);
    for (const key of Object.keys(rule)) {
      if (!supported.has(key)) {
        throw new Error(`Unsupported schema keyword: ${key}`);
      }
    }
    const types = Array.isArray(rule.type)
      ? rule.type
      : rule.type
        ? [rule.type]
        : [];
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (types.length && !types.includes(type)) {
      throw new Error(`Invalid ${path}`);
    }
    if (rule.enum && !rule.enum.includes(value)) {
      throw new Error(`Invalid ${path}`);
    }
    if (typeof value === "string") {
      if (
        value.trim().length < (rule.minLength ?? 0) ||
        value.length > (rule.maxLength ?? Infinity) ||
        (rule.pattern && !new RegExp(rule.pattern).test(value)) ||
        value.includes("TODO:")
      ) {
        throw new Error(`Invalid ${path}`);
      }
      if (
        rule.format === "date" &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          new Date(value).toISOString().slice(0, 10) !== value)
      ) {
        throw new Error(`Invalid date ${path}`);
      }
    }
    if (Array.isArray(value)) {
      if (
        value.length < (rule.minItems ?? 0) ||
        (rule.uniqueItems &&
          new Set(value.map((v) => JSON.stringify(v))).size !== value.length)
      ) {
        throw new Error(`Invalid ${path}`);
      }
      for (const v of value) if (rule.items) check(rule.items, v, `${path}[]`);
    } else if (value && typeof value === "object") {
      const fields = value as Record<string, unknown>;
      for (const key of rule.required ?? []) {
        if (!Object.hasOwn(fields, key)) {
          throw new Error(`Missing ${path}.${key}`);
        }
      }
      for (const [key, v] of Object.entries(fields)) {
        if (rule.additionalProperties === false && !rule.properties?.[key]) {
          throw new Error(`Unknown ${path}.${key}`);
        }
        if (rule.properties?.[key]) {
          check(rule.properties[key], v, `${path}.${key}`);
        }
      }
    }
  }
  check(schema, value, "record");
  const record = value as ChangeRecord;
  const seen = new Set<string>();
  for (const e of record.endpoints) {
    const key = `${e.apiVersion}:${e.operationId}`;
    if (seen.has(key)) throw new Error("Duplicate operation");
    seen.add(key);
    if (
      e.compatibility === "breaking" &&
      /^(none|n\/a|no action)[.!]?$/i.test(e.clientAction.trim())
    ) {
      throw new Error("Migration instructions required");
    }
    if (e.path === "/graphql" && !e.schemaFields?.length) {
      throw new Error("GraphQL schema fields required");
    }
    if (e.type === "removed" && !("replacement" in e)) {
      throw new Error("Removal replacement required");
    }
  }
  return record;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val)
            .sort()
            .map((key) => [key, val[key]]),
        )
      : val,
  );
}
