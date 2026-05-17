import { notFound, redirect } from "@tanstack/react-router";
import {
  DocsBody,
  DocsDescription,
  DocsTitle,
  DocsPage as FumadocsPage,
} from "fumadocs-ui/layouts/docs/page";
import type { MDXContent } from "mdx/types";
import type { ComponentProps } from "react";
import { getApiReferenceRedirect } from "@/lib/api-reference-redirects";
import { getSource } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

type MdxPageData = {
  body: MDXContent;
  description?: string;
  full?: boolean;
  title: string;
  toc?: ComponentProps<typeof FumadocsPage>["toc"];
};

export type DocsHead = {
  meta?: Array<{
    content?: string;
    name?: string;
    title?: string;
  }>;
};

export function slugFromSplat(splat?: string) {
  return splat?.split("/").filter(Boolean);
}

export async function ensureDocsPage(slug?: string[]) {
  const source = await getSource();
  const page = source.getPage(slug);

  if (!page) {
    const redirectTo = getApiReferenceRedirect(slug);

    if (redirectTo) {
      throw redirect({ href: redirectTo });
    }

    throw notFound();
  }

  return page;
}

export async function getDocsHead(slug?: string[]): Promise<DocsHead> {
  const source = await getSource();
  const page = source.getPage(slug);

  if (!page) {
    return {};
  }

  return {
    meta: [
      {
        title: `${page.data.title} - egdata API Docs`,
      },
      {
        name: "description",
        content: page.data.description,
      },
    ],
  };
}

export async function DocsPageServer({ slug }: { slug?: string[] }) {
  const page = await ensureDocsPage(slug);

  if (page.type === "openapi") {
    throw new Error("OpenAPI pages must be rendered with ClientAPIPage.");
  }

  const mdxPage = page.data as MdxPageData;
  const MDX = mdxPage.body;

  return (
    <FumadocsPage full={mdxPage.full} toc={mdxPage.toc}>
      <DocsTitle>{mdxPage.title}</DocsTitle>
      <DocsDescription>{mdxPage.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </FumadocsPage>
  );
}
