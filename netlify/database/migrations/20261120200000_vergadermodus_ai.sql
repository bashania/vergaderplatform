-- Vergadermodus: tijdens de vergadering loopt iedereen mee met het actuele agendapunt.
-- live_started_at gevuld = de vergadering is bezig.
ALTER TABLE meetings ADD COLUMN live_started_at timestamptz;
ALTER TABLE meetings ADD COLUMN live_item_id uuid REFERENCES agenda_items(id) ON DELETE SET NULL;
ALTER TABLE meetings ADD COLUMN live_item_started_at timestamptz;

-- Werkelijk bestede tijd per agendapunt (seconden), opgeteld telkens als het punt wordt verlaten.
ALTER TABLE agenda_items ADD COLUMN spent_sec integer NOT NULL DEFAULT 0;

-- AI-assistent: staat per organisatie uit, tot een beheerder van die organisatie hem aanzet.
-- Notulen en stukken gaan dan voor verwerking naar een taalmodel buiten het platform.
ALTER TABLE organisations ADD COLUMN ai_enabled boolean NOT NULL DEFAULT false;

-- Samenvatting van een stuk: één keer gemaakt, daarna voor iedereen met toegang direct beschikbaar.
ALTER TABLE documents ADD COLUMN summary text NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN summary_at timestamptz;

-- Elk verzoek aan het taalmodel: voor de limiet per gebruiker en organisatie, en voor inzicht in het verbruik.
CREATE TABLE ai_calls (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  organisation_id uuid REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL,
  model text NOT NULL DEFAULT '',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  ok boolean NOT NULL DEFAULT true
);
CREATE INDEX ai_calls_org_at_idx ON ai_calls (organisation_id, at DESC);
CREATE INDEX ai_calls_user_at_idx ON ai_calls (user_id, at DESC);
