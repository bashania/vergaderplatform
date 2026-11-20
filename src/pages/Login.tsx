import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { Brand, Field, Form } from "../ui";

function AuthShell({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  const { orgName } = useAuth();
  return (
    <div className="auth">
      <div className="auth-card">
        <span className="brand">
          <Brand orgName={orgName} />
        </span>
        <div className="stack" style={{ gap: 6 }}>
          <h1>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

function PasswordFields({ value, onChange }: { value: [string, string]; onChange: (v: [string, string]) => void }) {
  return (
    <>
      <Field label="Wachtwoord" hint="Minimaal 10 tekens. Een zin van een paar woorden werkt het best.">
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={value[0]}
          onChange={(e) => onChange([e.target.value, value[1]])}
        />
      </Field>
      <Field label="Herhaal wachtwoord">
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={value[1]}
          onChange={(e) => onChange([value[0], e.target.value])}
        />
      </Field>
    </>
  );
}

function checkSame([a, b]: [string, string]) {
  if (a !== b) throw new Error("De twee wachtwoorden zijn niet gelijk.");
}

export function LoginPage() {
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <AuthShell title="Inloggen" lead="Agenda's, stukken, besluiten en acties op één plek.">
      <Form
        submitLabel="Inloggen"
        onSubmit={async () => {
          await api("/api/login", { method: "POST", body: { email, password } });
          await refresh();
        }}
      >
        <Field label="E-mailadres">
          <input
            className="input"
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Wachtwoord">
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </Form>
      <p className="small muted">Wachtwoord vergeten of nog geen account? Vraag de beheerder om een nieuwe link.</p>
    </AuthShell>
  );
}

/** Eenmalig: de eerste beheerder richt het platform in met de installatiecode uit de link. */
export function SetupPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const fromLink = decodeURIComponent(window.location.hash.slice(1));
  const [code, setCode] = useState(fromLink);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [pw, setPw] = useState<[string, string]>(["", ""]);
  return (
    <AuthShell title="Platform inrichten" lead="Maak het eerste beheerdersaccount aan. Daarna nodig je de andere deelnemers uit.">
      <Form
        submitLabel="Account aanmaken"
        onSubmit={async () => {
          checkSame(pw);
          await api("/api/setup", { method: "POST", body: { code, name, email, orgName, password: pw[0] } });
          await refresh();
          navigate("/", { replace: true });
        }}
      >
        {!fromLink && (
          <Field label="Installatiecode" hint="De code die je bij de oplevering hebt gekregen.">
            <input className="input" required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <Field label="Naam organisatie (optioneel)" hint="Staat in het menu en op afgedrukte agenda's. Later te wijzigen.">
          <input className="input" maxLength={120} autoComplete="organization" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
        </Field>
        <Field label="Je naam">
          <input className="input" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="E-mailadres">
          <input className="input" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <PasswordFields value={pw} onChange={setPw} />
      </Form>
    </AuthShell>
  );
}

/** Landingspagina van een uitnodigings- of resetlink: /welkom#<token>. */
export function WelcomePage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const token = window.location.hash.slice(1);
  const [info, setInfo] = useState<{ purpose: "invite" | "reset"; name: string; email: string } | null>(null);
  const [error, setError] = useState("");
  const [pw, setPw] = useState<[string, string]>(["", ""]);

  useEffect(() => {
    if (!token) {
      setError("Deze link is onvolledig. Kopieer de hele link uit het bericht.");
      return;
    }
    api<{ purpose: "invite" | "reset"; name: string; email: string }>(`/api/tokens/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [token]);

  if (error) {
    return (
      <AuthShell title="Link werkt niet">
        <div className="form-error">{error}</div>
        <a className="btn secondary" href="/">
          Naar het inlogscherm
        </a>
      </AuthShell>
    );
  }
  if (!info) return <div className="splash">Laden…</div>;

  const invite = info.purpose === "invite";
  return (
    <AuthShell
      title={invite ? `Welkom, ${info.name}` : "Nieuw wachtwoord"}
      lead={
        invite ? (
          <>
            Kies een wachtwoord voor <strong>{info.email}</strong>. Daarna kun je direct bij de agenda's en stukken.
          </>
        ) : (
          <>
            Kies een nieuw wachtwoord voor <strong>{info.email}</strong>.
          </>
        )
      }
    >
      <Form
        submitLabel={invite ? "Account activeren" : "Wachtwoord opslaan"}
        onSubmit={async () => {
          checkSame(pw);
          await api(`/api/tokens/${encodeURIComponent(token)}`, { method: "POST", body: { password: pw[0] } });
          await refresh();
          navigate("/", { replace: true });
        }}
      >
        <PasswordFields value={pw} onChange={setPw} />
      </Form>
    </AuthShell>
  );
}
