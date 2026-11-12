import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type DashboardProject,
  type DeveloperStatus,
  dashboardClient,
  type EpicSessionUser,
  type SessionResponse,
} from "./api";
import {
  clearVerificationToken,
  rememberVerificationLink,
} from "./email-verification";

interface DashboardAuthContextValue {
  loading: boolean;
  authenticated: boolean;
  isAdmin: boolean;
  analyticsScope: "project" | "all";
  setAnalyticsScope: (scope: "project" | "all") => void;
  user: EpicSessionUser | null;
  projects: DashboardProject[];
  selectedProject: DashboardProject | null;
  setSelectedProjectId: (id: string) => void;
  oauthConfigured: boolean;
  devAuthAvailable: boolean;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
  account: DeveloperStatus | null;
  sessionError: boolean;
}

const DashboardAuthContext = createContext<DashboardAuthContextValue | null>(
  null,
);

export function DashboardAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState(false);
  const [session, setSession] = useState<SessionResponse>({
    authenticated: false,
    isAdmin: false,
    user: null,
    projects: [],
    oauthConfigured: false,
    devAuthAvailable: false,
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [analyticsScope, setAnalyticsScope] = useState<"project" | "all">(
    "project",
  );
  const sessionGeneration = useRef(0);

  const refreshSession = useCallback(async () => {
    const generation = ++sessionGeneration.current;
    try {
      const res = await dashboardClient.getSession();
      if (generation !== sessionGeneration.current) return;
      setSession(res);
      setSessionError(false);
      if (res.account?.eligible === false)
        window.dispatchEvent(new Event("egdata:clear-credentials"));
      if (res.projects.length > 0) {
        setSelectedProjectId((prev) =>
          res.projects.some((p) => p.id === prev) ? prev : res.projects[0].id,
        );
      } else setSelectedProjectId("");
    } catch {
      if (generation !== sessionGeneration.current) return;
      setSession({
        authenticated: false,
        isAdmin: false,
        user: null,
        projects: [],
        oauthConfigured: false,
        devAuthAvailable: false,
      });
      setSessionError(true);
      window.dispatchEvent(new Event("egdata:clear-credentials"));
    } finally {
      if (generation === sessionGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    rememberVerificationLink();
    void refreshSession();
    const channel =
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel("egdata-account");
    const refresh = () => {
      void refreshSession();
    };
    const changed = () => {
      window.dispatchEvent(new Event("egdata:clear-credentials"));
      channel?.postMessage("changed");
      refresh();
    };
    if (channel)
      channel.onmessage = () => {
        window.dispatchEvent(new Event("egdata:clear-credentials"));
        refresh();
      };
    window.addEventListener("focus", refresh);
    window.addEventListener("egdata:account-changed", changed);
    return () => {
      channel?.close();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("egdata:account-changed", changed);
    };
  }, [refreshSession]);

  const logout = useCallback(async () => {
    ++sessionGeneration.current;
    window.dispatchEvent(new Event("egdata:clear-credentials"));
    await dashboardClient.logout();
    clearVerificationToken();
    ++sessionGeneration.current;
    setSelectedProjectId("");
    setAnalyticsScope("project");
    setSession((prev) => ({
      ...prev,
      authenticated: false,
      isAdmin: false,
      user: null,
      projects: [],
    }));
    window.dispatchEvent(new Event("egdata:account-changed"));
  }, []);

  const selectedProject =
    session.projects.find((p) => p.id === selectedProjectId) ??
    session.projects[0] ??
    null;

  return (
    <DashboardAuthContext.Provider
      value={{
        loading,
        account: session.account ?? null,
        sessionError,
        authenticated: session.authenticated,
        isAdmin: session.isAdmin,
        analyticsScope: session.isAdmin ? analyticsScope : "project",
        setAnalyticsScope,
        user: session.user,
        projects: session.projects,
        selectedProject,
        setSelectedProjectId: (id) => {
          setSelectedProjectId(id);
          setAnalyticsScope("project");
        },
        oauthConfigured: session.oauthConfigured,
        devAuthAvailable: session.devAuthAvailable,
        refreshSession,
        logout,
      }}
    >
      {children}
    </DashboardAuthContext.Provider>
  );
}

export function useDashboardAuth() {
  const ctx = useContext(DashboardAuthContext);
  if (!ctx) {
    throw new Error(
      "useDashboardAuth must be used inside DashboardAuthProvider",
    );
  }
  return ctx;
}
