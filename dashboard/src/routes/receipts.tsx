import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/receipts")({
  validateSearch: (search: Record<string, unknown>): { receipt?: string } => ({
    receipt: typeof search.receipt === "string" ? search.receipt : undefined,
  }),
  component: ReceiptRedirect,
});

function ReceiptRedirect() {
  return <Navigate to="/profile/receipts" search={Route.useSearch()} replace />;
}
