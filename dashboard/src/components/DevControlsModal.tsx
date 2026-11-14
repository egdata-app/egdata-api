import { Database, ShieldCheck, Wrench } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type DevStateSnapshot, dashboardClient } from "../lib/api";
import { useDashboardAuth } from "../lib/auth-context";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Controls";
import { Dialog, Heading, Modal } from "./ui/Modal";
import { Select, SelectItem } from "./ui/Select";
import { Form, TextField } from "./ui/TextField";
import { notify } from "./ui/Toast";

const TIERS = [
  { id: "free", label: "Free (60 rpm, 100k/mo)" },
  { id: "pro", label: "Pro (200 rpm, 300k/period, 12k/day 14d)" },
  { id: "scale", label: "Scale (600 rpm, 1M/period, 35k/day 14d)" },
  { id: "enterprise", label: "Enterprise (2,500 rpm, custom)" },
];

const DAILY_MODES = [
  { id: "tier", label: "Tier default (14d cap if paid)" },
  { id: "none", label: "No daily cap" },
  { id: "custom", label: "Custom daily cap" },
];

export function DevControlsTrigger() {
  const { authenticated, devAuthAvailable, selectedProject, refreshSession } =
    useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DevStateSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const [isAdmin, setIsAdmin] = useState(false);
  const [projectLimit, setProjectLimit] = useState("1");
  const [onboardingVerified, setOnboardingVerified] = useState(false);
  const [clearWithdrawalBlock, setClearWithdrawalBlock] = useState(false);
  const [tier, setTier] = useState<"free" | "pro" | "scale" | "enterprise">(
    "free",
  );
  const [customRpm, setCustomRpm] = useState("");
  const [dailyCapMode, setDailyCapMode] = useState<"tier" | "none" | "custom">(
    "tier",
  );
  const [dailyCapCustom, setDailyCapCustom] = useState("12000");

  const loadState = useCallback(async () => {
    setLoading(true);
    try {
      const snap = await dashboardClient.getDevState(selectedProject?.id);
      setState(snap);
      setIsAdmin(snap.isAdmin);
      setProjectLimit(String(snap.projectLimit));
      setOnboardingVerified(snap.onboardingVerified);
      setClearWithdrawalBlock(false);
      if (snap.project) {
        setTier(snap.project.tier);
        setCustomRpm(
          snap.project.customRpm !== null ? String(snap.project.customRpm) : "",
        );
        const cap = snap.project.entitlement?.initialDailyLimit ?? null;
        if (cap === null) {
          setDailyCapMode(snap.project.tier === "free" ? "tier" : "none");
        } else {
          setDailyCapMode("custom");
          setDailyCapCustom(String(cap));
        }
      }
    } catch (err) {
      notify({
        title: "Failed to load local dev state",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setLoading(false);
    }
  }, [selectedProject?.id]);

  useEffect(() => {
    if (open && authenticated && devAuthAvailable) {
      void loadState();
    }
  }, [open, authenticated, devAuthAvailable, loadState]);

  if (!authenticated || !devAuthAvailable) {
    return null;
  }

  async function handleApply(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const parsedLimit = Number(projectLimit);
      const parsedRpm = customRpm.trim() === "" ? null : Number(customRpm.trim());
      const parsedDaily =
        dailyCapMode === "custom" ? Number(dailyCapCustom.trim()) : null;

      await dashboardClient.updateDevState({
        isAdmin,
        projectLimit: Number.isInteger(parsedLimit) ? parsedLimit : 1,
        onboardingVerified,
        clearWithdrawalBlock,
        ...(selectedProject
          ? {
              project: {
                id: selectedProject.id,
                tier,
                customRpm: parsedRpm,
                dailyCapMode,
                dailyCapCustom: parsedDaily,
              },
            }
          : {}),
      });
      await refreshSession();
      setOpen(false);
      notify({
        title: "Local dev state updated",
        description: "Reload the active route or refresh to see live changes.",
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Could not apply local dev state",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSeed() {
    setSeeding(true);
    try {
      const res = await dashboardClient.seedLocalDb();
      await Promise.all([refreshSession(), loadState()]);
      notify({
        title: "Local D1 seeded",
        description: `Granted admin role and ensured ${res.seededUsers} sample accounts exist.`,
        tone: "success",
      });
    } catch (err) {
      notify({
        title: "Seed failed",
        description: err instanceof Error ? err.message : "Unexpected error",
        tone: "danger",
      });
    } finally {
      setSeeding(false);
    }
  }

  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        onPress={() => setOpen(true)}
        className="border-epic-warning/40 text-epic-warning hover:text-white"
      >
        <Wrench aria-hidden="true" className="w-3.5 h-3.5" />
        Dev Tools
      </Button>

      <Modal isOpen={open} onOpenChange={setOpen} size="lg">
        <Dialog>
          <Form onSubmit={handleApply} className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Heading
                slot="title"
                className="text-lg font-semibold text-white flex items-center gap-2"
              >
                <Wrench aria-hidden="true" className="w-4 h-4 text-epic-warning" />
                Local Dev Controls
              </Heading>
              <Badge tone="warning">localhost only</Badge>
            </div>

            <div className="rounded-lg border border-epic-border bg-epic-bg/50 p-3.5 flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-0.5 text-xs">
                <div className="font-medium text-white">
                  Seed Local D1 Sample Dataset
                </div>
                <p className="text-epic-text-muted">
                  Grants you Admin + verified email and seeds Pro, Enterprise
                  Custom, and 14-day Withdrawal test users ({state?.seededUserCount ?? 0} currently seeded).
                </p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                isPending={seeding}
                isDisabled={loading || saving}
                onPress={() => void handleSeed()}
              >
                <Database aria-hidden="true" className="w-3.5 h-3.5" />
                Seed local DB
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-lg border border-epic-border p-3.5 space-y-3">
                <div className="text-xs font-medium text-epic-text-muted uppercase tracking-wider flex items-center gap-1.5">
                  <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5" />
                  Profile &amp; Role
                </div>

                <label className="flex items-center justify-between gap-2 text-xs text-white cursor-pointer">
                  <span>Admin role (`user_roles`)</span>
                  <input
                    type="checkbox"
                    checked={isAdmin}
                    onChange={(e) => setIsAdmin(e.target.checked)}
                    className="h-4 w-4 accent-epic-accent"
                  />
                </label>

                <label className="flex items-center justify-between gap-2 text-xs text-white cursor-pointer">
                  <span>Verified contact email &amp; legal terms</span>
                  <input
                    type="checkbox"
                    checked={onboardingVerified}
                    onChange={(e) => setOnboardingVerified(e.target.checked)}
                    className="h-4 w-4 accent-epic-accent"
                  />
                </label>

                {state?.selfServeCheckoutBlocked && (
                  <label className="flex items-center justify-between gap-2 text-xs text-epic-warning cursor-pointer">
                    <span>Clear statutory withdrawal checkout block</span>
                    <input
                      type="checkbox"
                      checked={clearWithdrawalBlock}
                      onChange={(e) => setClearWithdrawalBlock(e.target.checked)}
                      className="h-4 w-4 accent-epic-warning"
                    />
                  </label>
                )}

                <TextField
                  label="Project limit (1–100)"
                  type="number"
                  value={projectLimit}
                  onChange={setProjectLimit}
                />
              </div>

              <div className="rounded-lg border border-epic-border p-3.5 space-y-3">
                <div className="text-xs font-medium text-epic-text-muted uppercase tracking-wider">
                  Active Project ({selectedProject?.name ?? "None"})
                </div>

                {selectedProject ? (
                  <>
                    <Select
                      label="Tier / Manual Grant"
                      selectedKey={tier}
                      onSelectionChange={(k) => {
                        if (
                          k === "free" ||
                          k === "pro" ||
                          k === "scale" ||
                          k === "enterprise"
                        ) {
                          setTier(k);
                        }
                      }}
                      items={TIERS}
                    >
                      {(item) => (
                        <SelectItem id={item.id} textValue={item.label}>
                          {item.label}
                        </SelectItem>
                      )}
                    </Select>

                    <TextField
                      label="Custom RPM (optional, 150–500,000)"
                      type="number"
                      value={customRpm}
                      onChange={setCustomRpm}
                      placeholder="Blank = tier default"
                    />

                    <Select
                      label="14-Day Daily Cap"
                      selectedKey={dailyCapMode}
                      onSelectionChange={(k) => {
                        if (k === "tier" || k === "none" || k === "custom") {
                          setDailyCapMode(k);
                        }
                      }}
                      items={DAILY_MODES}
                    >
                      {(item) => (
                        <SelectItem id={item.id} textValue={item.label}>
                          {item.label}
                        </SelectItem>
                      )}
                    </Select>

                    {dailyCapMode === "custom" && (
                      <TextField
                        label="Daily limit (req / UTC day)"
                        type="number"
                        value={dailyCapCustom}
                        onChange={setDailyCapCustom}
                      />
                    )}
                  </>
                ) : (
                  <p className="text-xs text-epic-text-muted">
                    Select a project to modify its tier, RPM, and daily cap.
                  </p>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                variant="secondary"
                isDisabled={saving || seeding}
                onPress={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                isPending={saving}
                isDisabled={loading || seeding}
              >
                Apply changes
              </Button>
            </div>
          </Form>
        </Dialog>
      </Modal>
    </>
  );
}
