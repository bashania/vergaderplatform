-- Eén platform voor meerdere organisaties: elk overleg hoort bij een organisatie
-- (vrije tekst, bijvoorbeeld de naam van het bedrijf, de opleiding of de commissie).
-- Overleggen worden hierop gegroepeerd en de naam staat op afgedrukte agenda's.
ALTER TABLE overleggen ADD COLUMN organisation text NOT NULL DEFAULT '';
