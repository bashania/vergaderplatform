import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, errorText } from "./api";

// ---------- iconen (lijntekeningen, 24x24) ----------

const ICONS = {
  home: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  decision: '<circle cx="12" cy="12" r="10"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  tasks: '<path d="M10 6h11M10 12h11M10 18h11M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  menu: '<path d="M3 12h18M3 6h18M3 18h18"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  printer:
    '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  video: '<path d="m22 8-6 4 6 4V8Z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

/** Beeldmerk met productnaam en (instelbare) organisatienaam. */
export function Brand({ orgName }: { orgName?: string }) {
  return (
    <>
      <img src="/favicon.svg" alt="" width="36" height="36" />
      <span>
        <strong>Vergaderplatform</strong>
        {orgName && <small>{orgName}</small>}
      </span>
    </>
  );
}

// ---------- knoppen ----------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  small?: boolean;
  icon?: IconName;
  busy?: boolean;
};

export function Button({ variant = "primary", small, icon, busy, children, className, disabled, type, ...rest }: ButtonProps) {
  const cls = ["btn", variant !== "primary" && variant, small && "small", !children && "icon", className].filter(Boolean).join(" ");
  return (
    <button type={type ?? "button"} className={cls} disabled={disabled || busy} {...rest}>
      {icon && <Icon name={icon} size={small ? 15 : 17} />}
      {children}
    </button>
  );
}

// ---------- gegevens laden ----------

export function useLoad<T>(path: string | null) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: !!path });
  const current = useRef(path);
  current.current = path;

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const data = await api<T>(path);
      if (current.current === path) setState({ data, loading: false });
    } catch (e) {
      if (current.current === path) setState((s) => ({ ...s, error: errorText(e), loading: false }));
    }
  }, [path]);

  useEffect(() => {
    setState({ loading: !!path });
    void reload();
  }, [path, reload]);

  return { ...state, reload };
}

/** Standaardweergave voor laden en fouten rond een pagina-inhoud. */
export function Loader({ loading, error, children }: { loading: boolean; error?: string; children: ReactNode }) {
  if (error) return <div className="form-error">{error}</div>;
  if (loading) return <p className="muted">Laden…</p>;
  return <>{children}</>;
}

// ---------- meldingen ----------

type ToastFn = (message: string, kind?: "ok" | "error") => void;
const ToastContext = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error"; key: number } | null>(null);
  const show = useCallback<ToastFn>((message, kind = "ok") => setToast({ message, kind, key: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "error" ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast no-print ${toast.kind === "error" ? "error" : ""}`} role="status">
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

/** Voert een actie uit en toont een foutmelding als die mislukt. */
export function useRun() {
  const toast = useToast();
  return useCallback(
    async (fn: () => Promise<unknown>, okMessage?: string): Promise<boolean> => {
      try {
        await fn();
        if (okMessage) toast(okMessage);
        return true;
      } catch (e) {
        toast(errorText(e), "error");
        return false;
      }
    },
    [toast],
  );
}

// ---------- venster en formulier ----------

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <Button variant="ghost" icon="x" aria-label="Sluiten" onClick={onClose} />
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

/** Formulier met foutmelding en bezig-status; onSubmit gooit een fout als opslaan mislukt. */
export function Form({
  onSubmit,
  submitLabel = "Opslaan",
  onCancel,
  children,
  extra,
}: {
  onSubmit: () => Promise<void>;
  submitLabel?: string;
  onCancel?: () => void;
  children: ReactNode;
  extra?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={submit}>
      {children}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="form-foot">
        {extra}
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Annuleren
          </Button>
        )}
        <Button type="submit" busy={busy}>
          {busy ? "Bezig…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/** Link met kopieerknop: voor uitnodigings- en resetlinks. */
export function CopyBox({ value }: { value: string }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast("Link gekopieerd");
    } catch {
      ref.current?.select();
      toast("Selecteer de link en kopieer met Ctrl+C", "error");
    }
  }
  return (
    <div className="linkbox">
      <input ref={ref} className="input" readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label="Link" />
      <Button variant="secondary" icon="copy" onClick={copy}>
        Kopieer
      </Button>
    </div>
  );
}
