/**
 * Standaardagenda's voor veelvoorkomende overleggen in het mkb. Een startpunt: na het aanmaken
 * pas je de agenda aan, en de volgende keer neem je gewoon de agenda van de vorige vergadering over.
 */
export type TemplateItem = { title: string; kind?: string };

export const AGENDA_TEMPLATES: { key: string; name: string; items: TemplateItem[] }[] = [
  {
    key: "mt",
    name: "MT-overleg",
    items: [
      { title: "Opening en mededelingen", kind: "Ter informatie" },
      { title: "Verslag en actielijst vorige vergadering", kind: "Ter vaststelling" },
      { title: "Cijfers en voortgang", kind: "Ter bespreking" },
      { title: "Mensen en organisatie", kind: "Ter bespreking" },
      { title: "Klanten en opdrachten", kind: "Ter bespreking" },
      { title: "Besluiten", kind: "Ter besluitvorming" },
      { title: "Rondvraag en sluiting" },
    ],
  },
  {
    key: "werk",
    name: "Werkoverleg",
    items: [
      { title: "Opening en mededelingen", kind: "Ter informatie" },
      { title: "Actielijst vorige keer", kind: "Ter bespreking" },
      { title: "Planning en bezetting", kind: "Ter bespreking" },
      { title: "Veiligheid en kwaliteit", kind: "Ter bespreking" },
      { title: "Knelpunten en verbeterideeën", kind: "Ter bespreking" },
      { title: "Rondvraag en sluiting" },
    ],
  },
  {
    key: "project",
    name: "Projectoverleg",
    items: [
      { title: "Opening", kind: "Ter informatie" },
      { title: "Verslag en actielijst vorige vergadering", kind: "Ter vaststelling" },
      { title: "Voortgang en planning", kind: "Ter bespreking" },
      { title: "Financiën, meer- en minderwerk", kind: "Ter bespreking" },
      { title: "Risico's en knelpunten", kind: "Ter bespreking" },
      { title: "Afspraken en besluiten", kind: "Ter besluitvorming" },
      { title: "Rondvraag en sluiting" },
    ],
  },
  {
    key: "bestuur",
    name: "Bestuursvergadering",
    items: [
      { title: "Opening en vaststellen agenda", kind: "Ter vaststelling" },
      { title: "Verslag vorige vergadering", kind: "Ter vaststelling" },
      { title: "Ingekomen stukken en mededelingen", kind: "Ter informatie" },
      { title: "Financiën", kind: "Ter bespreking" },
      { title: "Lopende zaken", kind: "Ter bespreking" },
      { title: "Besluiten", kind: "Ter besluitvorming" },
      { title: "Rondvraag en sluiting" },
    ],
  },
];
