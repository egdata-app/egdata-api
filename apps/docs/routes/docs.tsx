import { createFileRoute, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  CompositeComponent,
  createCompositeComponent,
} from "@tanstack/react-start/rsc";

const getDocsLayout = createServerFn().handler(async () => {
  const { DocsLayoutServer } = await import("@/components/docs-layout.server");

  return createCompositeComponent(DocsLayoutServer);
});

export const Route = createFileRoute("/docs")({
  loader: async () => ({
    layout: await getDocsLayout(),
  }),
  component: DocsRootLayout,
});

function DocsRootLayout() {
  const { layout } = Route.useLoaderData();

  return (
    <CompositeComponent src={layout}>
      <Outlet />
    </CompositeComponent>
  );
}
