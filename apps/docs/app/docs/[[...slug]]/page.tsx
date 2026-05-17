import { APIPage } from "@/components/api-page";
import { getApiReferenceRedirect } from "@/lib/api-reference-redirects";
import { getMDXComponents } from "@/mdx-components";
import { source } from "@/lib/source";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";
import type { OpenAPIPageData } from "fumadocs-openapi/server";
import type { MDXContent } from "mdx/types";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import type { ComponentProps } from "react";

type MdxPageData = {
  body: MDXContent;
  description?: string;
  full?: boolean;
  title: string;
  toc?: ComponentProps<typeof DocsPage>["toc"];
};

type PageProps = {
  params: Promise<{
    slug?: string[];
  }>;
};

export default async function Page({ params }: PageProps) {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    const redirectTo = getApiReferenceRedirect(slug);

    if (redirectTo) {
      redirect(redirectTo);
    }

    notFound();
  }

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

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);

  if (!page) {
    const redirectTo = getApiReferenceRedirect(slug);

    if (redirectTo) {
      redirect(redirectTo);
    }

    notFound();
  }

  return {
    title: page.data.title,
    description: page.data.description,
  };
}
