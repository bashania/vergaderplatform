# Vergaderplatform

Agenda's, stukken, besluiten en acties op één plek, zodat alle deelnemers altijd bij de stukken kunnen.

## Wat het doet

- **Overleggen**: elk gremium (MT, bestuur, projectoverleg) heeft eigen deelnemers, vergaderingen, besluitenlijst, actielijst en vaste stukken.
- **Meerdere organisaties**: elk overleg hoort bij een organisatie (bedrijf, opleiding, commissie). Het overzicht groepeert daarop en de naam staat op afgedrukte agenda's. Deelnemers zien alleen de overleggen waar ze zelf in zitten.
- **Uitnodigen**: de secretaris voegt deelnemers toe op e-mailadres. Bestaat het account al, dan wordt het gekoppeld; anders ontstaat een uitnodigingslink. Er is bewust geen lijst van alle accounts.
- **Vergaderingen**: agenda met agendapunten (ter informatie, bespreking of besluitvorming), stukken per agendapunt, notulen, aanwezigheid.
- **Besluiten**: automatisch doorlopend genummerd per overleg per jaar (2026-001, 2026-002, ...).
- **Acties**: actiehouder en deadline; de actiehouder meldt zelf af. Open acties komen terug op de actielijst van de volgende vergadering.
- **Rollen**: beheerder (alles), secretaris (beheert één overleg), deelnemer (leest, levert stukken aan, meldt eigen acties af).
- **Status**: concept (alleen secretaris) → gepubliceerd (deelnemers zien alles) → afgerond (vergrendeld).

## Techniek

| Onderdeel | Keuze |
|---|---|
| Frontend | React + Vite (`src/`) |
| API | Eén Netlify Function (`netlify/functions/api.mts`, code in `server/`) |
| Gegevens | Netlify Database, Postgres (`netlify/database/migrations/`) |
| Stukken | Netlify Blobs, in delen van 3,5 MB (limiet van Netlify Functions) |
| Login | Eigen accounts: scrypt-wachtwoorden, sessiecookie, eenmalige uitnodigings- en resetlinks |

Het platform verstuurt zelf geen e-mail. Uitnodigingslinks kopieert of mailt de secretaris of beheerder zelf; resetlinks (wachtwoord vergeten) maakt alleen de beheerder.

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

Open daarna http://localhost:8888/#lokale-testcode om het eerste beheerdersaccount aan te maken.

## Testen

Met de lokale server aan en een lege database:

```bash
npm run test:e2e
```

## Instellingen (Netlify-omgevingsvariabelen)

| Variabele | Betekenis |
|---|---|
| `SETUP_CODE` | Eenmalige code waarmee de eerste beheerder zijn account aanmaakt. Daarna zonder functie. |
| `BLOB_REGION` | Regio van de stukken (standaard `eu-central-1`). Niet wijzigen na ingebruikname: bestaande stukken verhuizen niet mee. |

## Schemawijzigingen

Nieuwe SQL-bestanden in `netlify/database/migrations/`. Netlify past ze toe bij de deploy. Een toegepaste migratie nooit achteraf wijzigen: schrijf een nieuwe.
