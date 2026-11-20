import { useState } from "react";
import { api } from "../api";
import { useAuth, useUser } from "../auth";
import { Field, Form, useToast } from "../ui";

export default function AccountPage() {
  const user = useUser();
  const { refresh } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");

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

      <section className="card">
        <div className="card-head">
          <h2 className="section-title">Wachtwoord wijzigen</h2>
        </div>
        <div className="card-body">
          <Form
            submitLabel="Wachtwoord wijzigen"
            onSubmit={async () => {
              if (password !== repeat) throw new Error("De twee nieuwe wachtwoorden zijn niet gelijk.");
              await api("/api/account/password", { method: "POST", body: { current, password } });
              setCurrent("");
              setPassword("");
              setRepeat("");
              toast("Wachtwoord gewijzigd. Andere apparaten zijn uitgelogd.");
            }}
          >
            <Field label="Huidig wachtwoord">
              <input className="input" type="password" required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="Nieuw wachtwoord" hint="Minimaal 10 tekens.">
              <input className="input" type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="Herhaal nieuw wachtwoord">
              <input className="input" type="password" required autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            </Field>
          </Form>
        </div>
      </section>
    </div>
  );
}
