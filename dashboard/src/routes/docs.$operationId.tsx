import { createFileRoute } from "@tanstack/react-router";
import { ApiExplorer } from "../components/ApiExplorer";

export const Route = createFileRoute("/docs/$operationId")({
  component: () => {
    const { operationId } = Route.useParams();
    return <ApiExplorer operationId={operationId} />;
  },
});
