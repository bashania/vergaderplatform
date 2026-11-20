import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { PasskeyButton } from "../components/PasskeyButton";
import { acceptInviteWithPasskey, deviceName, loginWithPasskey, passkeysSupported } from "../passkeys";
import { Brand, Button, Field, Form } from "../ui";

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
      {passkeysSupported() && (
        <>
          <PasskeyButton run={loginWithPasskey} onDone={refresh}>
            Inloggen met passkey
          </PasskeyButton>
          <div className="divider">of met je wachtwoord</div>
        </>
      )}
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
      <p className="small muted">Wachtwoord vergeten, apparaat kwijt of nog geen account? Vraag de beheerder om een nieuwe link.</p>
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
          await api("/api/setup", { method: "POST", body: { code, name, email, organisation: orgName, password: pw[0] } });
          await refresh();
          navigate("/", { replace: true });
        }}
      >
        {!fromLink && (
          <Field label="Installatiecode" hint="De code die je bij de oplevering hebt gekregen.">
            <input className="input" required value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <Field label="Je naam">
          <input className="input" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="E-mailadres">
          <input className="input" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <PasswordFields value={pw} onChange={setPw} />
        <Field
          label="Naam van je eerste organisatie"
          hint="Bijvoorbeeld de commissie, de school of het bedrijf waarvoor je vergadert. Meer organisaties voeg je later toe; elke organisatie is een eigen omgeving."
        >
          <input className="input" required maxLength={120} autoComplete="organization" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
        </Field>
      </Form>
    </AuthShell>
  );
}

/** Landingspagina van een uitnodigings- of resetlink: /welkom#<token>. */
export function WelcomePage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const token = window.location.hash.slice(1);
  type Info = { purpose: "invite" | "reset"; name: string; email: string; canUsePasskey: boolean };
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [pw, setPw] = useState<[string, string]>(["", ""]);
  const [withPassword, setWithPassword] = useState(false);

  useEffect(() => {
    if (!token) {
      setError("Deze link is onvolledig. Kopieer de hele link uit het bericht.");
      return;
    }
    api<Info>(`/api/tokens/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [token]);

  const done = async () => {
    await refresh();
    navigate("/", { replace: true });
  };

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
  // Een passkey is de makkelijkste en veiligste keuze; een wachtwoord blijft mogelijk.
  const offerPasskey = info.canUsePasskey && passkeysSupported();
  const passkeyFirst = offerPasskey && !withPassword;
  return (
    <AuthShell
      title={invite ? `Welkom, ${info.name}` : "Opnieuw toegang"}
      lead={
        <>
          {invite ? "Activeer je account voor " : "Kies hoe je voortaan inlogt met "}
          <strong>{info.email}</strong>.{invite ? " Daarna kun je direct bij de agenda's en stukken." : ""}
        </>
      }
    >
      {passkeyFirst ? (
        <>
          <PasskeyButton run={() => acceptInviteWithPasskey(token, deviceName())} onDone={done}>
            Passkey aanmaken
          </PasskeyButton>
          <p className="small muted">
            Met een passkey log je in met je vingerafdruk, gezicht of de pincode van dit apparaat. Je hoeft geen wachtwoord te onthouden en het kan niet
            worden afgekeken of gelekt.
          </p>
          <Button variant="ghost" onClick={() => setWithPassword(true)}>
            Liever een wachtwoord kiezen
          </Button>
        </>
      ) : (
        <>
          <Form
            submitLabel={invite ? "Account activeren" : "Wachtwoord opslaan"}
            onSubmit={async () => {
              checkSame(pw);
              await api(`/api/tokens/${encodeURIComponent(token)}`, { method: "POST", body: { password: pw[0] } });
              await done();
            }}
          >
            <PasswordFields value={pw} onChange={setPw} />
          </Form>
          {offerPasskey && (
            <Button variant="ghost" onClick={() => setWithPassword(false)}>
              Toch een passkey gebruiken
            </Button>
          )}
        </>
      )}
    </AuthShell>
  );
}
