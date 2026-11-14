import { Link, useRouterState } from "@tanstack/react-router";
import { CreditCard, FileText, ReceiptText, UserRound } from "lucide-react";
import type { ReactNode } from "react";
import { useDashboardAuth } from "../lib/auth-context";

export function AccountPage({ children }: { children: ReactNode }) {
  return <div className="account-page">{children}</div>;
}

export function ProfileNavigation() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const { paidPlansEnabled } = useDashboardAuth();
  const items = [
    { label: "Profile", to: "/profile", icon: UserRound },
    ...(paidPlansEnabled
      ? [
          {
            label: "Billing",
            to: "/profile/billing",
            icon: CreditCard,
          } as const,
        ]
      : []),
    { label: "Agreements", to: "/profile/agreements", icon: FileText },
    { label: "Receipts", to: "/profile/receipts", icon: ReceiptText },
  ] as const;
  return (
    <nav
      aria-label="Account settings"
      className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-1 overflow-x-auto [scrollbar-width:none]"
    >
      {items.map(({ label, to, icon: Icon }) => {
        const active = path.replace(/\/$/, "") === to;
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? "page" : undefined}
            className={`relative flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium whitespace-nowrap outline-0 focus-visible:text-epic-accent ${active ? "text-epic-text" : "text-epic-text-muted hover:text-epic-text"}`}
          >
            <Icon
              className={`w-4 h-4 ${active ? "text-epic-accent" : ""}`}
              aria-hidden="true"
            />
            {label}
            {active && (
              <span className="absolute bottom-0 left-2 right-2 h-[2px] bg-epic-accent rounded-t-full" />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
