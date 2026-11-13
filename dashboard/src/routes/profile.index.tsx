import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CreditCard,
  ExternalLink,
  FileText,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { DeleteAccount, EmailProfile } from "../components/DeveloperAccount";
import { Button, buttonStyles } from "../components/ui/Button";
import { Dialog, Heading, Modal } from "../components/ui/Modal";
import { notify } from "../components/ui/Toast";
import { dashboardClient } from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";

export const Route = createFileRoute("/profile/")({ component: ProfilePage });

function ProfilePage() {
  const { user, account, projects } = useDashboardAuth();
  const [deleting, setDeleting] = useState(false);
  const [openingPortal, setOpeningPortal] = useState(false);

  async function openPortal() {
    setOpeningPortal(true);
    try {
      const portal = await dashboardClient.createBillingPortal(
        window.location.href,
      );
      window.location.assign(portal.url);
    } catch (err) {
      notify({
        title: "Could not open Billing Portal",
        description: err instanceof Error ? err.message : "Try again shortly.",
        tone: "danger",
      });
      setOpeningPortal(false);
    }
  }
  return (
    <>
      <div className="mb-8 space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">Your profile</h1>
        <p className="text-sm text-epic-text-muted">
          Manage your notification email, account documents, and developer
          account settings.
        </p>
      </div>
      <div className="grid gap-6 items-start lg:grid-cols-[280px_minmax(0,1fr)]">
        <section
          aria-label="Epic Games identity"
          className="min-w-0 rounded-2xl border border-epic-border bg-epic-surface p-6 space-y-4"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-epic-accent-muted text-epic-accent">
            <UserRound className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-epic-text-muted mb-2">
              Epic Games account
            </p>
            <h2 className="text-xl font-semibold break-words">
              {user?.displayName}
            </h2>
          </div>
          <p className="text-sm leading-relaxed text-epic-text-muted">
            Your display name is managed by Epic Games.
          </p>
          <dl className="border-t border-epic-border pt-4 text-xs space-y-2">
            <dt className="text-epic-text-muted">Account ID</dt>
            <dd className="font-mono break-all select-all">
              {user?.epicAccountId}
            </dd>
          </dl>
        </section>
        <div className="min-w-0 space-y-6">
          <section
            aria-label="Notification email settings"
            className="rounded-2xl border border-epic-border bg-epic-surface p-6 sm:p-8"
          >
            <EmailProfile />
          </section>
          <section className="rounded-2xl border border-epic-border bg-epic-surface p-6 sm:p-8 space-y-4">
            <h2 className="flex items-center gap-2 font-semibold text-lg">
              <CreditCard
                className="h-5 w-5 text-epic-accent"
                aria-hidden="true"
              />{" "}
              Billing &amp; subscriptions
            </h2>
            <p className="text-sm leading-relaxed text-epic-text-muted">
              Upgrade or downgrade plans, cancel renewals, submit 14-day
              withdrawal requests, and download your purchase receipts or Stripe
              invoices across{" "}
              <strong className="text-epic-text">
                {projects.length}{" "}
                {projects.length === 1 ? "project" : "projects"}
              </strong>
              .
            </p>
            <div className="flex flex-wrap gap-3">
              <Link
                to="/profile/billing"
                className={buttonStyles({ variant: "secondary" })}
              >
                Manage subscriptions
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                to="/profile/receipts"
                className={buttonStyles({ variant: "secondary" })}
              >
                Purchase receipts
              </Link>
              <Button
                variant="quiet"
                isPending={openingPortal}
                onPress={() => void openPortal()}
              >
                Stripe Billing Portal &amp; Invoices
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </section>
          <section className="rounded-2xl border border-epic-border bg-epic-surface p-6 sm:p-8 space-y-4">
            <h2 className="flex items-center gap-2 font-semibold text-lg">
              <FileText
                className="h-5 w-5 text-epic-accent"
                aria-hidden="true"
              />{" "}
              Agreements &amp; receipts
            </h2>
            <p className="text-sm leading-relaxed text-epic-text-muted">
              Review your Developer Terms and Privacy Notice, or keep a
              printable copy of the versions recorded with your acceptance.
            </p>
            {account?.enabled && !account.eligible && (
              <p className="text-sm text-epic-warning">
                Your account setup is still in progress.
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              <a
                href="/profile/agreements"
                className={buttonStyles({
                  variant: account?.eligible ? "secondary" : "primary",
                })}
              >
                {account?.eligible ? "Review agreements" : "Continue setup"}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <a
                href="/profile/receipts"
                className={buttonStyles({ variant: "secondary" })}
              >
                View receipts
              </a>
            </div>
            <p className="flex items-start gap-2 text-xs leading-relaxed text-epic-text-muted">
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
              The Privacy Notice is informational, not a consent request.
            </p>
          </section>
          <section className="rounded-2xl border border-epic-border bg-epic-surface p-6 sm:p-8 space-y-4">
            <h2 className="font-semibold text-lg">
              Your data &amp; privacy rights
            </h2>
            <p className="text-sm leading-relaxed text-epic-text-muted">
              Download your developer account records. For a complete access
              request, correction, erasure, restriction, or objection—including
              support and security records—contact us. You can exercise your
              rights without accepting the terms.
            </p>
            <div className="flex flex-wrap gap-3">
              <a
                href="/_dashboard/api/account/export"
                className={buttonStyles({ variant: "secondary" })}
              >
                Export account data
              </a>
              <a
                href="mailto:contact@egdata.app?subject=Privacy%20rights%20request"
                className={buttonStyles({ variant: "quiet" })}
              >
                Contact privacy support
              </a>
            </div>
          </section>
          <section className="rounded-2xl border border-epic-danger/25 p-6 sm:p-8 space-y-4">
            <h2 className="font-semibold text-lg">Delete developer account</h2>
            <p className="text-sm text-epic-text-muted leading-relaxed">
              Permanently remove your developer account, projects, and
              credentials. Integrations using your API keys will stop working.
            </p>
            <Button variant="destructive" onPress={() => setDeleting(true)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete account
            </Button>
          </section>
        </div>
      </div>
      <Modal isOpen={deleting} onOpenChange={setDeleting}>
        <Dialog>
          <Heading slot="title" className="text-xl font-semibold mb-5">
            Delete developer account
          </Heading>
          <DeleteAccount />
          <Button
            variant="secondary"
            className="mt-6"
            onPress={() => setDeleting(false)}
          >
            Cancel
          </Button>
        </Dialog>
      </Modal>
    </>
  );
}
