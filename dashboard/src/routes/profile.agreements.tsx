import { createFileRoute } from "@tanstack/react-router";
import { DeveloperOnboarding } from "../components/DeveloperAccount";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/profile/agreements")({
  component: AgreementsPage,
});

function AgreementsPage() {
  const { account } = useDashboardAuth();
  return <DeveloperOnboarding key={account?.revision} />;
}
