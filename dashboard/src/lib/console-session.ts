import { useCallback, useEffect, useRef, useState } from "react";

export type ConsoleSession = {
  token: string;
  expiresAt: number;
  projectId: string;
};

export function useConsoleSession(projectId: string | undefined) {
  const [session, setSession] = useState<ConsoleSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const token = useRef("");
  const end = useCallback(() => {
    generation.current++;
    pending.current?.abort();
    setSession(null);
    setBusy(false);
    if (projectId && token.current) {
      void fetch(
        `/_dashboard/api/console-sessions/${encodeURIComponent(projectId)}`,
        {
          method: "DELETE",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: token.current }),
        },
      ).catch(() => {});
    }
    token.current = "";
  }, [projectId]);

  useEffect(() => {
    window.addEventListener("egdata:clear-credentials", end);
    return () => {
      end();
      window.removeEventListener("egdata:clear-credentials", end);
    };
  }, [end]);
  useEffect(() => {
    if (!session) return;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      if (current >= session.expiresAt) end();
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [session, end]);

  async function start() {
    if (!projectId || busy) return;
    const current = ++generation.current;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/_dashboard/api/console-sessions/${encodeURIComponent(projectId)}`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        },
      );
      const body = (await response.json()) as ConsoleSession & {
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(
          body.error?.message ?? "Unable to start console session.",
        );
      if (
        body.projectId !== projectId ||
        typeof body.token !== "string" ||
        !/^egc_[a-f0-9]{64}$/.test(body.token) ||
        !Number.isFinite(body.expiresAt)
      ) {
        throw new Error("Invalid console session response.");
      }
      if (current !== generation.current) return;
      token.current = body.token;
      setNow(Date.now());
      setSession(body);
    } catch (e) {
      if (!controller.signal.aborted && current === generation.current) {
        setError(
          e instanceof Error ? e.message : "Unable to start console session.",
        );
      }
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  const remaining = session
    ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000))
    : 0;
  return { session, remaining, busy, error, start, end };
}
