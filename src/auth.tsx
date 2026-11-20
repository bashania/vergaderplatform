import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { User } from "./lib";

type Session = { user: User | null; orgName: string; setupNeeded: boolean };
type AuthValue = Session & { loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> };

const AuthContext = createContext<AuthValue | null>(null);

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
  const [session, setSession] = useState<Session>({ user: null, orgName: "", setupNeeded: false });
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSession(await api<Session>("/api/session"));
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    setSession((s) => ({ ...s, user: null }));
  }, []);

  useEffect(() => {
    void refresh();
    const onUnauthorized = () => setSession((s) => ({ ...s, user: null }));
    window.addEventListener("vp:unauthorized", onUnauthorized);
    return () => window.removeEventListener("vp:unauthorized", onUnauthorized);
  }, [refresh]);

  return <AuthContext.Provider value={{ ...session, loading, refresh, logout }}>{children}</AuthContext.Provider>;
}
