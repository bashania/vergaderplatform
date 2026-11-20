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

De gekozen organisatie gaat mee in de header `x-organisation` en bepaalt wat de overzichten tonen. Toegang tot een overleg, vergadering of stuk wordt altijd op het object zelf gecontroleerd (`server/access.ts`), nooit op basis van die header.

### Passkeys en tweestapsverificatie

- Een passkey is twee factoren in één: het apparaat (bezit) plus vingerafdruk, gezicht of pincode. Elke sessie onthoudt of ze met een passkey of met een wachtwoord is ingelogd (`sessions.method`).
- Stelt een organisatie een passkey verplicht, dan weigeren alle toegangspaden (`server/access.ts`) een wachtwoordsessie met de code `passkey_required`. De frontend toont dan hoe je met een passkey binnenkomt.
- De eerste passkey kan vanuit een wachtwoordsessie worden aangemaakt. Een extra passkey toevoegen, een passkey verwijderen, het wachtwoord verwijderen en de eis in- of uitschakelen kan alleen vanuit een passkey-sessie. Zo kan iemand met alleen een buitgemaakt wachtwoord een beveiligd account niet overnemen.
- Apparaat kwijt: de platformbeheerder wist de passkeys van het account en stuurt een resetlink.
- Een passkey is gebonden aan het webadres waarop hij is aangemaakt. Verhuist het platform naar een eigen domein, zet dan eerst `RP_ID` en laat mensen pas daarna passkeys aanmaken: passkeys van het oude adres werken op het nieuwe niet.

Het platform verstuurt zelf geen e-mail. Uitnodigingslinks kopieert of mailt de secretaris of beheerder zelf; resetlinks (wachtwoord vergeten) maakt alleen de platformbeheerder.

## Lokaal draaien

```bash
npm install
```

```bash
echo "SETUP_CODE=lokale-testcode" > .env
```

```bash
npm run dev
```

In een tweede terminal, eenmalig en na elke nieuwe migratie:

```bash
npm run db:migrate
```

Open daarna http://localhost:8888/#lokale-testcode om het eerste beheerdersaccount en de eerste organisatie aan te maken.

## Testen

Met de lokale server aan en een lege database:

```bash
npm run test:e2e
```

De test doorloopt ook de passkeys, met een software-authenticator (`scripts/soft-authenticator.mjs`) die doet wat een telefoon of laptop doet.

De herkenning van geplakte agenda's:

```bash
npm run test:parse
```

## Instellingen (Netlify-omgevingsvariabelen)

| Variabele | Betekenis |
|---|---|
| `SETUP_CODE` | Eenmalige code waarmee de eerste platformbeheerder zijn account aanmaakt. Daarna zonder functie; verwijder de variabele na de inrichting. |
| `RP_ID` | Domein waaraan passkeys worden gebonden. Standaard de hostnaam van de site. Alleen zetten bij een eigen domein, en vóórdat er passkeys zijn aangemaakt. |
| `BLOB_REGION` | Regio van de stukken (standaard `eu-central-1`). Niet wijzigen na ingebruikname: bestaande stukken verhuizen niet mee. |

## Schemawijzigingen

Nieuwe SQL-bestanden in `netlify/database/migrations/`. Netlify past ze toe bij de deploy. Een toegepaste migratie nooit achteraf wijzigen: schrijf een nieuwe.
