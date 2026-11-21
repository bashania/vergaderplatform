// Neemt de instructiefilm op: loopt met een zichtbare cursor en ondertitels door de schermen.
//   node film.cjs <uitvoermap> '<json van seed-demo>'
// Zonder REC=1 worden alleen schermafbeeldingen gemaakt (snelle controle van de schermen).
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { simpleParser } = require("mailparser");
const { SMTPServer } = require("smtp-server");

const BASE = process.env.BASE ?? "http://localhost:8888";
const OUT = process.argv[2];
const demo = JSON.parse(process.argv[3]);
const REC = process.env.REC === "1";
const FAST = !REC;
fs.mkdirSync(path.join(OUT, "frames"), { recursive: true });
fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });

// Draait in de pagina: cursor, ondertitel en titelkaart in de bovenste laag, zodat ze ook boven vensters blijven.
function overlay() {
  if (window.top !== window) return;
  const make = () => {
    const base = "position:fixed;margin:0;border:0;padding:0;overflow:visible;pointer-events:none;background:none;color:#fff;";
    const el = (id, css, html = "") => {
      const d = document.createElement("div");
      d.id = id;
      d.setAttribute("popover", "manual");
      d.style.cssText = base + css;
      d.innerHTML = html;
      document.documentElement.append(d);
      return d;
    };
    const card = el(
      "__card",
      "inset:0;width:100vw;height:100vh;background:#13283b;display:none;align-items:center;justify-content:center;text-align:center;font-family:'IBM Plex Sans',sans-serif;",
    );
    const cap = el(
      "__cap",
      "inset:auto 0 26px 0;margin:0 auto;width:fit-content;max-width:940px;padding:13px 26px;border-radius:12px;background:rgb(12 28 43 / 94%);box-shadow:0 10px 34px rgb(0 0 0 / 35%);font:600 21px/1.4 'IBM Plex Sans',sans-serif;text-align:center;border-bottom:3px solid #f2b441;",
    );
    const cur = el(
      "__cur",
      "left:0;top:0;inset:0 auto auto 0;width:0;height:0;transition:none;",
      '<svg width="26" height="26" viewBox="0 0 24 24" style="position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 2px 3px rgb(0 0 0 / 45%))"><path d="M4 2l15 9.5-6.6 1.3L16 20l-3 1.4-3.6-7.2L4 19z" fill="#fff" stroke="#13283b" stroke-width="1.5" stroke-linejoin="round"/></svg><span id="__ring" style="position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:3px solid #f2b441;opacity:0"></span>',
    );
    const raise = () => {
      for (const d of [card, cap, cur]) {
        if (d.dataset.on === "1") {
          if (d.matches(":popover-open")) d.hidePopover();
          d.showPopover();
        }
      }
    };
    const show = (d, on) => {
      d.dataset.on = on ? "1" : "0";
      if (!on && d.matches(":popover-open")) d.hidePopover();
      raise();
    };
    show(cur, true);
    document.addEventListener("mousemove", (e) => (cur.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`), true);
    document.addEventListener(
      "mousedown",
      () => {
        const ring = document.getElementById("__ring");
        ring.animate([{ opacity: 0.95, transform: "scale(0.4)" }, { opacity: 0, transform: "scale(1.25)" }], { duration: 450, easing: "ease-out" });
      },
      true,
    );
    window.__caption = (text) => {
      cap.textContent = text;
      show(cap, !!text);
    };
    window.__card = (html) => {
      card.innerHTML = html;
      card.style.display = html ? "flex" : "none";
      show(card, !!html);
      show(cur, !html);
    };
    // Een venster dat opent komt bovenop te liggen: cursor en ondertitel daar weer overheen leggen.
    new MutationObserver(() => {
      const open = document.querySelector("dialog[open]:not([data-raised])");
      if (open) {
        open.dataset.raised = "1";
        raise();
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make);
  else make();
}

(async () => {
  // Nagebouwde mailserver: vangt de e-mail op die het platform in de film verstuurt.
  const inbox = [];
  const smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ["STARTTLS"],
    onAuth: (a, _s, done) => done(null, { user: a.username }),
    onData: (stream, _s, done) => simpleParser(stream).then((m) => (inbox.push(m), done()), done),
  });
  await new Promise((r) => smtp.listen(2525, r));

  const browser = await chromium.launch({ args: ["--lang=nl-NL"], env: { ...process.env, LANG: "nl_NL.UTF-8", LANGUAGE: "nl" } });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: REC ? 1.5 : 1,
    locale: "nl-NL",
    timezoneId: "Europe/Amsterdam",
    reducedMotion: "no-preference",
  });
  await context.addInitScript(overlay);
  const login = await context.request.post(`${BASE}/api/login`, { data: { email: demo.email, password: demo.password }, headers: { origin: BASE } });
  if (!login.ok()) throw new Error(`inloggen mislukt: ${login.status()}`);
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("dialog", (d) => d.accept());

  // --- opname: losse beelden met tijdstempel, later met ffmpeg tot film gemaakt ---
  const frames = [];
  let cdp;
  if (REC) {
    cdp = await context.newCDPSession(page);
    cdp.on("Page.screencastFrame", (f) => {
      const file = `f${String(frames.length).padStart(5, "0")}.jpg`;
      frames.push({ file, t: f.metadata.timestamp });
      fs.writeFileSync(path.join(OUT, "frames", file), Buffer.from(f.data, "base64"));
      cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
  }

  const wait = (ms) => page.waitForTimeout(FAST ? Math.min(ms, 250) : ms);
  const captions = [];
  const caption = async (text) => {
    if (REC) captions.push({ t: Date.now() / 1000, text });
    else await page.evaluate((t) => window.__caption(t), text);
  };
  const card = (html) => page.evaluate((h) => window.__card(h), html);
  let shotNr = 0;
  const shot = async (name) => {
    if (!REC) await page.screenshot({ path: path.join(OUT, "shots", `${String(++shotNr).padStart(2, "0")}-${name}.png`) });
  };
  let mouse = { x: 640, y: 360 };
  /** Beweegt de cursor vloeiend naar het midden van het element. */
  async function hover(locator) {
    await locator.scrollIntoViewIfNeeded();
    await wait(250);
    const box = await locator.boundingBox();
    const to = { x: box.x + Math.min(box.width / 2, 120), y: box.y + box.height / 2 };
    const steps = FAST ? 2 : Math.max(14, Math.round(Math.hypot(to.x - mouse.x, to.y - mouse.y) / 22));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      await page.mouse.move(mouse.x + (to.x - mouse.x) * ease, mouse.y + (to.y - mouse.y) * ease);
      if (!FAST) await page.waitForTimeout(16);
    }
    mouse = to;
    await wait(220);
  }
  async function click(locator) {
    await hover(locator);
    await page.mouse.down();
    await page.mouse.up();
    await wait(350);
  }
  const title = (big, small) =>
    `<div><div style="width:76px;height:76px;margin:0 auto 26px;border-radius:19px;background:#0b6e78;display:grid;place-items:center"><svg width="46" height="46" viewBox="0 0 32 32"><path d="M8.5 10.5h15M8.5 16h9M8.5 21.5h6" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="m18.6 20.6 2.4 2.4 4.2-4.8" fill="none" stroke="#F2B441" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div><div style="font-size:46px;font-weight:700;letter-spacing:-0.01em">${big}</div><div style="margin-top:14px;font-size:23px;color:#a9c4cf;max-width:860px">${small}</div></div>`;

  await page.goto(BASE + "/");
  await page.getByRole("heading", { level: 1 }).first().waitFor();
  await card(title("Vergaderplatform", "Van agenda tot afgeronde actie, in één omgeving"));
  await page.mouse.move(mouse.x, mouse.y);
  if (REC) await cdp.send("Page.startScreencast", { format: "jpeg", quality: 93, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await wait(2800);

  // 1. Overzicht
  await card("");
  await caption("Na het inloggen zie je je vergaderingen, je acties en de nieuwste stukken.");
  await wait(3600);
  await shot("overzicht");

  // 2. Voorbereiden: een aangedragen punt op de agenda zetten
  await click(page.locator(".nav").getByRole("link", { name: "Overleggen" }));
  await click(page.getByRole("link", { name: "Bestuursoverleg", exact: true }));
  await page.getByRole("heading", { name: "Aangedragen agendapunten" }).waitFor();
  await caption("Deelnemers dragen zelf agendapunten aan. De secretaris zet ze met één klik op de agenda.");
  await hover(page.getByText("Fietsenstalling uitbreiden").first());
  await wait(3000);
  await shot("aangedragen");
  await click(page.getByRole("button", { name: "Op de agenda" }));
  await wait(2200);
  await click(page.getByRole("link", { name: "Bestuursoverleg november" }).first());
  await page.getByRole("heading", { name: "Bestuursoverleg november" }).waitFor();

  // 3. Vergadering met agenda en stukken
  await caption("Agenda en stukken staan bij elkaar. Elke deelnemer kan er altijd bij.");
  await wait(2200);
  const doc = page.locator(".doc", { hasText: "Voorstel groenplan" });
  await hover(doc.locator(".name"));
  await wait(2200);
  await shot("vergadering");

  // 3. Samenvatting door de AI-assistent
  await caption("De AI-assistent vat een stuk samen, zodat je weet waar je op moet letten.");
  await click(doc.getByRole("button", { name: "Samenvatting" }));
  await page.locator(".ai-text").waitFor();
  await wait(5600);
  await shot("samenvatting");
  await click(page.locator("dialog[open]").getByRole("button", { name: "Sluiten", exact: true }).last());

  // Voorbereiden met een eigen aantekening
  await caption("Bereid je voor met een eigen aantekening bij een agendapunt. Alleen jij ziet die.");
  const groen = page.locator(".agenda-item", { hasText: "Groenplan binnentuin" });
  await click(groen.getByRole("button", { name: "Eigen aantekening" }));
  await page.keyboard.type("Vragen: wie doet het onderhoud in de zomer? Is de subsidie al toegezegd?", { delay: FAST ? 0 : 30 });
  await groen.getByText("Opgeslagen · alleen jij ziet dit").waitFor();
  await wait(2600);
  await shot("eigen-aantekening");

  // De agenda mailen, en aanmelden vanuit de e-mail
  await page.evaluate(() => document.querySelector(".main")?.scrollTo({ top: 0, behavior: "smooth" }) ?? window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("Verstuur de agenda naar alle deelnemers. De afspraak voor hun eigen agenda zit erbij.");
  await click(page.getByRole("button", { name: "Agenda mailen" }));
  await wait(1600);
  await click(page.locator("dialog[open]").getByRole("button", { name: /Versturen naar/ }));
  await page.locator("dialog[open]").getByText(/verstuurd/).waitFor();
  await wait(1800);
  await shot("agenda-gemaild");
  await click(page.locator("dialog[open]").getByRole("button", { name: "Klaar" }));
  const mail = inbox.find((m) => m.to.value[0].address === "karim@delinde.example");
  const rsvp = (mail?.text.match(/https?:\/\/\S+\/aanwezigheid#\S+~ja/) ?? [])[0];
  if (!rsvp) throw new Error("geen aanmeldlink in de e-mail aan Karim: " + inbox.map((m) => m.subject).join(" | "));
  await caption("Een deelnemer meldt zich aan of af met één klik in die mail. Inloggen hoeft daarvoor niet.");
  await page.goto(rsvp);
  await page.getByRole("button", { name: /erbij/i }).first().waitFor();
  await wait(1500);
  await click(page.getByRole("button", { name: /erbij/i }).first());
  await page.getByText("Je bent aangemeld.").waitFor();
  await wait(2600);
  await shot("aangemeld");
  await page.goto(`${BASE}/vergaderingen/${demo.meeting}`);
  await page.getByRole("heading", { name: "Bestuursoverleg november" }).waitFor();
  await page.mouse.move(mouse.x, mouse.y);

  // 4. Vergadermodus starten
  await page.evaluate(() => document.querySelector(".main")?.scrollTo({ top: 0, behavior: "smooth" }) ?? window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("Begint het overleg? Open de vergadermodus.");
  await click(page.getByRole("link", { name: "Vergadermodus" }));
  await page.getByRole("button", { name: "Vergadering starten" }).waitFor();
  await wait(1400);
  await shot("vergadermodus-start");
  await click(page.getByRole("button", { name: "Vergadering starten" }));
  await page.locator(".live-step.current").waitFor();
  await caption("Eén scherm met het actuele punt, de stukken en de tijd. Deelnemers lopen vanzelf mee.");
  await wait(4300);
  await shot("vergadermodus-punt1");

  // 5. Door de agenda
  await caption("Met één klik naar het volgende punt. De klok laat zien of je op schema ligt.");
  await click(page.locator(".live-foot").getByRole("button", { name: /Volgende/ }));
  await wait(1500);
  await click(page.locator(".live-foot").getByRole("button", { name: /Volgende/ }));
  await page.getByRole("heading", { name: "Groenplan binnentuin" }).waitFor();
  await wait(2000);

  // Een stuk op het scherm, en meekijken met een QR-code
  await caption("Zet een stuk op het scherm en blader erdoor. Wie meeloopt, ziet dezelfde pagina.");
  await click(page.getByRole("button", { name: "Op het scherm" }).first());
  await page.locator(".stage canvas:not([hidden])").waitFor();
  await wait(2600);
  await click(page.getByRole("button", { name: "Volgende pagina" }));
  await page.getByText("pagina 2 van 3").waitFor();
  await wait(3000);
  await shot("stuk-op-het-scherm");
  await caption("Laat aanwezigen meekijken op hun eigen telefoon: een QR-code scannen is genoeg, zonder account.");
  await click(page.locator(".live-top").getByRole("button", { name: /Meekijken/ }));
  await click(page.locator("dialog[open]").getByRole("button", { name: "Meekijken aanzetten" }));
  await page.locator("dialog[open] svg.qr").waitFor();
  // De opname draait lokaal; in beeld hoort het adres dat gebruikers zien.
  await page.evaluate((host) => {
    for (const el of document.querySelectorAll("dialog[open] strong")) el.textContent = el.textContent.replace(/localhost:\d+/, host);
  }, process.env.FILM_HOST ?? "vergaderplatform.netlify.app");
  await wait(4200);
  await shot("meekijken");
  await click(page.locator("dialog[open]").getByRole("button", { name: "Sluiten" }).first());
  await click(page.locator(".stage-bar").getByRole("button", { name: "Van het scherm" }));
  await wait(900);

  // 6. Notulen
  await caption("Typ de notulen bij het punt. Ze worden vanzelf opgeslagen.");
  const notes = page.locator("#live-notulen");
  await click(notes);
  await page.keyboard.type("Het bestuur stemt in met het groenplan en stelt € 4.800 beschikbaar. Lotte vraagt voor 15 januari drie offertes aan bij hoveniers.", {
    delay: FAST ? 0 : 34,
  });
  await page.getByText("Opgeslagen", { exact: true }).waitFor();
  await wait(1800);
  await shot("vergadermodus-notulen");

  // 7. Beëindigen en voorstellen laten doen
  await caption("Klaar? Beëindig de vergadermodus.");
  await click(page.locator(".live-top").getByRole("button", { name: "Beëindigen" }));
  await page.getByRole("button", { name: "Voorstellen uit notulen" }).waitFor();
  await wait(900);
  await caption("Laat besluiten en acties voorstellen uit je notulen.");
  await click(page.getByRole("button", { name: "Voorstellen uit notulen" }));
  await page.locator(".proposal").first().waitFor();
  await wait(1200);
  await caption("Jij controleert de voorstellen en beslist wat wordt vastgelegd.");
  await wait(4600);
  await shot("voorstellen");
  await click(page.getByRole("button", { name: /Overnemen/ }));
  await page.locator(".decision").first().waitFor();

  // 8. Resultaat in het verslag
  await caption("Besluiten krijgen een nummer, acties een eigenaar en een deadline.");
  await hover(page.locator(".decision").first());
  await wait(4200);
  await shot("besluit-en-actie");

  // 9. Afronden
  await page.evaluate(() => document.querySelector(".main")?.scrollTo({ top: 0, behavior: "smooth" }) ?? window.scrollTo({ top: 0, behavior: "smooth" }));
  await caption("Rond de vergadering af. Het verslag staat direct klaar voor alle deelnemers.");
  await click(page.getByRole("button", { name: "Afronden" }));
  await page.getByText("Afgerond.", { exact: false }).first().waitFor();
  await wait(3600);
  await shot("afgerond");

  // 10. Terugvinden: vraag het archief
  await caption("Maanden later nog weten wat er is besloten? Zoek, of stel je vraag aan het archief.");
  await click(page.getByPlaceholder("Zoeken"));
  await page.keyboard.type("groenplan", { delay: FAST ? 0 : 60 });
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Vraag het archief" }).waitFor();
  await wait(1800);
  await click(page.getByLabel("Vraag aan het archief"));
  await page.keyboard.type("Is het groenplan goedgekeurd, en wie regelt de offertes?", { delay: FAST ? 0 : 34 });
  await click(page.getByRole("button", { name: "Vraag", exact: true }));
  await page.locator(".note.pre").waitFor();
  await wait(5200);
  await shot("archief");

  // 11. Vertrouwelijk: een besloten kring
  await caption("Vertrouwelijk onderwerp? Maak een besloten kring bij het overleg.");
  await click(page.locator(".nav").getByRole("link", { name: "Overleggen" }));
  await click(page.getByRole("link", { name: "Bestuursoverleg", exact: true }));
  await click(page.getByRole("link", { name: "Deelnemers" }));
  await click(page.getByRole("button", { name: "Besloten kring maken" }));
  const kring = page.locator("dialog[open]");
  await kring.getByLabel("Naam").waitFor();
  await wait(900);
  await click(kring.getByLabel("Lotte de Boer"));
  await caption("Alleen wie je kiest, ziet de kring. Ook beheerders van de organisatie niet.");
  await wait(3400);
  await shot("kring-maken");
  await click(kring.getByRole("button", { name: "Kring maken" }));
  await page.getByRole("heading", { name: "Bestuursoverleg (besloten)" }).waitFor();
  await wait(3200);
  await shot("kring");

  // 12. Afsluiting
  await caption("");
  await card(title("Zelf aan de slag", "Uitleg per rol staat in het menu.<br>Ook: een presentatiescherm voor de beamer, stemrondes buiten de vergadering,<br>concept-notulen uit een opname en inzicht voor de beheerder."));
  await wait(4600);
  await shot("slot");

  if (REC) {
    await cdp.send("Page.stopScreencast");
    await page.waitForTimeout(300);
    // Lijst voor ffmpeg: elk beeld blijft staan tot het volgende.
    const end = Date.now() / 1000;
    const lines = frames.map((f, i) => `file 'frames/${f.file}'\nduration ${Math.max(0.01, (frames[i + 1]?.t ?? Math.max(end, f.t + 0.5)) - f.t).toFixed(3)}`);
    lines.push(`file 'frames/${frames[frames.length - 1].file}'`);
    fs.writeFileSync(path.join(OUT, "frames.txt"), lines.join("\n") + "\n");
    const t0 = frames[0].t;
    const total = Math.max(end, frames[frames.length - 1].t + 0.5) - t0;
    const subs = captions
      .map((c, i) => ({ text: c.text, from: Math.max(0, c.t - t0), to: (captions[i + 1]?.t ?? t0 + total) - t0 }))
      .filter((c) => c.text);
    fs.writeFileSync(path.join(OUT, "captions.json"), JSON.stringify({ total, subs }, null, 1));
    console.log(`${frames.length} beelden, ${(frames[frames.length - 1].t - frames[0].t).toFixed(1)} s`);
  }
  await browser.close();
  await new Promise((r) => smtp.close(r));
  if (problems.length) {
    console.log("PROBLEMEN IN DE BROWSER:\n" + problems.join("\n"));
    process.exitCode = 1;
  } else console.log("geen fouten in de browser");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
