import { notFound, redirect } from "@tanstack/react-router";
import { getApiReferenceRedirect } from "@/lib/api-reference-redirects";
import { getSource } from "@/lib/source";

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
  const page = await ensureDocsPage(slug);

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
