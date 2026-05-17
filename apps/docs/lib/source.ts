import { openapi } from "@/lib/openapi";
import { loader } from "fumadocs-core/source";
import { openapiPlugin, openapiSource } from "fumadocs-openapi/server";
import { docs } from "collections/server";

const apiReferenceSource = await openapiSource(openapi, {
  baseDir: "api-reference",
  groupBy: "tag",
  meta: {
    folderStyle: "folder",
  },
});

const apiReferenceWithIndex = {
  files: apiReferenceSource.files.map((file) => {
    const normalizedPath = file.path.replaceAll("\\", "/");

    if (file.type === "meta" && normalizedPath === "api-reference/meta.json") {
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

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: apiReferenceWithIndex,
  },
  {
    baseUrl: "/docs",
    plugins: [openapiPlugin()],
  },
);
