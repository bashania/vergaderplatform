-- Eigen aantekeningen bij een agendapunt: van één deelnemer, alleen zichtbaar voor die deelnemer.
-- Ze horen niet bij het verslag en komen in geen enkel overzicht, bericht of scherm van een ander.
CREATE TABLE personal_notes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agenda_item_id uuid NOT NULL REFERENCES agenda_items(id) ON DELETE CASCADE,
  text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, agenda_item_id)
);
CREATE INDEX personal_notes_item_idx ON personal_notes (agenda_item_id);
