import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AccountPage } from "../components/AccountPage";

export const Route = createFileRoute("/profile")({ component: ProfileLayout });

function ProfileLayout() {
  return (
    <AccountPage>
      <Outlet />
    </AccountPage>
  );
}
