import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { BRAND } from "../../shared/brand";

/** Schermen zonder menu krijgen hun soort voor de titel, zodat de tabbladen uit elkaar te houden zijn. */
const PREFIX: [RegExp, string][] = [
  [/\/live$/, "Vergadermodus"],
  [/\/scherm$/, "Presentatiescherm"],
];

/**
 * Geeft elk scherm een eigen titel in het tabblad en zegt een wissel van scherm aan voor wie een
 * schermlezer gebruikt. De titel komt uit de kop van het scherm (h1, of het kenmerk data-title daarop),
 * zodat een nieuw scherm vanzelf meedoet en niemand eraan hoeft te denken.
 */
export function PageTitle() {
  const { pathname } = useLocation();
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    const prefix = PREFIX.find(([pattern]) => pattern.test(pathname))?.[1];
    let last = document.title;
    const update = () => {
      const h1 = document.querySelector("h1");
      const heading = (h1?.getAttribute("data-title") ?? h1?.textContent ?? "").replace(/\s+/g, " ").trim();
      const page = [prefix, heading].filter(Boolean).join(": ");
      const title = page ? `${page} · ${BRAND}` : BRAND;
      if (title === last) return;
      last = title;
      document.title = title;
      if (page) setAnnounce(page);
    };
    update();
    // De kop verschijnt of verandert vaak pas als de gegevens binnen zijn.
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {announce}
    </div>
  );
}
