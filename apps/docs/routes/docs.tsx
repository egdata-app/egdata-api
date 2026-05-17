import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { baseOptions } from "@/lib/layout.shared";

const getDocsLayout = createServerFn().handler(async () => {
  const { getSource } = await import("@/lib/source");
  const source = await getSource();

  return {
    tree: await source.serializePageTree(source.getPageTree()),
  };
});

export const Route = createFileRoute("/docs")({
  loader: () => getDocsLayout(),
  component: DocsRootLayout,
});

function DocsRootLayout() {
  const { tree } = useFumadocsLoader(Route.useLoaderData());

  return (
    <DocsLayout {...baseOptions()} tree={tree}>
      <Outlet />
    </DocsLayout>
  );
}
