import browserCollections from "collections/browser";
import {
  DocsBody,
  DocsDescription,
  DocsTitle,
  DocsPage as FumadocsPage,
} from "fumadocs-ui/layouts/docs/page";
import { useMDXComponents } from "@/mdx-components";

type Frontmatter = {
  description?: string;
  full?: boolean;
  title: string;
};

export const docsClientLoader = browserCollections.docs.createClientLoader({
  component({ default: MDX, frontmatter, toc }) {
    const data = frontmatter as Frontmatter;

    return (
      <FumadocsPage full={data.full} toc={toc}>
        <DocsTitle>{data.title}</DocsTitle>
        <DocsDescription>{data.description}</DocsDescription>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </FumadocsPage>
    );
  },
});
