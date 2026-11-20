import { parseAgenda, countItems } from "../src/agendaParse.ts";
import assert from "node:assert/strict";

// 1. De tekst zoals die uit de pdf van de RvT-agenda komt bij kopiëren (inclusief kop en voettekst).
const rvt = `Agenda RvT
Donderdag 3 december 2026 | Rijswijk
Concept | aangepast op 20 november 2026
Schildersvakopleiding | Conceptagenda | 20 november 2026 1
Aanvang 09.00 uur.
1 Opening en vaststelling agenda Ter vaststelling
2 Mededelingen directie
2.1 Voortgang verbouwing en verhuizing Ter informatie
2.2 Remplooi / arbodienst Ter informatie
2.3 Bedrijfsmakelaar Martijn de Lange: verhuur kantoorruimte
Visseringlaan 16, 2e verdieping
Ter informatie
2.4 Afspraken Koegler Ter bespreking en voor afspraken
2.5 Q3-cijfers 2026 Ter bespreking en voor afspraken
2.6 Liquiditeitsprognose Ter bespreking en voor afspraken
3 Rendabiliteit Hoofddorp Ter bespreking
4 Personeelsontwikkeling Ter informatie
5 Bespreking statuten Ter bespreking
Statuten: bespreking van de stukken en voorgestelde wijzigingen. Wanneer meer tijd nodig is, wordt een vervolgafspraak
gemaakt. Dit agendapunt is als bespreking opgenomen.
Vergaderstukken: de directie voegt de actuele financiële stukken en de onderleggers voor de overige onderwerpen, waaronder
de statuten, aan het complete pakket toe. De uitgebreide Remplooi-offerte blijft een afzonderlijke bijlage.`;
const a = parseAgenda(rvt);
for (const [i, it] of a.entries()) {
  console.log(`${i + 1}  ${it.title}  [${it.kind}]${it.description ? "  (+toelichting)" : ""}`);
  for (const [j, ch] of it.children.entries()) console.log(`   ${i + 1}.${j + 1}  ${ch.title}  [${ch.kind}]`);
}
assert.equal(a.length, 5);
assert.equal(countItems(a), 11);
assert.deepEqual(a.map((x) => x.title), ["Opening en vaststelling agenda", "Mededelingen directie", "Rendabiliteit Hoofddorp", "Personeelsontwikkeling", "Bespreking statuten"]);
assert.deepEqual(a.map((x) => x.kind), ["Ter vaststelling", "", "Ter bespreking", "Ter informatie", "Ter bespreking"]);
assert.equal(a[1].children.length, 6);
assert.equal(a[1].children[2].title, "Bedrijfsmakelaar Martijn de Lange: verhuur kantoorruimte Visseringlaan 16, 2e verdieping");
assert.equal(a[1].children[2].kind, "Ter informatie");
assert.equal(a[1].children[3].kind, "Ter bespreking en voor afspraken");
assert.ok(a[4].description.startsWith("Statuten: bespreking"));
assert.ok(a[4].description.includes("Vergaderstukken:"));

// 2. Zonder nummering: elke regel een punt.
const plain = parseAgenda("Opening\nNotulen vorige keer (ter vaststelling)\n\nRondvraag");
assert.deepEqual(plain.map((x) => [x.title, x.kind]), [["Opening", ""], ["Notulen vorige keer", "Ter vaststelling"], ["Rondvraag", ""]]);

// 3. Nummering met punt of haakje, en een datum die geen agendapunt mag worden.
const dotted = parseAgenda("1. Opening\n2) Begroting 2027 Ter besluitvorming\n20 november is de deadline\n3. Rondvraag");
assert.deepEqual(dotted.map((x) => x.title), ["Opening", "Begroting 2027", "Rondvraag"]);
assert.equal(dotted[1].kind, "Ter besluitvorming");
assert.equal(dotted[1].description, "20 november is de deadline");

// 4. Nummer, onderwerp en label elk op een eigen regel (zo kopiëren sommige pdf-viewers).
const split = parseAgenda("1\nOpening en vaststelling agenda\nTer vaststelling\n2\nMededelingen directie\n2.1\nVerbouwing\nTer informatie\n3\nRondvraag");
assert.deepEqual(split.map((x) => [x.title, x.kind, x.children.length]), [["Opening en vaststelling agenda", "Ter vaststelling", 0], ["Mededelingen directie", "", 1], ["Rondvraag", "", 0]]);
assert.deepEqual([split[1].children[0].title, split[1].children[0].kind], ["Verbouwing", "Ter informatie"]);

// 5. Lege invoer.
assert.deepEqual(parseAgenda("  \n "), []);
console.log("\nalle parsertests geslaagd");
