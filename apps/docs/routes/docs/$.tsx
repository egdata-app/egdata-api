import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";

const getDocsSplatPage = createServerFn()
  .inputValidator((splat?: string) => splat)
  .handler(async ({ data }) => {
    const { DocsPageServer, getDocsHead, slugFromSplat } = await import(
      "@/components/docs-page.server"
    );
    const slug = slugFromSplat(data);

    return {
      head: getDocsHead(slug),
      page: await renderServerComponent(<DocsPageServer slug={slug} />),
    };
  });

export const Route = createFileRoute("/docs/$")({
  loader: ({ params }) => getDocsSplatPage({ data: params._splat }),
  head: ({ loaderData }) => loaderData?.head ?? {},
  component: DocsSplatPage,
});

function DocsSplatPage() {
  const { page } = Route.useLoaderData();

  return <>{page}</>;
}
