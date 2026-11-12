export type DocKind = "guide" | "problem" | "issue" | "stream" | "index";

export type DocCategory =
  | "Start here"
  | "Find data"
  | "Request essentials"
  | "Track changes"
  | "Advanced"
  | "Errors"
  | "Credentials"
  | "Permissions"
  | "Request validation"
  | "Pagination"
  | "Resource lookup"
  | "Payload and protocol"
  | "Quota and service"
  | "Stream results"
  | "Field issues";

export type DocEntry = {
  slug: string;
  kind: DocKind;
  title: string;
  description: string;
  category: DocCategory;
  order?: number;
  /** Stable problem code, for example `INVALID_API_KEY`. */
  code?: string;
  /** HTTP status returned with the problem. */
  status?: number;
  /** What the error means and when it is returned. */
  summary?: string;
  /** Concrete recovery steps for API clients. */
  fix?: string;
  /** Slugs of related documentation pages. */
  related?: string[];
  /** Operation IDs that commonly return this problem. */
  operations?: string[];
};

export const PROBLEM_TYPE_BASE = "https://api.egdata.app/problems";

export function problemSlug(code: string): string {
  return code.toLowerCase().replaceAll("_", "-");
}

export function problemType(code: string): string {
  return `${PROBLEM_TYPE_BASE}/${problemSlug(code)}`;
}
