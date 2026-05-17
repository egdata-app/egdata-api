import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";

const getDocsIndexPage = createServerFn().handler(async () => {
  const { DocsPageServer, getDocsHead } = await import(
    "@/components/docs-page.server"
  );

  return {
    head: getDocsHead(),
    page: await renderServerComponent(<DocsPageServer />),
  };
});

export const Route = createFileRoute("/docs/")({
  loader: () => getDocsIndexPage(),
  head: ({ loaderData }) => loaderData?.head ?? {},
  component: DocsIndexPage,
});

function DocsIndexPage() {
  const { page } = Route.useLoaderData();

  return <>{page}</>;
}
