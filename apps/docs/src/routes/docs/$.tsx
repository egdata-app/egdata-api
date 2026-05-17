import { APIPage } from "@/components/api-page";
import { getApiReferenceRedirect } from "@/lib/api-reference-redirects";
import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import type { OpenAPIPageData } from "fumadocs-openapi/server";
import type { MDXContent } from "mdx/types";
import type { ComponentProps } from "react";

type MdxPageData = {
  body: MDXContent;
  description?: string;
  full?: boolean;
  title: string;
  toc?: ComponentProps<typeof DocsPage>["toc"];
};

export const Route = createFileRoute("/docs/$")({
  loader: ({ params }) => {
    const slug = params._splat?.split("/").filter(Boolean);
    const page = source.getPage(slug);

    if (!page) {
      const redirectTo = getApiReferenceRedirect(slug);
      if (redirectTo) {
        throw redirect({ href: redirectTo });
      }
      throw notFound();
    }

    return { page };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: `${loaderData.page.data.title} - egdata API Docs` },
      { name: "description", content: loaderData.page.data.description },
    ],
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { page } = Route.useLoaderData();

  if (page.type === "openapi") {
    const apiPage = page.data as OpenAPIPageData;

    return (
      <DocsPage full>
        <DocsTitle>{apiPage.title}</DocsTitle>
        <DocsDescription>{apiPage.description}</DocsDescription>
        <DocsBody>
          <APIPage {...apiPage.getAPIPageProps()} />
        </DocsBody>
      </DocsPage>
    );
  }

  const mdxPage = page.data as MdxPageData;
  const MDX = mdxPage.body;

  return (
    <DocsPage full={mdxPage.full} toc={mdxPage.toc}>
      <DocsTitle>{mdxPage.title}</DocsTitle>
      <DocsDescription>{mdxPage.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}
