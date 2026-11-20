import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "./api";

type Options<T> = { challengeId: string; options: T };
type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

export const passkeysSupported = () => typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";

/** Herkenbare naam voor de passkey, zodat je later weet welk apparaat het is. */
export function deviceName(): string {
  const ua = navigator.userAgent;
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android-telefoon"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows-pc"
            : "Apparaat";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return browser ? `${device} (${browser})` : device;
}

/** Maakt van de foutmelding van de browser iets leesbaars. */
function friendly(e: unknown): Error {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError" || e.name === "AbortError") return new Error("Het aanmaken of gebruiken van de passkey is afgebroken.");
    if (e.name === "InvalidStateError") return new Error("Op dit apparaat staat al een passkey voor dit account.");
    if (e.name === "SecurityError") return new Error("Passkeys werken alleen op het vaste adres van dit platform.");
    return e;
  }
  return new Error("Er ging iets mis met de passkey.");
}

/** Vraagt de browser om een passkey aan te maken en legt die vast via het opgegeven eindpunt. */
async function register(base: string, name: string): Promise<void> {
  const { challengeId, options } = await api<Options<RegistrationOptions>>(`${base}/options`, { method: "POST", body: {} });
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (e) {
    throw friendly(e);
  }
  await api(base, { method: "POST", body: { challengeId, response, name } });
}

/** Extra passkey bij het eigen account. */
export const addPasskey = (name: string) => register("/api/account/passkeys", name);

/** Uitnodiging accepteren met een passkey in plaats van een wachtwoord. */
export const acceptInviteWithPasskey = (token: string, name: string) => register(`/api/tokens/${encodeURIComponent(token)}/passkey`, name);

/** Inloggen zonder wachtwoord: de passkey bepaalt welk account inlogt. */
export async function loginWithPasskey(): Promise<void> {
  const { challengeId, options } = await api<Options<AuthenticationOptions>>("/api/passkeys/login/options", { method: "POST", body: {} });
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (e) {
    throw friendly(e);
  }
  await api("/api/passkeys/login", { method: "POST", body: { challengeId, response } });
}
