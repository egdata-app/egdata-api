import { createFileRoute } from "@tanstack/react-router";
import { ApiExplorer } from "../components/ApiExplorer";

export const Route = createFileRoute("/docs/")({ component: ApiExplorer });
