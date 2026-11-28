import { createFileRoute } from "@tanstack/react-router";
import { DocsArticle, DocsNotFound } from "../components/DocsArticle";
import { findProblemDoc } from "../lib/docs/catalog";

export const Route = createFileRoute("/problems/$slug")({
  component: ProblemsSlugPage,
});

function ProblemsSlugPage() {
  const { slug } = Route.useParams();
  const entry = findProblemDoc(slug);
  if (!entry) return <DocsNotFound slug={slug} />;
  return <DocsArticle slug={entry.slug} />;
}
