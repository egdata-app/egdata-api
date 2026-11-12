import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/agreements")({
  component: () => <Navigate to="/profile/agreements" replace />,
});
