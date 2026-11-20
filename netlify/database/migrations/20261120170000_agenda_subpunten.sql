-- Agenda's uit de praktijk hebben subpunten (2.1, 2.2) en eigen labels
-- ("Ter vaststelling", "Ter bespreking en voor afspraken").

-- Subpunten: één niveau diep. Een hoofdpunt verwijderen verwijdert ook de subpunten.
ALTER TABLE agenda_items ADD COLUMN parent_id uuid REFERENCES agenda_items(id) ON DELETE CASCADE;
CREATE INDEX agenda_items_parent_idx ON agenda_items (parent_id);

-- Het soort agendapunt wordt een vrij label in plaats van drie vaste waarden.
ALTER TABLE agenda_items DROP CONSTRAINT agenda_items_kind_check;
ALTER TABLE agenda_items ALTER COLUMN kind SET DEFAULT '';
UPDATE agenda_items
   SET kind = CASE kind
                WHEN 'informatie' THEN 'Ter informatie'
                WHEN 'bespreking' THEN 'Ter bespreking'
                WHEN 'besluit' THEN 'Ter besluitvorming'
                ELSE kind
              END;

-- Toelichting bij de agenda als geheel: staat boven de agenda en op de afdruk.
ALTER TABLE meetings ADD COLUMN description text NOT NULL DEFAULT '';
