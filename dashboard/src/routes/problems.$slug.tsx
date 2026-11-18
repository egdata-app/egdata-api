import { createFileRoute } from "@tanstack/react-router";
import { DocsArticle } from "../components/DocsArticle";

export const Route = createFileRoute("/problems/$slug")({
  component: ProblemsSlugPage,
});

function ProblemsSlugPage() {
  const { slug } = Route.useParams();
  return <DocsArticle slug={slug} />;
}
