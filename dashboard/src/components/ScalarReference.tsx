import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import type { ApiDocument } from "../lib/explorer";

export default function ScalarReference({
  document,
}: {
  document: ApiDocument;
}) {
  return (
    <ApiReferenceReact
      configuration={{
        content: document,
        agent: { disabled: true },
        authentication: {
          allowedSecuritySchemes: [],
          createAnySecurityScheme: false,
        },
        showSidebar: false,
        showDeveloperTools: "never",
        hideSearch: true,
        hideClientButton: true,
        hideTestRequestButton: true,
        persistAuth: false,
        telemetry: false,
        withDefaultFonts: false,
        proxyUrl: "",
        fetch: async () => {
          throw new Error("Use the same-origin Try it console");
        },
        hideDownloadButton: true,
        darkMode: true,
      }}
    />
  );
}
