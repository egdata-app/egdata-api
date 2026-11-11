import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export type ProblemIssue = {
  pointer?: string;
  parameter?: string;
  code: string;
  message: string;
};

export type ProblemDetail = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  code: string;
  requestId?: string;
  errors?: ProblemIssue[];
};

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export const problemType = (code: string) =>
  `https://api.egdata.app/problems/${code.toLowerCase().replaceAll("_", "-")}`;

export class ProblemError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly errors?: ProblemIssue[];
  readonly headers?: Record<string, string>;

  constructor(options: {
    status: ContentfulStatusCode;
    code: string;
    detail: string;
    title?: string;
    errors?: ProblemIssue[];
    headers?: Record<string, string>;
  }) {
    super(options.detail);
    this.name = "ProblemError";
    this.status = options.status;
    this.code = options.code;
    this.title = options.title ?? TITLES[options.status] ?? "Error";
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers;
  }
}

export const badRequest = (
  code: string,
  detail: string,
  errors?: ProblemIssue[],
) => new ProblemError({ status: 400, code, detail, errors });

export const notFound = (code: string, detail: string) =>
  new ProblemError({ status: 404, code, detail });

export const unsupportedMediaType = (detail: string) =>
  new ProblemError({
    status: 415,
    code: "UNSUPPORTED_MEDIA_TYPE",
    detail,
  });

export const serviceUnavailable = (code: string, detail: string) =>
  new ProblemError({ status: 503, code, detail });

export function problemResponse(
  c: Context,
  error: ProblemError,
  requestId = c.get("requestId") as string | undefined,
): Response {
  const body: ProblemDetail = {
    type: problemType(error.code),
    title: error.title,
    status: error.status,
    detail: error.detail,
    instance: c.req.path,
    code: error.code,
    ...(requestId ? { requestId } : {}),
    ...(error.errors?.length ? { errors: error.errors } : {}),
  };

  const headers = new Headers(error.headers);
  headers.set("Content-Type", PROBLEM_CONTENT_TYPE);
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  if (requestId) headers.set("X-Request-Id", requestId);

  return new Response(JSON.stringify(body), {
    status: error.status,
    headers,
  });
}

export function issuesToProblemIssues(
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code?: string;
  }>,
): ProblemIssue[] {
  return issues.map((issue) => {
    const parts = issue.path.map(String);
    return {
      parameter: parts[0],
      pointer:
        parts.length > 0
          ? `/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`
          : undefined,
      code: issue.code?.toUpperCase() ?? "INVALID",
      message: issue.message,
    };
  });
}
