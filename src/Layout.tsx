import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth, useUser } from "./auth";
import { Brand, Button, Icon, type IconName } from "./ui";

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "Overzicht", icon: "home", end: true },
  { to: "/overleggen", label: "Overleggen", icon: "users" },
  { to: "/besluiten", label: "Besluiten", icon: "decision" },
  { to: "/acties", label: "Acties", icon: "tasks" },
];

export default function Layout() {
  const user = useUser();
  const { logout, orgName } = useAuth();
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

  return (
    <div className={`shell ${open ? "menu-open" : ""}`}>
      <header className="topbar">
        <img src="/favicon.svg" alt="" />
        <strong>Vergaderplatform</strong>
        <Button variant="ghost" icon="menu" aria-label="Menu openen" onClick={() => setOpen(true)} />
      </header>
      <div className="scrim" onClick={() => setOpen(false)} />

      <aside className="sidebar">
        <Link to="/" className="brand" aria-label="Naar het overzicht">
          <Brand orgName={orgName} />
        </Link>

        <form className="search" role="search" onSubmit={search}>
          <Icon name="search" size={16} />
          <input
            className="input"
            type="search"
            placeholder="Zoeken"
            aria-label="Zoeken"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </form>

        <nav className="nav" aria-label="Hoofdmenu">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              <Icon name={n.icon} />
              {n.label}
            </NavLink>
          ))}
          {user.isAdmin && (
            <>
              <div className="nav-label">Beheerder</div>
              <NavLink to="/beheer">
                <Icon name="settings" />
                Beheer
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

      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
