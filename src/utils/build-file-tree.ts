/**
 * Converts a client-supplied directory path into the canonical manifest form.
 * Manifest paths use forward slashes and are always relative to the build root.
 */
export function normalizeBuildTreePath(
  path: string | undefined,
): string | null {
  if (path === undefined || path === "" || path === "/") return "";
  if (
    path.length > 500 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.includes("\0")
  ) {
    return null;
  }

  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  if (
    !normalized ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }

  return normalized;
}
