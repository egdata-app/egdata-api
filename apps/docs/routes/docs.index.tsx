import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Suspense } from "react";
import { docsClientLoader } from "@/components/docs-mdx-page";

const getDocsIndexPage = createServerFn().handler(async () => {
  const { ensureDocsPage, getDocsHead } = await import("@/lib/docs-pages");
  const page = await ensureDocsPage();

  return {
    head: await getDocsHead(),
    path: page.path,
  };
});

export const Route = createFileRoute("/docs/")({
  loader: async () => {
    const data = await getDocsIndexPage();

    await docsClientLoader.preload(data.path);

    return data;
  },
  head: ({ loaderData }) => loaderData?.head ?? {},
  component: DocsIndexPage,
});

function DocsIndexPage() {
  const { path } = Route.useLoaderData();

  return <Suspense>{docsClientLoader.useContent(path)}</Suspense>;
}
