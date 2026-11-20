import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, setApiOrganisation } from "./api";
import type { Organisation, User } from "./lib";

type Session = { user: User | null; orgName: string; setupNeeded: boolean; organisations: Organisation[] };
type AuthValue = Session & {
  loading: boolean;
  /** De organisatie waarin de gebruiker nu werkt. */
  org: Organisation | null;
  /** Wissel van organisatie (bewuste keuze van de gebruiker). */
  selectOrg: (id: string) => void;
  /** Zorg dat de actieve organisatie die van de geopende pagina is (bij een directe link). */
  ensureOrg: (id: string) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);
const STORAGE_KEY = "vp.organisatie";

function stored(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("AuthProvider ontbreekt");
  return v;
}

/** Binnen de ingelogde schermen is er altijd een gebruiker. */
export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error("Niet ingelogd");
  return user;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>({ user: null, orgName: "", setupNeeded: false, organisations: [] });
  const [loading, setLoading] = useState(true);
  const [orgId, setOrgId] = useState<string | null>(stored);

  // De onthouden keuze geldt alleen zolang de gebruiker er nog toegang toe heeft.
  const org = session.organisations.find((o) => o.id === orgId) ?? session.organisations[0] ?? null;
  // Tijdens het renderen zetten: de pagina's eronder halen hun gegevens op vóór effecten van dit onderdeel lopen.
  setApiOrganisation(org?.id ?? null);

  const selectOrg = useCallback((id: string) => {
    setOrgId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Zonder opslag geldt de keuze alleen voor dit bezoek.
    }
  }, []);

  const ensureOrg = useCallback(
    (id: string) => {
      if (org?.id !== id && session.organisations.some((o) => o.id === id)) selectOrg(id);
    },
    [org?.id, session.organisations, selectOrg],
  );

  const refresh = useCallback(async () => {
    try {
      const s = await api<Session>("/api/session");
      setSession({ ...s, organisations: s.organisations ?? [] });
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    setSession((s) => ({ ...s, user: null, organisations: [] }));
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setSession((s) => ({ ...s, user: null, organisations: [] }));
    window.addEventListener("vp:unauthorized", onUnauthorized);
    return () => window.removeEventListener("vp:unauthorized", onUnauthorized);
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ ...session, loading, org, selectOrg, ensureOrg, refresh, logout }}>{children}</AuthContext.Provider>
  );
}
