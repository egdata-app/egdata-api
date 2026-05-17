import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ClientApiPageProps } from "fumadocs-openapi/ui/create-client";
import {
  DocsBody,
  DocsDescription,
  DocsTitle,
  DocsPage as FumadocsPage,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";
import { ClientAPIPage } from "@/components/api-page";
import { docsClientLoader } from "@/components/docs-mdx-page";

const getDocsSplatPage = createServerFn()
  .inputValidator((splat?: string) => splat)
  .handler(async ({ data }) => {
    const { ensureDocsPage, getDocsHead, slugFromSplat } = await import(
      "@/lib/docs-pages"
    );
    const slug = slugFromSplat(data);
    const page = await ensureDocsPage(slug);
    const head = await getDocsHead(slug);

    if (page.type === "openapi") {
      return {
        type: "openapi" as const,
        head,
        title: page.data.title,
        description: page.data.description,
        props: await page.data.getClientAPIPageProps(),
      };
    }

    return {
      type: "mdx" as const,
      head,
      path: page.path,
    };
  });

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }) => {
    const data = await getDocsSplatPage({ data: params._splat });

    if (data.type === "mdx") {
      await docsClientLoader.preload(data.path);
    }

    return data;
  },
  head: ({ loaderData }) => loaderData?.head ?? {},
  component: DocsSplatPage,
});

function DocsSplatPage() {
  const data = Route.useLoaderData();

  if (data.type === "openapi") {
    const apiPageProps = data.props as ClientApiPageProps;

    return (
      <FumadocsPage full>
        <DocsTitle>{data.title}</DocsTitle>
        <DocsDescription>{data.description}</DocsDescription>
        <DocsBody>
          <ClientAPIPage {...apiPageProps} />
        </DocsBody>
      </FumadocsPage>
    );
  }

  return <MdxDocsPage path={data.path} />;
}

function MdxDocsPage({ path }: { path: string }) {
  return <Suspense>{docsClientLoader.useContent(path)}</Suspense>;
}
