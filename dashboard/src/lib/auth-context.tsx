import type React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import {
  type DashboardProject,
  dashboardClient,
  type EpicSessionUser,
  type SessionResponse,
} from "./api";

interface DashboardAuthContextValue {
  loading: boolean;
  authenticated: boolean;
  user: EpicSessionUser | null;
  projects: DashboardProject[];
  selectedProject: DashboardProject | null;
  setSelectedProjectId: (id: string) => void;
  oauthConfigured: boolean;
  devAuthAvailable: boolean;
  refreshSession: () => Promise<void>;
  logout: () => Promise<void>;
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
  const [session, setSession] = useState<SessionResponse>({
    authenticated: false,
    user: null,
    projects: [],
    oauthConfigured: false,
    devAuthAvailable: false,
  });
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");

  const refreshSession = useCallback(async () => {
    try {
      const res = await dashboardClient.getSession();
      setSession(res);
      if (res.projects.length > 0) {
        setSelectedProjectId((prev) =>
          res.projects.some((p) => p.id === prev) ? prev : res.projects[0].id,
        );
      }
    } catch {
      setSession({
        authenticated: false,
        user: null,
        projects: [],
        oauthConfigured: false,
        devAuthAvailable: false,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const logout = useCallback(async () => {
    await dashboardClient.logout();
    setSession((prev) => ({
      ...prev,
      authenticated: false,
      user: null,
      projects: [],
    }));
  }, []);

  const selectedProject =
    session.projects.find((p) => p.id === selectedProjectId) ??
    session.projects[0] ??
    null;

  return (
    <DashboardAuthContext.Provider
      value={{
        loading,
        authenticated: session.authenticated,
        user: session.user,
        projects: session.projects,
        selectedProject,
        setSelectedProjectId,
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
