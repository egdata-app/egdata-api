import { createFileRoute } from "@tanstack/react-router";
import { ApiExplorer } from "../components/ApiExplorer";
import { DocsArticle } from "../components/DocsArticle";
import { findDoc } from "../lib/docs/catalog";

export const Route = createFileRoute("/docs/$slug")({
  component: DocsSlugPage,
});

function DocsSlugPage() {
  const { slug } = Route.useParams();

  // Guide and problem slugs are lowercase and hyphenated. OpenAPI operation
  // IDs use camelCase, so a catalog match always wins without ambiguity.
  if (findDoc(slug)) return <DocsArticle slug={slug} />;

  return <ApiExplorer operationId={slug} />;
}
