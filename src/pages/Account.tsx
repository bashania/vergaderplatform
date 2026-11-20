import { useState } from "react";
import { api } from "../api";
import { useAuth, useUser } from "../auth";
import { PasskeyButton } from "../components/PasskeyButton";
import { PlaudCard } from "../components/Transcript";
import { fmtDateTime } from "../lib";
import { addPasskey, deviceName, passkeysSupported } from "../passkeys";
import { Button, Empty, Field, Form, Loader, useLoad, useRun, useToast } from "../ui";

type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

function Passkeys() {
  const user = useUser();
  const { refresh } = useAuth();
  const run = useRun();
  const toast = useToast();
  const { data, loading, error, reload } = useLoad<{ passkeys: Passkey[] }>("/api/account/passkeys");
  const [name, setName] = useState(deviceName);
  const list = data?.passkeys ?? [];
  // Een extra passkey toevoegen kan alleen als je met een passkey bent ingelogd.
  const mayAdd = list.length === 0 || user.strong;

  const changed = async () => {
    await refresh();
    await reload();
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">Passkeys</h2>
        {user.strong ? <span className="badge accent">Ingelogd met passkey</span> : <span className="badge">Ingelogd met wachtwoord</span>}
      </div>
      <Loader loading={loading} error={error}>
        {list.length ? (
          <ul className="list">
            {list.map((p) => (
              <li key={p.id} style={{ alignItems: "center" }}>
                <div className="grow">
                  <strong>{p.name}</strong>
                  <div className="meta">
                    <span>Aangemaakt {fmtDateTime(p.createdAt)}</span>
                    <span>{p.lastUsedAt ? `Laatst gebruikt ${fmtDateTime(p.lastUsedAt)}` : "Nog niet gebruikt om in te loggen"}</span>
                  </div>
                </div>
                {user.strong && (
                  <Button
                    variant="danger"
                    small
                    onClick={async () => {
                      if (!window.confirm(`Passkey "${p.name}" verwijderen? Inloggen met dat apparaat kan daarna niet meer.`)) return;
                      if (await run(() => api(`/api/account/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }), "Passkey verwijderd")) await changed();
                    }}
                  >
                    Verwijderen
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="Nog geen passkey">
            Met een passkey log je in met je vingerafdruk, gezicht of de pincode van je apparaat. Geen wachtwoord nodig, en het telt als tweestapsverificatie.
          </Empty>
        )}
        <div className="card-body stack" style={{ borderTop: "1px solid var(--line)" }}>
          {!passkeysSupported() ? (
            <div className="notice warm">Deze browser ondersteunt geen passkeys. Gebruik een recente versie van Chrome, Edge, Safari of Firefox.</div>
          ) : mayAdd ? (
            <>
              <Field label="Naam van dit apparaat" hint="Zo herken je later welke passkey bij welk apparaat hoort.">
                <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <div>
                <PasskeyButton
                  run={() => addPasskey(name.trim() || deviceName())}
                  onDone={async () => {
                    await changed();
                    toast("Passkey aangemaakt");
                  }}
                >
                  {list.length ? "Passkey toevoegen voor dit apparaat" : "Passkey aanmaken"}
                </PasskeyButton>
              </div>
              <p className="small muted">
                Maak op elk apparaat waarmee je wilt inloggen een eigen passkey, of bewaar hem in een wachtwoordbeheerder die op al je apparaten werkt. Raak
                je al je apparaten kwijt, dan kan de platformbeheerder je passkeys wissen en je een nieuwe link sturen.
              </p>
            </>
          ) : (
            <div className="notice">Je bent nu met je wachtwoord ingelogd. Log in met een bestaande passkey om er een toe te voegen of te verwijderen.</div>
          )}
        </div>
      </Loader>
    </section>
  );
}

function Password() {
  const user = useUser();
  const { refresh } = useAuth();
  const run = useRun();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");

  // Zonder wachtwoord én zonder passkey-sessie valt er niets in te stellen.
  if (!user.hasPassword && !user.strong) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="section-title">{user.hasPassword ? "Wachtwoord wijzigen" : "Wachtwoord instellen"}</h2>
        {!user.hasPassword && <span className="badge accent">Alleen passkey</span>}
      </div>
      <div className="card-body stack">
        {!user.hasPassword && (
          <p className="muted">Je logt alleen in met een passkey. Dat is de veiligste opzet; een wachtwoord is niet nodig.</p>
        )}
        <Form
          submitLabel={user.hasPassword ? "Wachtwoord wijzigen" : "Wachtwoord instellen"}
          onSubmit={async () => {
            if (password !== repeat) throw new Error("De twee nieuwe wachtwoorden zijn niet gelijk.");
            await api("/api/account/password", { method: "POST", body: { current, password } });
            setCurrent("");
            setPassword("");
            setRepeat("");
            await refresh();
            toast("Wachtwoord opgeslagen. Andere apparaten zijn uitgelogd.");
          }}
        >
          {user.hasPassword && (
            <Field label="Huidig wachtwoord">
              <input className="input" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
          )}
          <Field label="Nieuw wachtwoord" hint="Minimaal 10 tekens.">
            <input className="input" type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Herhaal nieuw wachtwoord">
            <input className="input" type="password" required autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </Field>
        </Form>
        {user.hasPassword && user.strong && user.passkeys > 0 && (
          <div className="spread" style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
            <span className="small muted">Log je altijd met een passkey in? Dan kan het wachtwoord weg; er valt dan niets meer te raden of te lekken.</span>
            <Button
              variant="danger"
              small
              onClick={async () => {
                if (!window.confirm("Wachtwoord verwijderen? Je logt daarna alleen nog in met een passkey.")) return;
                if (await run(() => api("/api/account/password", { method: "DELETE" }), "Wachtwoord verwijderd")) await refresh();
              }}
            >
              Wachtwoord verwijderen
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

export default function AccountPage() {
  const user = useUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.name);

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Mijn account</h1>
          <p className="lead">{user.email}</p>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Naam</h2>
        </div>
        <div className="card-body">
          <Form
            onSubmit={async () => {
              await api("/api/account", { method: "PATCH", body: { name } });
              await refresh();
              toast("Naam opgeslagen");
            }}
          >
            <Field label="Naam" hint="Zo sta je op de presentielijst en bij je acties.">
              <input className="input" required maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </Form>
        </div>
      </section>

      <Passkeys />
      <Password />
      <PlaudCard />
    </div>
  );
}
