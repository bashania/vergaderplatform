import type { Context } from "@netlify/functions";
import { sessionCookie, userFromRequest, type User } from "./auth";
import { q } from "./db";
import { setDeployContext } from "./files";
import { bad, forbidden, HttpError, json } from "./http";

export type Ctx = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  /** Ingelogde gebruiker. Bij publieke routes kan dit null zijn. */
  user: User;
  ip: string;
  /** De organisatie waarin de gebruiker werkt (header x-organisation), of null. */
  orgId: string | null;
  /** De gekozen organisatie eist een passkey en deze sessie is daar niet mee ingelogd. */
  orgLocked: boolean;
  /** Regio waarin de functie draait (bijv. "fra"). */
  serverRegion: string;
  /** Body als JSON-object. */
  body: () => Promise<Record<string, unknown>>;
  /** Zet (token) of wis (null) de sessiecookie in het antwoord. */
  setSession: (token: string | null) => void;
};

type Handler = (c: Ctx) => Promise<unknown>;
type Opts = { public?: boolean; admin?: boolean; audit?: boolean };
type Route = { method: string; pattern: string; re: RegExp; keys: string[]; handler: Handler; opts: Opts };

const routes: Route[] = [];

function add(method: string, pattern: string, handler: Handler, opts: Opts = {}) {
  const keys: string[] = [];
  const source = pattern.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
    keys.push(k);
    return "([^/]+)";
  });
  routes.push({ method, pattern, re: new RegExp(`^${source}/?$`), keys, handler, opts });
}

export const route = {
  get: (p: string, h: Handler, o?: Opts) => add("GET", p, h, o),
  post: (p: string, h: Handler, o?: Opts) => add("POST", p, h, o),
  put: (p: string, h: Handler, o?: Opts) => add("PUT", p, h, o),
  patch: (p: string, h: Handler, o?: Opts) => add("PATCH", p, h, o),
  delete: (p: string, h: Handler, o?: Opts) => add("DELETE", p, h, o),
};

/** CSRF: wijzigende requests moeten aantoonbaar van onze eigen pagina komen. */
function checkOrigin(req: Request, url: URL) {
  if (req.headers.get("sec-fetch-site") === "same-origin") return;
  const origin = req.headers.get("origin");
  const hosts = new Set([url.host, req.headers.get("x-forwarded-host") ?? url.host]);
  let ok = false;
  try {
    ok = !!origin && hosts.has(new URL(origin).host);
  } catch {
    ok = false;
  }
  if (!ok) throw forbidden("Verzoek geweigerd (herkomst klopt niet).");
}

export async function handle(req: Request, context: Context): Promise<Response> {
  const url = new URL(req.url);
  setDeployContext(context.deploy?.context);
  // Alleen lokaal: `netlify dev` herhaalt een verzoek na een 403/404 met .html-varianten
  // van het pad (nabootsing van het CDN). Die horen bij dezelfde route.
  if (context.deploy?.context === "dev") url.pathname = url.pathname.replace(/(\/index)?\.html?$/, "");
  try {
    const candidates = routes.filter((r) => r.re.test(url.pathname));
    const found = candidates.find((r) => r.method === req.method);
    if (!found) {
      return json({ error: candidates.length ? "Methode niet toegestaan." : "Niet gevonden." }, candidates.length ? 405 : 404);
    }
    const match = found.re.exec(url.pathname)!;
    const params: Record<string, string> = {};
    found.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1])));

    const mutating = req.method !== "GET" && req.method !== "HEAD";
    if (mutating) checkOrigin(req, url);

    const header = req.headers.get("x-organisation") ?? "";
    const orgId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(header) ? header.toLowerCase() : null;
    const session = await userFromRequest(req, url, orgId);
    if (!found.opts.public && !session) throw new HttpError(401, "Je bent niet (meer) ingelogd.");
    if (found.opts.admin && !session?.user.isAdmin) throw forbidden("Alleen voor beheerders.");

    let cookie: string | null = session?.renew ? sessionCookie(url, session.renew) : null;
    const ctx: Ctx = {
      req,
      url,
      params,
      user: session?.user as User,
      ip: context.ip ?? "",
      orgId,
      orgLocked: session?.orgLocked ?? false,
      serverRegion: context.server?.region ?? "onbekend",
      body: async () => {
        let data: unknown;
        try {
          data = await req.json();
        } catch {
          throw bad("Ongeldige invoer.");
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("Ongeldige invoer.");
        return data as Record<string, unknown>;
      },
      setSession: (token) => {
        cookie = sessionCookie(url, token);
      },
    };

    const result = await found.handler(ctx);
    const res = result instanceof Response ? result : json(result ?? { ok: true });
    if (cookie) res.headers.append("set-cookie", cookie);

    if (mutating && found.opts.audit !== false && res.status < 400 && session) {
      const entry = q(`INSERT INTO audit_log (user_id, user_name, action, detail) VALUES ($1, $2, $3, $4::jsonb)`, [
        session.user.id,
        session.user.name,
        `${req.method} ${found.pattern}`,
        JSON.stringify(params),
      ]).catch((e) => console.error("audit", e));
      if (typeof context.waitUntil === "function") context.waitUntil(entry);
      else await entry;
    }
    return res;
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error(`${req.method} ${url.pathname}`, e);
    return json({ error: "Er ging iets mis op de server. Probeer het opnieuw." }, 500);
  }
}
