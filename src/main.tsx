import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-600.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import Layout, { RequireOrganisation } from "./Layout";
import AccountPage from "./pages/Account";
import ActiesPage from "./pages/Acties";
import BeheerPage from "./pages/Beheer";
import BesluitenPage from "./pages/Besluiten";
import DashboardPage from "./pages/Dashboard";
import { LoginPage, SetupPage, WelcomePage } from "./pages/Login";
import MeetingPage from "./pages/Meeting";
import OrganisatiePage from "./pages/Organisatie";
import OverlegPage from "./pages/Overleg";
import OverleggenPage from "./pages/Overleggen";
import ZoekenPage from "./pages/Zoeken";
import { ToastProvider } from "./ui";

function NotFound() {
  return (
    <div className="page narrow">
      <h1>Pagina niet gevonden</h1>
      <p className="lead">Deze pagina bestaat niet (meer), of je hebt er geen toegang toe.</p>
    </div>
  );
}

function App() {
  const { user, loading, setupNeeded } = useAuth();
  if (loading) return <div className="splash">Laden…</div>;
  return (
    <Routes>
      {/* Uitnodigings- en resetlinks werken altijd, ook als er iemand anders is ingelogd. */}
      <Route path="/welkom" element={<WelcomePage />} />
      {user ? (
        <Route element={<Layout />}>
          <Route element={<RequireOrganisation />}>
            <Route index element={<DashboardPage />} />
            <Route path="overleggen" element={<OverleggenPage />} />
            <Route path="overleggen/:id" element={<OverlegPage />} />
            <Route path="vergaderingen/:id" element={<MeetingPage />} />
            <Route path="besluiten" element={<BesluitenPage />} />
            <Route path="acties" element={<ActiesPage />} />
            <Route path="zoeken" element={<ZoekenPage />} />
            <Route path="organisatie" element={<OrganisatiePage />} />
          </Route>
          <Route path="account" element={<AccountPage />} />
          {user.isAdmin && <Route path="beheer" element={<BeheerPage />} />}
          <Route path="*" element={<NotFound />} />
        </Route>
      ) : (
        // Niet ingelogd: elke link toont het inlogscherm; na inloggen staat de gevraagde pagina er.
        <Route path="*" element={setupNeeded ? <SetupPage /> : <LoginPage />} />
      )}
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
