export { guideDocs } from "./entries";

const sources = import.meta.glob("../../content/docs/*.md", {
  query: "?raw",
  import: "default",
}) as Record<string, () => Promise<string>>;

const sourceBySlug = new Map(
  Object.entries(sources).map(([path, load]) => [
    path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
    load,
  ]),
);

export function loadGuideSource(slug: string): Promise<string> | null {
  const load = sourceBySlug.get(slug);
  return load ? load() : null;
}
