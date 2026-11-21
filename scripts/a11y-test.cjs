// Toegankelijkheidstest: elk scherm langs de regels van WCAG 2.2 A en AA (met axe), op drie breedtes,
// plus wat axe niet ziet: past het scherm in de breedte, heeft het een eigen titel, en werkt het toetsenbord.
// Draait op de demogegevens van scripts/film/seed-demo.cjs.
//   node scripts/a11y-test.cjs demo.json
// Een geautomatiseerde test vindt niet alles: hij bewaakt contrast, namen, koppen, landmarks en bediening,
// niet of een tekst begrijpelijk is. Zie de README.
const { chromium, devices } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = process.env.BASE ?? "http://localhost:8888";
const OUT = process.env.OUT;
const demo = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
if (OUT) fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
let screens = 0;
const titles = new Map();
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "goed" : "FOUT"}: ${name}${detail ? ` (${detail})` : ""}`);
};

/** Eén scherm: de regels van axe, en of de pagina in de breedte past (WCAG 1.4.10, geen zijwaarts schuiven bij 320 px). */
async function audit(page, name) {
  await page.waitForTimeout(600);
  await page.addScriptTag({ content: AXE });
  const violations = await page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const result = await axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id} bij ${n.target.join(" ")}: ${(n.any[0] ?? n.all[0] ?? n.none[0])?.message ?? v.help}`));
  }, TAGS);
  const width = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: document.documentElement.clientWidth }));
  titles.set(name, await page.title());
  screens++;
  if (OUT && (violations.length || width.page > width.screen + 1)) await page.screenshot({ path: path.join(OUT, `${name.replace(/[^a-z0-9]+/gi, "-")}.png`), fullPage: true });
  check(`${name}: geen bevindingen`, violations.length === 0, violations.slice(0, 6).join(" | ").slice(0, 900));
  check(`${name}: past in de breedte`, width.page <= width.screen + 1, width.page > width.screen + 1 ? `${width.page} px op een scherm van ${width.screen} px` : "");
}

(async () => {
  const browser = await chromium.launch();
  // bypassCSP: de site staat geen ingevoegde scripts toe, en dat moet zo blijven. Alleen deze test voegt er een in.
  const base = { locale: "nl-NL", bypassCSP: true };

  for (const [label, options] of [
    ["breed", { viewport: { width: 1360, height: 900 } }],
    ["telefoon", { ...devices["Pixel 7"] }],
    ["smal", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }],
  ]) {
    console.log(`\n== ${label}`);

    // Zonder account: inloggen (ook met een foutmelding) en meekijken.
    const anon = await browser.newContext({ ...options, ...base });
    const a = await anon.newPage();
    await a.goto(`${BASE}/`);
    await a.getByRole("heading", { name: "Inloggen" }).waitFor();
    await audit(a, `${label} inloggen`);
    await a.getByLabel("E-mailadres").fill("niemand@delinde.example");
    await a.getByLabel("Wachtwoord").fill("dit-klopt-niet");
    await a.getByRole("button", { name: "Inloggen", exact: true }).click();
    await a.locator(".form-error, [role=alert]").first().waitFor({ timeout: 15000 });
    await audit(a, `${label} inloggen-fout`);
    await a.goto(`${BASE}/meekijken`);
    await a.getByLabel("Code").waitFor();
    await audit(a, `${label} meekijken-code`);
    await anon.close();

    // Als secretaris.
    const ctx = await browser.newContext({ ...options, ...base });
    const login = await ctx.request.post(`${BASE}/api/login`, { data: { email: demo.email, password: demo.password }, headers: { origin: BASE } });
    if (!login.ok()) throw new Error(`inloggen mislukt: ${login.status()}`);
    const list = await (await ctx.request.get(`${BASE}/api/overleggen`, { headers: { "x-organisation": demo.org } })).json();
    const overlegId = (list.overleggen ?? list)[0]?.id;
    const page = await ctx.newPage();
    page.on("dialog", (d) => d.accept());
    const visit = async (url, name) => {
      await page.goto(`${BASE}${url}`);
      await page.locator("h1").first().waitFor({ timeout: 20000 });
      await audit(page, `${label} ${name}`);
    };
    await visit("/", "overzicht");
    await visit("/overleggen", "overleggen");
    await visit(`/overleggen/${overlegId}`, "overleg");
    await visit(`/vergaderingen/${demo.meeting}`, "vergadering");
    await visit("/besluiten", "besluiten");
    await visit("/acties", "acties");
    await visit("/zoeken", "zoeken");
    await visit("/organisatie", "organisatie");
    await visit("/inzicht", "inzicht");
    await visit("/account", "account");
    await visit("/uitleg", "uitleg");
    await visit("/beheer", "beheer");

    if (label === "breed") {
      // Toetsenbord: de eerste Tab is de sla-link, Enter zet de focus in de inhoud.
      await page.goto(`${BASE}/acties`);
      await page.locator("main h1").waitFor();
      await page.keyboard.press("Tab");
      const skip = await page.evaluate(() => ({ text: document.activeElement.textContent.trim(), top: document.activeElement.getBoundingClientRect().top }));
      await page.keyboard.press("Enter");
      check("toetsenbord: de eerste Tab is 'Naar de inhoud', zichtbaar in beeld, en Enter zet de focus in de inhoud", skip.text === "Naar de inhoud" && skip.top >= 0 && (await page.evaluate(() => document.activeElement.id)) === "inhoud", JSON.stringify(skip));
      // Na een klik in het menu staat de focus in de inhoud en is de nieuwe pagina aangezegd.
      await page.getByRole("link", { name: "Besluiten" }).first().click();
      await page.getByRole("heading", { name: "Besluitenlijst" }).waitFor();
      await page.waitForTimeout(300);
      check(
        "toetsenbord: na een wissel van pagina staat de focus in de inhoud, met een eigen titel die is aangezegd",
        (await page.evaluate(() => document.activeElement.id)) === "inhoud" && (await page.title()).startsWith("Besluitenlijst · ") && (await page.locator("[aria-live=polite].sr-only").last().innerText()) === "Besluitenlijst",
        await page.title(),
      );
      // Elke stap met Tab heeft een zichtbare focusrand.
      await page.goto(`${BASE}/vergaderingen/${demo.meeting}`);
      await page.locator("main h1").waitFor();
      const unseen = [];
      let steps = 0;
      for (; steps < 60; steps++) {
        await page.keyboard.press("Tab");
        const focus = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const style = getComputedStyle(el);
          return { what: `${el.tagName.toLowerCase()} ${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}`, seen: (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 2) || style.boxShadow !== "none" };
        });
        if (!focus) break;
        if (!focus.seen) unseen.push(focus.what);
      }
      check("toetsenbord: elke stap met Tab op de vergaderpagina heeft een zichtbare focusrand", steps >= 30 && unseen.length === 0, `${steps} stappen${unseen.length ? `, zonder rand: ${unseen.slice(0, 5).join(" | ")}` : ""}`);

      // Een venster.
      await page.getByRole("button", { name: "Agendapunt toevoegen" }).first().click();
      await page.locator("dialog[open]").waitFor();
      await audit(page, `${label} venster-agendapunt`);
      await page.keyboard.press("Escape");

      // Vergadermodus, met een stuk op het scherm en meekijken aan.
      await page.goto(`${BASE}/vergaderingen/${demo.meeting}/live`);
      await page.getByRole("button", { name: "Vergadering starten" }).waitFor();
      await audit(page, `${label} vergadermodus-voor-start`);
      await page.getByRole("button", { name: "Vergadering starten" }).click();
      await page.locator(".live-step.current").waitFor();
      await page.locator(".live-step", { hasText: "Groenplan binnentuin" }).click();
      await page.getByRole("heading", { name: "Groenplan binnentuin" }).waitFor();
      await audit(page, `${label} vergadermodus`);
      await page.getByRole("button", { name: "Op het scherm" }).first().click();
      await page.locator(".stage canvas:not([hidden])").waitFor({ timeout: 45000 });
      await audit(page, `${label} vergadermodus-stuk`);
      await page.locator(".live-top").getByRole("button", { name: /Meekijken/ }).click();
      const dialog = page.locator("dialog[open]");
      await dialog.getByRole("button", { name: "Meekijken aanzetten" }).click();
      await dialog.locator("svg.qr").waitFor();
      await audit(page, `${label} venster-meekijken`);
      const code = (await dialog.locator(".join-code").innerText()).trim();
      await dialog.getByRole("button", { name: "Sluiten" }).first().click();

      const beamer = await ctx.newPage();
      await beamer.goto(`${BASE}/vergaderingen/${demo.meeting}/scherm`);
      await beamer.locator(".stage canvas:not([hidden])").waitFor({ timeout: 45000 });
      await audit(beamer, `${label} presentatiescherm-stuk`);
      await page.locator(".stage-bar").getByRole("button", { name: "Van het scherm" }).click();
      await beamer.locator(".join.big svg.qr").waitFor({ timeout: 20000 });
      await audit(beamer, `${label} presentatiescherm-qr`);
      await beamer.close();

      const guestCtx = await browser.newContext({ ...devices["Pixel 7"], ...base });
      const guest = await guestCtx.newPage();
      await guest.goto(`${BASE}/meekijken`);
      await guest.getByLabel("Code").fill(code);
      await guest.getByRole("button", { name: "Meekijken" }).click();
      await guest.getByRole("heading", { name: "Groenplan binnentuin" }).waitFor({ timeout: 20000 });
      await audit(guest, "telefoon meekijker");
      await guestCtx.close();

      await page.locator(".live-top").getByRole("button", { name: "Beëindigen" }).click();
      await page.waitForTimeout(800);
    }
    await ctx.close();
  }
  await browser.close();

  // Tabbladen moeten uit elkaar te houden zijn: elk soort scherm heeft een eigen titel.
  const t = (name) => titles.get(name) ?? "";
  const kinds = ["inloggen", "meekijken-code", "overzicht", "overleggen", "overleg", "vergadering", "besluiten", "acties", "zoeken", "organisatie", "inzicht", "account", "uitleg", "beheer", "vergadermodus", "presentatiescherm-stuk"].map((k) => t(`breed ${k}`));
  check("elk soort scherm heeft een eigen titel in het tabblad", new Set(kinds).size === kinds.length && kinds.every((k) => / · /.test(k)), kinds.join(" | ").slice(0, 600));
  check("vergadermodus en presentatiescherm zijn aan de titel te herkennen", t("breed vergadermodus").startsWith("Vergadermodus: ") && t("breed presentatiescherm-stuk").startsWith("Presentatiescherm: ") && t("breed overzicht").startsWith("Overzicht · "), `${t("breed vergadermodus")} | ${t("breed presentatiescherm-stuk")} | ${t("breed overzicht")}`);

  console.log(`\n${screens} schermen nagelopen: ${failed ? `${failed} mislukt` : "alles geslaagd"}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
