import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  LogOut,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DashboardApiError, dashboardClient } from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";
import {
  clearVerificationToken,
  readVerificationToken,
} from "../lib/email-verification";
import { DeveloperTerms } from "./DeveloperTerms";
import { Button, buttonStyles } from "./ui/Button";
import { Checkbox } from "./ui/Controls";
import { Dialog, DialogTrigger, Popover } from "./ui/Modal";
import { TextField } from "./ui/TextField";

function message(error: unknown) {
  return error instanceof Error ? error.message : "Please try again.";
}

export function EmailProfile({
  mode = "profile",
  onSent,
  onEditEmail,
}: {
  mode?: "profile" | "email" | "verify";
  onSent?: () => void;
  onEditEmail?: () => void;
}) {
  const { user, account, refreshSession } = useDashboardAuth();
  const [email, setEmail] = useState(
    account?.pendingEmail ?? account?.contactEmail ?? "",
  );
  const [token, setToken] = useState(readVerificationToken);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function send(address = email) {
    setPending("send");
    setError("");
    setNotice("");
    try {
      await dashboardClient.requestEmailVerification(address);
      clearVerificationToken();
      setToken("");
      setNotice(
        "Verification email sent. Open its link or paste the code below. It expires in 30 minutes.",
      );
      await refreshSession();
      onSent?.();
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }
  async function verify() {
    setPending("verify");
    setError("");
    try {
      await dashboardClient.verifyEmail(token.trim());
      clearVerificationToken();
      setToken("");
      setNotice("Notification email verified.");
      await refreshSession();
      window.dispatchEvent(new Event("egdata:account-changed"));
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(null);
    }
  }
  return (
    <section className="space-y-4">
      {mode === "profile" && (
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Mail className="w-4 h-4" /> Notification email
          </h3>
          <p className="text-sm text-epic-text-muted mt-2">
            Used for terms updates and essential service notices, not marketing.
            Your Epic display name ({user?.displayName}) remains managed by
            Epic.
          </p>
        </div>
      )}
      {account?.verifiedAt && (
        <p
          className="truncate text-sm text-epic-success"
          title={account.contactEmail ?? undefined}
        >
          Verified: {account.contactEmail}
        </p>
      )}
      {mode !== "verify" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
          className="space-y-3"
        >
          <TextField
            id="notification-email"
            label="Email address"
            type="email"
            autoComplete="email"
            value={email}
            onChange={setEmail}
            isRequired
            isDisabled={Boolean(pending)}
          />
          <Button
            type="submit"
            variant={mode === "email" ? "primary" : "secondary"}
            isDisabled={Boolean(pending)}
          >
            {pending === "send"
              ? "Sending…"
              : account?.verifiedAt
                ? "Verify a replacement email"
                : "Send verification email"}
            {mode === "email" && (
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            )}
          </Button>
          {mode === "email" && account?.pendingEmail && (
            <Button
              variant="quiet"
              onPress={onSent}
              isDisabled={Boolean(pending)}
            >
              Back to verification
            </Button>
          )}
        </form>
      )}
      {account?.verifiedAt && (
        <p className="text-xs text-epic-text-muted">
          Your current address stays active until the replacement is verified.
          We will notify the previous address of the change.
        </p>
      )}
      {mode !== "email" && (account?.pendingEmail || token) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify();
          }}
          className={
            mode === "verify"
              ? "space-y-5"
              : "space-y-3 border-t border-epic-border pt-4"
          }
        >
          <p className="text-sm text-epic-text-muted">
            We sent a verification link to{" "}
            <strong className="text-epic-text font-medium break-all">
              {account?.pendingEmail ?? "your email"}
            </strong>
            . Open it in this browser, or paste the code from the email below.
          </p>
          <TextField
            label="Verification code"
            value={token}
            onChange={setToken}
            autoComplete="one-time-code"
            description="The link and code expire after 30 minutes."
            isRequired
            isDisabled={Boolean(pending)}
          />
          <Button type="submit" isDisabled={Boolean(pending) || !token.trim()}>
            {pending === "verify" ? "Verifying…" : "Confirm email"}
          </Button>
        </form>
      )}
      {mode === "verify" && (
        <div className="flex flex-wrap gap-2 border-t border-epic-border pt-4">
          <Button
            variant="quiet"
            onPress={onEditEmail}
            isDisabled={Boolean(pending)}
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Change email
          </Button>
          <Button
            variant="secondary"
            isDisabled={Boolean(pending) || !account?.pendingEmail}
            onPress={() => {
              void send(account?.pendingEmail ?? email);
            }}
          >
            {pending === "send" ? "Sending…" : "Resend email"}
          </Button>
          <p className="w-full text-xs leading-relaxed text-epic-text-muted">
            Check your spam folder, too. You can resend once a minute, up to
            five times a day.
          </p>
        </div>
      )}
      {notice && (
        <output className="block text-sm text-epic-success">{notice}</output>
      )}
      {error && (
        <p role="alert" className="text-sm text-epic-danger">
          {error}
        </p>
      )}
    </section>
  );
}

export function DeleteAccount() {
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  async function remove() {
    setPending(true);
    setError("");
    try {
      await dashboardClient.deleteAccount(confirmation);
      clearVerificationToken();
      window.dispatchEvent(new Event("egdata:clear-credentials"));
      window.dispatchEvent(new Event("egdata:account-changed"));
      window.location.assign("/?account=closed");
    } catch (err) {
      setError(message(err));
      setReauth(
        err instanceof DashboardApiError &&
          err.code === "REAUTHENTICATION_REQUIRED",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="space-y-4">
      <p className="text-sm text-epic-text-muted">
        This deletes your developer account, projects and active credentials,
        ends all dashboard/console sessions, and stops integrations using your
        keys. You cannot undo this here. Re-registration is held for 30 days
        while closure records expire.
      </p>
      <p className="text-sm text-epic-text-muted">
        Legal evidence, independent analytics, security records and backups
        follow the Privacy Notice. This is not a promise of immediate erasure of
        every record. Lawfully retained API caches remain subject to the Terms.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void remove();
        }}
        className="space-y-4"
      >
        <TextField
          label="Type DELETE to confirm"
          value={confirmation}
          onChange={setConfirmation}
          isDisabled={pending}
          autoComplete="off"
        />
        <Button
          type="submit"
          variant="destructive"
          isDisabled={pending || confirmation !== "DELETE"}
        >
          {pending ? "Deleting…" : "Delete my account"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-epic-danger">
          {error}
        </p>
      )}
      {reauth && (
        <a
          className="text-epic-accent underline"
          href="/_dashboard/api/auth/epic/login?redirect=/profile"
        >
          Sign in again with Epic, then reopen Delete account
        </a>
      )}
    </section>
  );
}

export function AccountMenu() {
  const { user, logout } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="quiet" aria-label="Account menu">
        <UserRound className="w-4 h-4" />
        <span className="max-w-32 truncate hidden sm:inline">
          {user?.displayName}
        </span>
        <ChevronDown className="w-3 h-3" />
      </Button>
      <Popover placement="bottom end">
        <Dialog aria-label="Your account" className="p-2 min-w-56 space-y-1">
          <a
            href="/profile"
            className={buttonStyles({
              variant: "quiet",
              className: "w-full justify-start",
            })}
          >
            <UserRound className="w-4 h-4" aria-hidden="true" /> Profile
          </a>
          <Button
            variant="quiet"
            className="w-full justify-start"
            onPress={() => {
              void logout().catch((err) => setError(message(err)));
            }}
          >
            <LogOut className="w-4 h-4" /> Log out
          </Button>
          {error && (
            <p role="alert" className="p-2 text-sm text-epic-danger">
              {error}
            </p>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

export function DeveloperOnboarding() {
  const { account, refreshSession } = useDashboardAuth();
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [editingEmail, setEditingEmail] = useState(false);
  const step = account?.verifiedAt
    ? 3
    : !editingEmail && (account?.pendingEmail || readVerificationToken())
      ? 2
      : 1;
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current !== step) heading.current?.focus();
    previousStep.current = step;
  }, [step]);
  const completed = Boolean(account?.acceptedAt && account?.eligible);
  const steps = [
    { title: "Email address", description: "Where to send essential notices" },
    { title: "Verify email", description: "Confirm that the inbox is yours" },
    {
      title: "Developer Terms",
      description: "Review and accept your agreement",
    },
  ];
  async function agree() {
    if (!account?.terms || !account.revision || !accepted) return;
    setPending(true);
    setError("");
    try {
      await dashboardClient.acceptTerms(
        account.revision,
        account.terms.version,
        account.terms.sha256,
      );
      await refreshSession();
      window.dispatchEvent(new Event("egdata:account-changed"));
    } catch (err) {
      setError(message(err));
      setAccepted(false);
      await refreshSession();
    } finally {
      setPending(false);
    }
  }
  return (
    <div>
      <div className="mb-8 space-y-3">
        <p className="text-xs font-medium tracking-widest text-epic-accent uppercase">
          {completed ? "Account & agreements" : "Welcome to egdata"}
        </p>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">
          {completed
            ? "Your developer agreement"
            : "A few steps, then you’re in."}
        </h1>
        <p className="max-w-2xl text-sm sm:text-base leading-relaxed text-epic-text-muted">
          {completed
            ? "Review your terms and keep a copy of your acceptance receipt."
            : "Set up your notification email and review the Developer Terms to get started with the dashboard."}
        </p>
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10">
        <aside className="min-w-0 lg:sticky lg:top-8 space-y-6">
          {account?.enabled && (
            <nav aria-label="Account setup progress">
              <ol className="grid grid-cols-3 gap-2 lg:grid-cols-1 lg:gap-2">
                {steps.map(({ title, description }, index) => {
                  const done = completed || step > index + 1;
                  const current = !completed && step === index + 1;
                  return (
                    <li
                      key={title}
                      aria-current={current ? "step" : undefined}
                      className={`flex flex-col gap-3 rounded-xl border p-3 sm:p-4 lg:flex-row ${current ? "border-epic-accent/30 bg-epic-accent-muted" : "border-transparent"}`}
                    >
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-epic-success/10 text-epic-success" : current ? "bg-epic-accent text-epic-accent-fg" : "bg-epic-elevated text-epic-text-muted"}`}
                      >
                        {done ? (
                          <Check className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          index + 1
                        )}
                      </span>
                      <div className="min-w-0 space-y-1">
                        <span
                          className={`block text-xs sm:text-sm font-medium ${current || done ? "text-epic-text" : "text-epic-text-muted"}`}
                        >
                          {title}
                          <span className="sr-only">
                            {done
                              ? ": complete"
                              : current
                                ? ": current step"
                                : ": upcoming"}
                          </span>
                        </span>
                        <p className="hidden lg:block text-xs leading-relaxed text-epic-text-muted">
                          {description}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </nav>
          )}
          {!completed && account?.enabled && (
            <div className="hidden lg:flex gap-2.5 px-4 text-xs leading-relaxed text-epic-text-muted">
              <ShieldCheck
                className="h-4 w-4 shrink-0 text-epic-success mt-0.5"
                aria-hidden="true"
              />
              <p>
                Your existing API keys keep working while you complete setup.
              </p>
            </div>
          )}
          {account?.verifiedAt && (
            <div className="rounded-xl border border-epic-border p-4 space-y-2">
              <p className="flex items-center gap-2 text-xs font-medium text-epic-success">
                <Check className="h-3.5 w-3.5" aria-hidden="true" /> Email
                verified
              </p>
              <p
                className="truncate text-sm"
                title={account.contactEmail ?? undefined}
              >
                {account.contactEmail}
              </p>
              <p className="text-xs text-epic-text-muted leading-relaxed">
                Manage your notification email on your{" "}
                <a href="/profile" className="text-epic-accent underline">
                  Profile page
                </a>
                .
              </p>
            </div>
          )}
        </aside>
        <div className="min-w-0 space-y-5">
          {!account?.enabled ? (
            <section className="rounded-2xl border border-epic-border bg-epic-surface p-6 sm:p-8 space-y-4">
              <h2 className="text-xl font-semibold">
                No agreement required yet
              </h2>
              <p className="text-sm text-epic-text-muted">
                The legal documents have not been published yet. No agreement
                requirement is active.
              </p>
              <a href="/" className={buttonStyles({ variant: "secondary" })}>
                Return to dashboard
              </a>
            </section>
          ) : (
            <>
              <section
                className={
                  step < 3
                    ? "rounded-2xl border border-epic-border bg-epic-surface p-6 sm:p-8 space-y-6"
                    : "space-y-3"
                }
              >
                <div className="space-y-3">
                  {step < 3 && (
                    <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-epic-accent-muted text-epic-accent">
                      {step === 1 ? (
                        <Mail className="h-6 w-6" aria-hidden="true" />
                      ) : (
                        <ShieldCheck className="h-6 w-6" aria-hidden="true" />
                      )}
                    </div>
                  )}
                  <p className="text-xs font-medium uppercase tracking-wider text-epic-text-muted">
                    {completed ? "Setup complete" : `Step ${step} of 3`}
                  </p>
                  <h2
                    ref={heading}
                    tabIndex={-1}
                    className="text-2xl font-semibold tracking-tight focus:outline-none"
                  >
                    {step === 1
                      ? "Where can we reach you?"
                      : step === 2
                        ? "Check your inbox"
                        : completed
                          ? "You’re all set."
                          : "Review the Developer Terms"}
                  </h2>
                  <p className="text-sm leading-relaxed text-epic-text-muted">
                    {step === 1
                      ? "Use an email you check regularly. We’ll send important terms updates and service notices here, never marketing."
                      : step === 2
                        ? "Confirm your email to continue to the agreement."
                        : completed
                          ? "Your acceptance is saved. You can download the exact terms and your receipt below."
                          : "Read the agreement below, then confirm your acceptance to finish setup. You can save a copy for your records."}
                  </p>
                </div>
                {step < 3 && (
                  <EmailProfile
                    key={step}
                    mode={step === 1 ? "email" : "verify"}
                    onSent={() => setEditingEmail(false)}
                    onEditEmail={() => setEditingEmail(true)}
                  />
                )}
              </section>
              {step === 3 && account.terms && (
                <>
                  <DeveloperTerms account={account} />
                  <section
                    aria-label={
                      completed ? "Acceptance receipt" : "Accept the agreement"
                    }
                    className={`rounded-2xl border p-5 sm:p-6 space-y-5 ${completed ? "border-epic-success/25 bg-epic-success/5" : "border-epic-accent/25 bg-epic-surface"}`}
                  >
                    {completed ? (
                      <>
                        <p className="flex items-start gap-2 text-sm text-epic-success">
                          <ShieldCheck
                            className="h-5 w-5 shrink-0"
                            aria-hidden="true"
                          />{" "}
                          Terms accepted on{" "}
                          {new Date(account.acceptedAt ?? 0).toLocaleString()}.
                        </p>
                        <div className="flex flex-wrap gap-3">
                          <a
                            className={buttonStyles({ variant: "secondary" })}
                            href="/profile/receipts"
                          >
                            View receipts
                          </a>
                          <a className={buttonStyles({})} href="/">
                            Return to dashboard{" "}
                            <ArrowRight
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                          </a>
                        </div>
                      </>
                    ) : (
                      <>
                        <Checkbox
                          isSelected={accepted}
                          onChange={setAccepted}
                          isDisabled={pending || !account.verifiedAt}
                        >
                          I agree to the Developer Terms of Service v
                          {account.terms.version}.
                        </Checkbox>
                        <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between">
                          <p className="text-xs leading-relaxed text-epic-text-muted max-w-xs">
                            We’ll save your acceptance of this exact version and
                            email you a receipt.
                          </p>
                          <Button
                            size="lg"
                            onPress={() => {
                              void agree();
                            }}
                            isDisabled={
                              !accepted || !account.verifiedAt || pending
                            }
                          >
                            {pending
                              ? "Saving acceptance…"
                              : "Agree and continue"}{" "}
                            <ArrowRight
                              className="h-4 w-4"
                              aria-hidden="true"
                            />
                          </Button>
                        </div>
                      </>
                    )}
                    {error && (
                      <p role="alert" className="text-sm text-epic-danger">
                        {error}
                      </p>
                    )}
                  </section>
                </>
              )}
            </>
          )}
          {!completed && account?.enabled && (
            <p className="lg:hidden text-xs leading-relaxed text-epic-text-muted">
              Your existing API keys keep working while you complete setup.
            </p>
          )}
        </div>
      </div>
      <footer className="mt-10 border-t border-epic-border pt-6 text-xs leading-relaxed text-epic-text-muted">
        Need help or want to exercise privacy rights?{" "}
        <a
          className="text-epic-accent underline"
          href="mailto:contact@egdata.app"
        >
          contact@egdata.app
        </a>
      </footer>
    </div>
  );
}
