import { createFileRoute } from "@tanstack/react-router";
import { DocsArticle } from "../components/DocsArticle";

export const Route = createFileRoute("/problems/")({
  component: ProblemsIndexPage,
});

function ProblemsIndexPage() {
  return <DocsArticle slug="problems" />;
}
