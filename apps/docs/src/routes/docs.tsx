import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/docs")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
      <Outlet />
    </DocsLayout>
  );
}
