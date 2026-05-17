import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { getSource } from "@/lib/source";

export async function DocsLayoutServer({ children }: { children?: ReactNode }) {
  const source = await getSource();

  return (
    <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
      {children}
    </DocsLayout>
  );
}
