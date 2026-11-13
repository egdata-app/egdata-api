import {
  AlertTriangle,
  ExternalLink,
  KeyRound,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  AFFILIATION_DISCLAIMER_STORAGE_KEY,
  AFFILIATION_DISCLAIMER_VERSION,
  acknowledgeAffiliationDisclaimer,
  shouldShowAffiliationDisclaimer,
} from "../lib/affiliation-disclaimer";
import { EgdataLogo, EpicGamesIcon } from "./icons/BrandIcons";
import { Button, buttonStyles } from "./ui/Button";
import { Dialog, Heading, Modal } from "./ui/Modal";

export function AffiliationDisclaimerModal() {
  const [isOpen, setIsOpen] = useState(() => shouldShowAffiliationDisclaimer());

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== AFFILIATION_DISCLAIMER_STORAGE_KEY) return;
      setIsOpen(event.newValue !== AFFILIATION_DISCLAIMER_VERSION);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function handleAcknowledge() {
    acknowledgeAffiliationDisclaimer();
    setIsOpen(false);
  }

  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) handleAcknowledge();
      }}
      isDismissable={false}
      isKeyboardDismissDisabled
      size="lg"
      className="border-epic-warning/40"
    >
      <Dialog className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="w-11 h-11 rounded-xl bg-epic-warning/15 border border-epic-warning/35 flex items-center justify-center shrink-0">
            <AlertTriangle
              className="w-5 h-5 text-epic-warning"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-1 min-w-0">
            <span className="inline-flex items-center gap-1.5 text-xs text-epic-text-muted">
              <EgdataLogo className="w-3.5 h-3.5" />
              egdata Developer Portal
            </span>
            <Heading
              slot="title"
              className="text-xl font-bold tracking-tight text-white"
            >
              egdata is NOT Epic Games
            </Heading>
          </div>
        </div>

        <div className="rounded-xl bg-epic-bg border border-epic-warning/30 p-4 space-y-2">
          <p className="text-sm text-epic-text leading-relaxed">
            <strong className="text-white">egdata</strong> is an independent
            community project and third-party API for Epic Games Store catalog
            data. It is{" "}
            <strong className="text-epic-warning">
              not owned by, operated by, endorsed by, or affiliated with Epic
              Games, Inc.
            </strong>
          </p>
          <p className="text-xs text-epic-text-muted leading-relaxed">
            This dashboard intentionally uses a dark interface similar to Epic
            Games&apos; design system and supports Epic Games sign-in, but you
            are on <span className="font-mono text-epic-text">egdata</span> —
            not an official Epic Games website.
          </p>
        </div>

        <ul className="space-y-2.5 text-xs text-epic-text-muted">
          <li className="flex items-start gap-3 rounded-lg bg-epic-elevated/60 border border-epic-border px-3.5 py-2.5">
            <KeyRound
              className="w-4 h-4 text-epic-accent shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <span>
              <strong className="text-epic-text">
                Separate keys &amp; terms:
              </strong>{" "}
              API keys, quotas, and developer agreements created here only work
              with egdata, not Epic Online Services or Epic&apos;s official
              Developer Portal.
            </span>
          </li>
          <li className="flex items-start gap-3 rounded-lg bg-epic-elevated/60 border border-epic-border px-3.5 py-2.5">
            <EpicGamesIcon className="w-4 h-4 text-epic-text shrink-0 mt-0.5" />
            <span>
              <strong className="text-epic-text">
                Official Epic OAuth sign-in:
              </strong>{" "}
              Signing in redirects you to{" "}
              <span className="font-mono text-epic-text">epicgames.com</span>.
              egdata never sees or stores your Epic Games password.
            </span>
          </li>
          <li className="flex items-start gap-3 rounded-lg bg-epic-elevated/60 border border-epic-border px-3.5 py-2.5">
            <ShieldAlert
              className="w-4 h-4 text-epic-warning shrink-0 mt-0.5"
              aria-hidden="true"
            />
            <span>
              <strong className="text-epic-text">
                Looking for official Epic Games?
              </strong>{" "}
              Official developer tools live at{" "}
              <a
                href="https://dev.epicgames.com"
                target="_blank"
                rel="noreferrer"
                className="text-epic-accent hover:text-epic-accent-hover underline underline-offset-2"
              >
                dev.epicgames.com
              </a>{" "}
              and the official store is at{" "}
              <a
                href="https://store.epicgames.com"
                target="_blank"
                rel="noreferrer"
                className="text-epic-accent hover:text-epic-accent-hover underline underline-offset-2"
              >
                store.epicgames.com
              </a>
              .
            </span>
          </li>
        </ul>

        <p className="text-[11px] text-epic-text-muted leading-relaxed">
          By continuing, you confirm that you understand egdata is independent
          from and not affiliated with or endorsed by Epic Games, Inc., and that
          this acknowledgment applies to this and future visits.
        </p>

        <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-3 border-t border-epic-border">
          <a
            href="https://dev.epicgames.com"
            target="_blank"
            rel="noreferrer"
            className={buttonStyles({ variant: "secondary", size: "md" })}
          >
            Official Epic Portal
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
          <Button variant="primary" size="md" onPress={handleAcknowledge}>
            I understand — continue to egdata
          </Button>
        </div>
      </Dialog>
    </Modal>
  );
}
