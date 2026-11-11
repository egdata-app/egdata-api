import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import type { ApiDocument } from "../lib/explorer";

const embeddedScalarCss = `
  /* Match egdata dark surface palette and eliminate full-page document chrome */
  .scalar-api-reference.references-layout {
    min-height: 0 !important;
    --full-height: auto !important;
    --scalar-background-1: #18181c;
    --scalar-background-2: #202024;
    --scalar-background-3: #28282e;
    --scalar-border-color: #26262c;
    --scalar-color-1: #f5f5f7;
    --scalar-color-2: #9a9aa6;
    --scalar-color-3: #6e6e7a;
    --scalar-color-accent: #26bbff;
    --scalar-background-accent: rgba(38, 187, 255, 0.14);
    border-radius: 0.75rem;
  }

  .scalar-api-reference .references-rendered {
    padding-bottom: 0 !important;
    background: transparent !important;
  }

  /* Hide redundant global OpenAPI introduction, mobile nav bar, tag banner, and flare */
  .scalar-api-reference .introduction-section,
  .scalar-api-reference .section-container:has(.introduction-section),
  .scalar-api-reference .tag-section,
  .scalar-api-reference .t-doc__header,
  .scalar-api-reference .section-flare,
  .scalar-api-reference .references-footer {
    display: none !important;
  }

  .scalar-api-reference .section-container {
    padding: 0 24px !important;
    border-top: none !important;
  }

  /* Scalar's document layout is designed for a full page. Tighten the
     per-operation spacing so the embedded reference does not waste vertical
     space around a single endpoint. */
  .scalar-api-reference .section {
    padding: 24px 0 !important;
  }

  .scalar-api-reference .operation-layout {
    gap: 0 32px !important;
  }

  /* Keep long response status lists inside the examples column instead of
     turning the tab strip into a horizontal scroller. */
  .scalar-api-reference .response-card .tab-list {
    gap: 3px !important;
    padding: 6px !important;
    overflow-y: hidden !important;
  }

  .scalar-api-reference .response-card .tab {
    font-size: 13px !important;
  }
`;

export default function ScalarReference({
  document,
}: {
  document: ApiDocument;
}) {
  return (
    <div className="rounded-xl border border-epic-border bg-epic-surface overflow-hidden">
      <ApiReferenceReact
        configuration={{
          content: document,
          agent: { disabled: true },
          authentication: {
            allowedSecuritySchemes: [],
            createAnySecurityScheme: false,
          },
          urlRouting: false,
          hideModels: true,
          hideDarkModeToggle: true,
          documentDownloadType: "none",
          showSidebar: false,
          showDeveloperTools: "never",
          hideSearch: true,
          hideClientButton: true,
          hideTestRequestButton: true,
          persistAuth: false,
          telemetry: false,
          withDefaultFonts: false,
          proxyUrl: "",
          customFetch: async () => {
            throw new Error("Use the same-origin Try it console");
          },
          fetch: async () => {
            throw new Error("Use the same-origin Try it console");
          },
          hideDownloadButton: true,
          darkMode: true,
          forceDarkModeState: "dark",
          customCss: embeddedScalarCss,
        }}
      />
    </div>
  );
}
