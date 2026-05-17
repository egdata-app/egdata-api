import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { openapiPlugin, openapiSource } from "fumadocs-openapi/server";
import { openapi } from "@/lib/openapi";

type ApiReferenceSource = Awaited<ReturnType<typeof openapiSource>>;

function addApiReferenceIndex(apiReferenceSource: ApiReferenceSource) {
  return {
    files: apiReferenceSource.files.map((file) => {
      const normalizedPath = file.path.replaceAll("\\", "/");

      if (
        file.type === "meta" &&
        normalizedPath === "api-reference/meta.json"
      ) {
        const pages = Array.isArray(file.data.pages) ? file.data.pages : [];

        return {
          ...file,
          data: {
            ...file.data,
            title: "API Reference",
            description: "Public stable REST endpoints grouped by resource.",
            pages: ["index", ...pages],
          },
        };
      }

      return file;
    }),
  };
}

function createSource(apiReferenceSource: ApiReferenceSource) {
  return loader(
    {
      docs: docs.toFumadocsSource(),
      openapi: addApiReferenceIndex(apiReferenceSource),
    },
    {
      baseUrl: "/docs",
      plugins: [openapiPlugin()],
    },
  );
}

let sourcePromise: Promise<ReturnType<typeof createSource>> | undefined;

export function getSource() {
  sourcePromise ??= openapiSource(openapi, {
    baseDir: "api-reference",
    groupBy: "tag",
    meta: {
      folderStyle: "folder",
    },
  }).then(createSource);

  return sourcePromise;
}
