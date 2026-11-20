import { dateOnly, HttpError } from "../http";
import { connection, disconnect, finishConnect, listRecordings, plaudAvailable, startConnect } from "../plaud";
import { route, type Ctx } from "../router";

/** Het adres waar Plaud de gebruiker na het geven van toestemming naar terugstuurt. */
export const plaudRedirectUri = (c: Ctx) => `${c.url.origin}/api/plaud/callback`;

route.get("/api/plaud", async (c) => {
  const row = plaudAvailable() ? await connection(c.user.id) : null;
  return { available: plaudAvailable(), connected: !!row, connectedAt: row?.connectedAt ?? null };
});

route.post("/api/plaud/connect", async (c) => {
  try {
    return { url: await startConnect(c.user.id, plaudRedirectUri(c)) };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    // De technische melding erbij: dit is het punt waar een wijziging aan de kant van Plaud zichtbaar wordt.
    console.error("plaud connect", e);
    throw new HttpError(502, `Koppelen met Plaud lukt nu niet. (${e instanceof Error ? e.message.slice(0, 200) : "onbekende fout"})`);
  }
});

/**
 * Terugkeer vanaf Plaud. Publiek, omdat een verlopen sessie hier een nette melding moet geven in plaats
 * van een foutpagina; de poging zelf is gebonden aan de gebruiker die haar startte en aan een eenmalige code.
 */
route.get(
  "/api/plaud/callback",
  async (c) => {
    const back = (result: string) => new Response(null, { status: 302, headers: { location: `/account?plaud=${result}`, "cache-control": "no-store" } });
    const code = c.url.searchParams.get("code");
    const state = c.url.searchParams.get("state");
    if (!c.user || !code || !state) return back(c.url.searchParams.get("error") === "access_denied" ? "geweigerd" : "mislukt");
    try {
      return back((await finishConnect(c.user.id, state, code)) ? "gekoppeld" : "mislukt");
    } catch (e) {
      console.error("plaud callback", e);
      return back("mislukt");
    }
  },
  { public: true },
);

route.delete("/api/plaud", async (c) => {
  await disconnect(c.user.id);
  return { ok: true };
});

/** Opnames van de gebruiker rond een datum, om er één bij een vergadering te kiezen. */
route.get("/api/plaud/recordings", async (c) => {
  const from = dateOnly(c.url.searchParams.get("from"), "Vanaf");
  const to = dateOnly(c.url.searchParams.get("to"), "Tot en met");
  return { recordings: await listRecordings(c.user.id, plaudRedirectUri(c), from, to) };
});
