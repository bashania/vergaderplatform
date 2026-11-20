# Vergaderplatform

Agenda's, stukken, besluiten en acties op één plek, zodat alle deelnemers altijd bij de stukken kunnen. Eén platform voor meerdere organisaties: elke organisatie is een eigen omgeving.

## Wat het doet

- **Organisaties**: elke organisatie (bedrijf, school, commissie) is een eigen omgeving met eigen overleggen, deelnemers en beheerders. Eén account kan bij meerdere organisaties horen; na inloggen kies je de organisatie en zie je alleen die.
- **Overleggen**: elk gremium (bestuur, raad van toezicht, MT, projectoverleg) heeft eigen deelnemers, vergaderingen, besluitenlijst, actielijst en vaste stukken.
- **Vergaderingen**: agenda met hoofd- en subpunten (2.1, 2.2), een vrij label per punt ("Ter vaststelling"), stukken per agendapunt, notulen en aanwezigheid.
- **Agenda plakken**: een bestaande agenda uit Word, pdf of e-mail in één keer overnemen. Nummering wordt hoofd- of subpunt, "Ter informatie" en dergelijke worden het label. Je ziet vooraf wat het wordt.
- **Besluiten**: automatisch doorlopend genummerd per overleg per jaar (2026-001, 2026-002, ...).
- **Acties**: actiehouder en deadline; de actiehouder meldt zelf af. Open acties komen terug op de actielijst van de volgende vergadering.
- **Uitnodigen**: deelnemers toevoegen op e-mailadres. Bestaat het account al, dan wordt het gekoppeld; anders ontstaat een uitnodigingslink. Er is bewust geen lijst van alle accounts.
- **Passkeys**: inloggen met vingerafdruk, gezicht of de pincode van het apparaat, zonder wachtwoord. Bij een uitnodiging is een passkey de eerste keuze; een wachtwoord blijft mogelijk.
- **Tweestapsverificatie per organisatie**: een beheerder kan een passkey verplicht stellen. Wie met alleen een wachtwoord is ingelogd, komt die organisatie dan niet in.
- **Status**: concept (alleen secretaris) → gepubliceerd (deelnemers zien alles) → afgerond (vergrendeld).
- **Vergadermodus**: tijdens het overleg één scherm met het actuele agendapunt, de stukken, de klok (besteed tegenover gepland) en de notulen, die vanzelf worden opgeslagen. Deelnemers die het scherm openen, lopen zonder verversen mee met de secretaris. De bestede tijd per punt komt in het verslag.
- **AI-assistent** (per organisatie aan te zetten): vat een pdf of tekstbestand samen ter voorbereiding en stelt na afloop besluiten en acties voor uit de notulen. De assistent legt zelf niets vast; de secretaris neemt een voorstel over of niet.
- **Installeerbaar**: op telefoon, tablet of computer als app op het beginscherm te zetten.
- **Transcript en Plaud**: de secretaris zet het transcript van de opname bij de vergadering, opgehaald uit Plaud of geplakt als tekst (ook uit Teams of Zoom). De AI-assistent maakt er concept-notulen per agendapunt van; de secretaris loopt ze na en neemt ze over.

## Rollen

| Rol | Bereik | Kan |
|---|---|---|
| Platformbeheerder | Hele platform | Organisaties aanmaken, beheerders aanwijzen, accounts blokkeren, resetlinks maken. Ziet de inhoud van een organisatie alleen als beheerder of deelnemer daarvan. |
| Beheerder | Eén organisatie | Overleggen aanmaken en archiveren, alle overleggen van de organisatie zien en beheren, toegang intrekken. |
| Secretaris | Eén overleg | Agenda, notulen, besluiten, acties en deelnemers van dat overleg. |
| Deelnemer | Eén overleg | Lezen, stukken aanleveren, aanwezigheid doorgeven, eigen acties afmelden. |

## Techniek

| Onderdeel | Keuze |
|---|---|
| Frontend | React + Vite (`src/`) |
| API | Eén Netlify Function (`netlify/functions/api.mts`, code in `server/`) |
| Gegevens | Netlify Database, Postgres (`netlify/database/migrations/`) |
| Stukken | Netlify Blobs, in delen van 3,5 MB (limiet van Netlify Functions) |
| Login | Eigen accounts: scrypt-wachtwoorden, sessiecookie, eenmalige uitnodigings- en resetlinks |
| AI-assistent | Claude via Netlify AI Gateway (`server/ai.ts`), zonder eigen API-sleutel |

De gekozen organisatie gaat mee in de header `x-organisation` en bepaalt wat de overzichten tonen. Toegang tot een overleg, vergadering of stuk wordt altijd op het object zelf gecontroleerd (`server/access.ts`), nooit op basis van die header.

### Passkeys en tweestapsverificatie

- Een passkey is twee factoren in één: het apparaat (bezit) plus vingerafdruk, gezicht of pincode. Elke sessie onthoudt of ze met een passkey of met een wachtwoord is ingelogd (`sessions.method`).
- Stelt een organisatie een passkey verplicht, dan weigeren alle toegangspaden (`server/access.ts`) een wachtwoordsessie met de code `passkey_required`. De frontend toont dan hoe je met een passkey binnenkomt.
- De eerste passkey kan vanuit een wachtwoordsessie worden aangemaakt. Een extra passkey toevoegen, een passkey verwijderen, het wachtwoord verwijderen en de eis in- of uitschakelen kan alleen vanuit een passkey-sessie. Zo kan iemand met alleen een buitgemaakt wachtwoord een beveiligd account niet overnemen.
- Apparaat kwijt: de platformbeheerder wist de passkeys van het account en stuurt een resetlink.
- Een passkey is gebonden aan het webadres waarop hij is aangemaakt. Verhuist het platform naar een eigen domein, zet dan eerst `RP_ID` en laat mensen pas daarna passkeys aanmaken: passkeys van het oude adres werken op het nieuwe niet.

### Vergadermodus

- De stand (bezig of niet, het actuele punt) staat bij de vergadering. Het scherm vraagt die elke 4 seconden op zolang het zichtbaar is; alleen als er iets is gewijzigd, haalt het de hele vergadering opnieuw op.
- Alleen de secretaris of beheerder start, wisselt van punt en beëindigt. Afronden of terugzetten naar concept beëindigt de vergadermodus vanzelf.

### AI-assistent

- Staat per organisatie uit tot een beheerder van die organisatie hem aanzet onder Toegang en beheer. Notulen en stukken waarop iemand de assistent gebruikt, gaan dan voor verwerking naar een taalmodel buiten het platform, mogelijk buiten de EU. Weeg dat af bij vertrouwelijke stukken.
- Netlify AI Gateway zet de toegang tot het model op de server klaar; het verbruik gaat van de Netlify-credits van het team. Er hoeft geen sleutel beheerd te worden. De gateway werkt na de eerste productie-deploy en alleen op een Netlify-abonnement met credits.
- Een samenvatting wordt één keer gemaakt en daarna bewaard bij het stuk. Samenvatten kan voor pdf (tot 12 MB) en tekstbestanden; Word en Excel eerst opslaan als pdf.
- Limieten tegen onbedoeld verbruik: 30 verzoeken per persoon per uur en 300 per organisatie per dag (`server/ai.ts`).
- Eén verzoek moet binnen 60 seconden klaar zijn (limiet van Netlify Functions). Duurt het langer, dan krijgt de gebruiker een melding.
- Controleren of de koppeling werkt: Platformbeheer, Instellingen, AI-assistent, knop "Test de koppeling".

### Transcript en koppeling met Plaud

- **Koppelen** doet elke gebruiker zelf onder Mijn account. Het platform sluit aan op de officiële MCP-server van Plaud (`mcp.plaud.ai`) met de inlogstandaard van MCP: OAuth met PKCE, waarbij het platform zich per webadres één keer als toepassing aanmeldt. Plaud documenteert deze route voor MCP-clients, niet uitdrukkelijk voor webtoepassingen; wijzigt Plaud iets, dan is plakken als tekst de uitwijk.
- **Sleutels** geven leestoegang tot alle opnames van de gebruiker. Ze staan versleuteld in de database (AES-256-GCM, sleutel in `TOKEN_KEY`) en verlaten de server niet. Het platform leest alleen: de lijst met opnames en het transcript dat de gebruiker kiest (`server/plaud.ts`).
- **Het transcript** is een woordelijk verslag en daarom alleen zichtbaar voor de secretaris en de beheerder. Het is bedoeld om te verwijderen zodra de notulen zijn vastgesteld; dat kan ook na afronden.
- **Concept-notulen** maken duurt langer dan een gewoon verzoek mag duren. Het werk loopt daarom in een achtergrondfunctie (`netlify/functions/api-background.mts`, tot 15 minuten); het scherm vraagt de stand op (`ai_jobs`).
- **Waar de gegevens langs gaan**: de opname en het transcript staan bij Plaud; het ophalen loopt via Plaud's MCP-server in de VS; het maken van concept-notulen stuurt het transcript naar het taalmodel (zie AI-assistent). Informeer deelnemers vooraf dat de vergadering wordt opgenomen.

Het platform verstuurt zelf geen e-mail. Uitnodigingslinks kopieert of mailt de secretaris of beheerder zelf; resetlinks (wachtwoord vergeten) maakt alleen de platformbeheerder.

## Lokaal draaien

```bash
npm install
```

```bash
printf "SETUP_CODE=lokale-testcode\nAI_FAKE=1\nTOKEN_KEY=lokale-sleutel\nPLAUD_MCP_URL=http://localhost:8899/mcp\n" > .env
```

```bash
npm run dev
```

In een tweede terminal, eenmalig en na elke nieuwe migratie:

```bash
npm run db:migrate
```

Open daarna http://localhost:8888/#lokale-testcode om het eerste beheerdersaccount en de eerste organisatie aan te maken.

`AI_FAKE=1` werkt alleen lokaal: de AI-assistent geeft dan vaste antwoorden (`server/ai-fake.ts`) in plaats van een taalmodel aan te roepen. Zo draaien de schermen en de tests zonder gateway.

`PLAUD_MCP_URL` werkt ook alleen lokaal en wijst naar een nagebouwde Plaud-server (`scripts/fake-plaud.mjs`). Die doet het inloggen, het verversen van sleutels en het leveren van opnames en transcripten na in het formaat van Plaud. De test start hem zelf; om de schermen met de hand te proberen: `node scripts/fake-plaud.mjs`.

## Testen

Met de lokale server aan en een lege database:

```bash
npm run test:e2e
```

De test doorloopt ook de passkeys, met een software-authenticator (`scripts/soft-authenticator.mjs`) die doet wat een telefoon of laptop doet, en de koppeling met Plaud tegen de nagebouwde server (poort 8899 moet vrij zijn).

De herkenning van geplakte agenda's:

```bash
npm run test:parse
```

## Instructiefilm opnieuw opnemen

De film wordt opgenomen door een script dat met fictieve gegevens door de schermen loopt. Na een wijziging aan de schermen is hij zo opnieuw te maken. Nodig: Playwright met Chromium en ffmpeg.

1. Start de lokale server met een lege database en `scripts/film/demo.env` als `.env`, en draai de migraties.
2. `node scripts/film/seed-demo.cjs > demo.json` vult de demogegevens.
3. `REC=1 node scripts/film/film.cjs uit "$(cat demo.json)"` neemt de beelden op (zonder `REC=1`: alleen schermafbeeldingen, als snelle controle).
4. `node scripts/film/montage.cjs uit instructiefilm.mp4` maakt de film met ondertitels.

De samenvatting en de voorstellen in de film komen uit de lokale testmodus, niet uit het taalmodel.

## Instellingen (Netlify-omgevingsvariabelen)

| Variabele | Betekenis |
|---|---|
| `SETUP_CODE` | Eenmalige code waarmee de eerste platformbeheerder zijn account aanmaakt. Daarna zonder functie; verwijder de variabele na de inrichting. |
| `RP_ID` | Domein waaraan passkeys worden gebonden. Standaard de hostnaam van de site. Alleen zetten bij een eigen domein, en vóórdat er passkeys zijn aangemaakt. |
| `BLOB_REGION` | Regio van de stukken (standaard `eu-central-1`). Niet wijzigen na ingebruikname: bestaande stukken verhuizen niet mee. |
| `TOKEN_KEY` | Geheime sleutel waarmee de toegang tot Plaud versleuteld wordt opgeslagen. Zonder deze variabele is de koppeling met Plaud uitgeschakeld. Wijzigen maakt bestaande koppelingen ongeldig: gebruikers koppelen dan opnieuw. |
| `AI_MODEL` | Model van de AI-assistent (standaard `claude-opus-5-5`). Alleen een actueel Claude-model dat Netlify AI Gateway aanbiedt. |

## Schemawijzigingen

Nieuwe SQL-bestanden in `netlify/database/migrations/`. Netlify past ze toe bij de deploy. Een toegepaste migratie nooit achteraf wijzigen: schrijf een nieuwe.
