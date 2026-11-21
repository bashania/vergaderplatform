import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth, useUser } from "./auth";
import { PasskeyButton } from "./components/PasskeyButton";
import { addPasskey, deviceName, loginWithPasskey, passkeysSupported } from "./passkeys";
import { Brand, Button, Empty, Icon, type IconName } from "./ui";

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Overzicht", icon: "home", end: true },
  { to: "/overleggen", label: "Overleggen", icon: "users" },
  { to: "/besluiten", label: "Besluiten", icon: "decision" },
  { to: "/acties", label: "Acties", icon: "tasks" },
];

export default function Layout() {
  const user = useUser();
  const { logout, orgName, org, organisations, selectOrg, systemIssues } = useAuth();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const location = useLocation();
  const navigate = useNavigate();

  // Menu dicht en naar boven bij elke navigatie.
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [location.pathname]);

  function search(e: FormEvent) {
    e.preventDefault();
    const q = term.trim();
    if (q.length >= 2) {
      navigate(`/zoeken?q=${encodeURIComponent(q)}`);
      setOpen(false);
    }
  }

  // Bewust wisselen van organisatie: terug naar het overzicht, zodat er niets
  // van de vorige organisatie in beeld blijft staan.
  function switchOrganisation(id: string) {
    selectOrg(id);
    setTerm("");
    navigate("/");
    setOpen(false);
  }

  return (
    <div className={`shell ${open ? "menu-open" : ""}`}>
      <header className="topbar">
        <img src="/favicon.svg" alt="" />
        <strong>{org?.name ?? "Vergaderplatform"}</strong>
        <Button variant="ghost" icon="menu" aria-label="Menu openen" onClick={() => setOpen(true)} />
      </header>
      <div className="scrim" onClick={() => setOpen(false)} />

      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="Naar het overzicht">
          <Brand orgName={orgName} />
        </Link>

        {org && (
          <div className="orgswitch">
            <label className="nav-label" htmlFor="organisatie">
              Organisatie
            </label>
            {organisations.length > 1 ? (
              <select id="organisatie" value={org.id} onChange={(e) => switchOrganisation(e.target.value)}>
                {organisations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : (
              <div id="organisatie" className="orgname">
                {org.name}
              </div>
            )}
          </div>
        )}

        {org && (
          <form className="search" role="search" onSubmit={search}>
            <Icon name="search" size={16} />
            <input className="input" type="search" placeholder="Zoeken" aria-label={`Zoeken in ${org.name}`} value={term} onChange={(e) => setTerm(e.target.value)} />
          </form>
        )}

        <nav className="nav" aria-label="Hoofdmenu">
          {org &&
            NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                <Icon name={n.icon} />
                {n.label}
              </NavLink>
            ))}
          {org?.role === "beheerder" && (
            <NavLink to="/inzicht">
              <Icon name="chart" />
              Inzicht
            </NavLink>
          )}
          {org?.role === "beheerder" && (
            <NavLink to="/organisatie">
              <Icon name="lock" />
              Toegang en beheer
            </NavLink>
          )}
          <NavLink to="/uitleg">
            <Icon name="help" />
            Uitleg
          </NavLink>
          {user.isAdmin && (
            <>
              <div className="nav-label">Platform</div>
              <NavLink to="/beheer">
                <Icon name="settings" />
                Platformbeheer
                {!!systemIssues?.length && <span className="nav-dot" role="img" aria-label={`Werkt niet: ${systemIssues.join(", ")}`} title={`Werkt niet: ${systemIssues.join(", ")}`} />}
              </NavLink>
            </>
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="who">
            {user.name}
            <span>{user.email}</span>
          </div>
          <nav className="nav" aria-label="Account">
            <NavLink to="/account">
              <Icon name="user" />
              Mijn account
            </NavLink>
          </nav>
          <Button variant="ghost" icon="logout" onClick={() => void logout()}>
            Uitloggen
          </Button>
        </div>
      </aside>

      {/* Bij wisselen van organisatie laden alle pagina's opnieuw. */}
      <main className="main" key={org?.id ?? "geen"}>
        <Outlet />
      </main>
    </div>
  );
}

/** Pagina's die binnen een organisatie vallen. Zonder organisatie valt er niets te tonen. */
/** Een organisatie die een passkey eist, terwijl deze sessie met een wachtwoord is ingelogd. */
function PasskeyGate({ organisation }: { organisation: string }) {
  const user = useUser();
  const { refresh } = useAuth();
  // De eis kan intussen zijn ingetrokken: controleer de actuele stand zodra de blokkade verschijnt.
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Passkey nodig</h1>
          <p className="lead">
            <strong>{organisation}</strong> is extra beveiligd: je komt er alleen in als je met een passkey bent ingelogd. Je bent nu met je wachtwoord ingelogd.
          </p>
        </div>
      </div>
      <div className="card">
        <div className="card-body stack">
          {!passkeysSupported() ? (
            <div className="notice warm">Deze browser ondersteunt geen passkeys. Gebruik een recente versie van Chrome, Edge, Safari of Firefox.</div>
          ) : user.passkeys > 0 ? (
            <>
              <p>Log opnieuw in met je passkey. Dat gaat met je vingerafdruk, gezicht of de pincode van je apparaat.</p>
              <div>
                <PasskeyButton run={loginWithPasskey} onDone={refresh}>
                  Inloggen met passkey
                </PasskeyButton>
              </div>
            </>
          ) : (
            <>
              <p>
                Je hebt nog geen passkey. Maak er nu een aan op dit apparaat: daarna log je in met je vingerafdruk, gezicht of pincode, zonder wachtwoord.
              </p>
              <div>
                <PasskeyButton run={() => addPasskey(deviceName())} onDone={refresh}>
                  Passkey aanmaken
                </PasskeyButton>
              </div>
            </>
          )}
          <p className="small muted">Andere organisaties blijven bereikbaar via de organisatiekiezer in het menu.</p>
        </div>
      </div>
    </div>
  );
}

export function RequireOrganisation() {
  const user = useUser();
  const { org } = useAuth();
  if (org?.requirePasskey && !user.strong) return <PasskeyGate organisation={org.name} />;
  if (org) return <Outlet />;
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>Nog geen organisatie</h1>
        </div>
      </div>
      <div className="card">
        {user.isAdmin ? (
          <Empty title="Maak eerst een organisatie aan">
            Elke organisatie is een eigen omgeving met eigen overleggen en deelnemers. Ga naar <Link to="/beheer">Platformbeheer</Link>.
          </Empty>
        ) : (
          <Empty title="Je hebt nog geen toegang tot een organisatie">
            Vraag de secretaris of beheerder van je overleg om je toe te voegen. Daarna staat het hier.
          </Empty>
        )}
      </div>
    </div>
  );
}
