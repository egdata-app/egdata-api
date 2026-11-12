import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersLayout,
});

function AdminUsersLayout() {
  const { isAdmin } = useDashboardAuth();
  return isAdmin ? (
    <Outlet />
  ) : (
    <p role="alert">Administrator access required.</p>
  );
}
