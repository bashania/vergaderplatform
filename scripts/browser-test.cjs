// Schermtest in een echte browser: het stuk op het scherm, het presentatiescherm en meekijken zonder
// account, met drie schermen tegelijk. Draait op de demogegevens van scripts/film/seed-demo.cjs.
//   BROWSER=chromium|webkit|firefox node scripts/browser-test.cjs demo.json
// De automatische tests draaien dit in alle drie; WebKit is de browsermotor van Safari.
const playwright = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE ?? "http://localhost:8888";
const ENGINE = process.env.BROWSER ?? "chromium";
const OUT = process.env.OUT;
const demo = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (OUT) fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "goed" : "FOUT"}: ${name}${detail ? ` (${detail})` : ""}`);
};
const shot = (page, name) => (OUT ? page.screenshot({ path: path.join(OUT, `${ENGINE}-${name}.png`) }) : null);

/** Is er echt iets getekend? Telt de niet-witte beeldpunten van het doek. */
const inked = (page) =>
  page.locator(".stage canvas").evaluate((c) => {
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200) dark++;
    return { width: c.width, height: c.height, dark };
  });

(async () => {
  const browser = await playwright[ENGINE].launch();
  console.log(`browser: ${ENGINE} ${browser.version()}`);
  const problems = [];
  const watch = (page, who) => {
    page.on("console", (m) => m.type() === "error" && !/40[1349]/.test(m.text()) && problems.push(`${who}: ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`${who}: ${e}`));
  };

  // De secretaris.
  const secCtx = await browser.newContext({ viewport: { width: 1360, height: 860 }, locale: "nl-NL" });
  const login = await secCtx.request.post(`${BASE}/api/login`, { data: { email: demo.email, password: demo.password }, headers: { origin: BASE } });
  if (!login.ok()) throw new Error(`inloggen mislukt: ${login.status()}`);
  const sec = await secCtx.newPage();
  watch(sec, "secretaris");
  sec.on("dialog", (d) => d.accept());
  await sec.goto(`${BASE}/vergaderingen/${demo.meeting}/live`);
  await sec.getByRole("button", { name: "Vergadering starten" }).click();
  await sec.locator(".live-step.current").waitFor();
  await sec.locator(".live-step", { hasText: "Groenplan binnentuin" }).click();
  await sec.getByRole("heading", { name: "Groenplan binnentuin" }).waitFor();

  // Eigen aantekening: slaat vanzelf op, staat er nog na een ander agendapunt, en een andere deelnemer ziet hem niet.
  const note = "Vragen naar de onderhoudskosten na het eerste jaar.";
  await sec.getByRole("button", { name: "Eigen aantekening" }).click();
  await sec.getByLabel("Eigen aantekening").fill(note);
  await sec.getByText("Opgeslagen · alleen jij ziet dit").waitFor({ timeout: 15000 });
  await sec.locator(".live-step", { hasText: "Begroting 2027" }).click();
  await sec.getByRole("heading", { name: "Begroting 2027" }).waitFor();
  await sec.locator(".live-step", { hasText: "Groenplan binnentuin" }).click();
  await sec.getByRole("heading", { name: "Groenplan binnentuin" }).waitFor();
  check("eigen aantekening staat er nog na een ander agendapunt", (await sec.getByLabel("Eigen aantekening").inputValue()) === note);
  const otherCtx = await browser.newContext({ locale: "nl-NL" });
  const otherLogin = await otherCtx.request.post(`${BASE}/api/login`, { data: { email: "karim@delinde.example", password: "demo-wachtwoord-van-karim" }, headers: { origin: BASE } });
  const forOther = await (await otherCtx.request.get(`${BASE}/api/meetings/${demo.meeting}`, { headers: { "x-organisation": demo.org } })).text();
  check("een andere deelnemer krijgt de aantekening niet te zien", otherLogin.ok() && forOther.includes("Groenplan binnentuin") && !forOther.includes("onderhoudskosten"));
  await otherCtx.close();

  await sec.getByRole("button", { name: "Op het scherm" }).first().click();
  await sec.locator(".stage canvas:not([hidden])").waitFor({ timeout: 45000 });
  await sec.getByText("pagina 1 van 3").waitFor();
  await sec.waitForTimeout(800);
  const drawn = await inked(sec);
  check("secretaris: de pdf is getekend", drawn.dark > 300, JSON.stringify(drawn));
  await sec.getByRole("button", { name: "Volgende pagina" }).click();
  await sec.getByText("pagina 2 van 3").waitFor();
  await sec.waitForTimeout(700);
  await shot(sec, "secretaris");

  // Meekijken aanzetten.
  await sec.locator(".live-top").getByRole("button", { name: /Meekijken/ }).click();
  const dialog = sec.locator("dialog[open]");
  await dialog.getByRole("button", { name: "Meekijken aanzetten" }).click();
  await dialog.locator("svg.qr").waitFor();
  const code = (await dialog.locator(".join-code").innerText()).trim();
  check("meekijken aan: een code van acht tekens en een QR-code", /^[A-HJ-NP-Z2-9]{4} [A-HJ-NP-Z2-9]{4}$/.test(code), code);
  await shot(sec, "meekijken-aan");
  await dialog.getByRole("button", { name: "Sluiten" }).first().click();

  // Het presentatiescherm: zelfde gebruiker, tweede venster.
  const beamer = await secCtx.newPage();
  watch(beamer, "presentatiescherm");
  await beamer.setViewportSize({ width: 1600, height: 900 });
  await beamer.goto(`${BASE}/vergaderingen/${demo.meeting}/scherm`);
  await beamer.locator(".stage canvas:not([hidden])").waitFor({ timeout: 45000 });
  await beamer.getByText("pagina 2 van 3").waitFor();
  await beamer.locator(".screen-foot .join-code").waitFor();
  await beamer.waitForTimeout(700);
  check("presentatiescherm: het stuk op pagina 2, de typcode onderaan en geen notulenveld", (await beamer.locator(".screen-foot .join-code").innerText()).trim() === code && (await beamer.locator("textarea").count()) === 0 && (await inked(beamer)).dark > 300);
  await shot(beamer, "presentatiescherm");

  // Een meekijker zonder account, op een telefoon. In WebKit met de kenmerken van een iPhone.
  const phone = ENGINE === "webkit" ? playwright.devices["iPhone 13"] : ENGINE === "chromium" ? playwright.devices["Pixel 7"] : { viewport: { width: 390, height: 800 } };
  const guestCtx = await browser.newContext({ ...phone, locale: "nl-NL" });
  const guest = await guestCtx.newPage();
  watch(guest, "meekijker");
  await guest.goto(`${BASE}/meekijken`);
  await guest.getByLabel("Code").fill(code.toLowerCase());
  await guest.getByRole("button", { name: "Meekijken" }).click();
  await guest.locator(".stage canvas:not([hidden])").waitFor({ timeout: 45000 });
  await guest.getByText("pagina 2 van 3").waitFor();
  await guest.waitForTimeout(800);
  const seen = await inked(guest);
  check("meekijker: na het typen van de code is het stuk op pagina 2 getekend, zonder cookies", seen.dark > 300 && (await guestCtx.cookies()).length === 0, JSON.stringify(seen));
  await shot(guest, "meekijker");

  // Bladeren met de pijltjestoets: iedereen gaat mee.
  await sec.locator(".live-head h1").click();
  await sec.keyboard.press("ArrowRight");
  await sec.getByText("pagina 3 van 3").waitFor();
  await guest.getByText("pagina 3 van 3").waitFor({ timeout: 20000 });
  await beamer.getByText("pagina 3 van 3").waitFor({ timeout: 20000 });
  check("bladeren met de pijltjestoets komt aan bij meekijker en presentatiescherm", true);

  // Van het scherm: de meekijker ziet het agendapunt, het presentatiescherm de grote QR-code.
  await sec.locator(".stage-bar").getByRole("button", { name: "Van het scherm" }).click();
  await guest.getByRole("heading", { name: "Groenplan binnentuin" }).waitFor({ timeout: 20000 });
  await beamer.locator(".join.big svg.qr").waitFor({ timeout: 20000 });
  const qr = await beamer.locator(".join.big svg.qr").evaluate((el) => ({ width: el.getBoundingClientRect().width, cells: Number(el.getAttribute("viewBox").split(" ")[2]) }));
  check("van het scherm: agendapunt bij de meekijker, zonder notulen", (await guest.locator("textarea, .note").count()) === 0);
  check("presentatiescherm: grote QR-code met een heel aantal beeldpunten per blokje", qr.width >= 250 && Number.isInteger(qr.width / qr.cells), JSON.stringify(qr));
  await shot(beamer, "presentatiescherm-qr");

  // Vergadermodus beëindigen: het meekijken stopt.
  await sec.locator(".live-top").getByRole("button", { name: "Beëindigen" }).click();
  await guest.getByText(/Het meekijken is gestopt/).waitFor({ timeout: 30000 });
  check("beëindigd: de meekijker krijgt de melding dat het meekijken is gestopt", true);

  await browser.close();
  check("geen fouten in de browser", problems.length === 0, problems.join(" | ").slice(0, 600));
  console.log(`\n${ENGINE}: ${failed ? `${failed} mislukt` : "alles geslaagd"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
