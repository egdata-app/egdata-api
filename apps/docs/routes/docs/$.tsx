import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import type { ClientApiPageProps } from "fumadocs-openapi/ui/create-client";
import {
  DocsBody,
  DocsDescription,
  DocsTitle,
  DocsPage as FumadocsPage,
} from "fumadocs-ui/layouts/docs/page";
import { ClientAPIPage } from "@/components/api-page";

const getDocsSplatPage = createServerFn()
  .inputValidator((splat?: string) => splat)
  .handler(async ({ data }) => {
    const { DocsPageServer, ensureDocsPage, getDocsHead, slugFromSplat } =
      await import("@/components/docs-page.server");
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
      page: await renderServerComponent(<DocsPageServer slug={slug} />),
    };
  });

export const Route = createFileRoute("/docs/$")({
  loader: ({ params }) => getDocsSplatPage({ data: params._splat }),
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

  return <>{data.page}</>;
}
