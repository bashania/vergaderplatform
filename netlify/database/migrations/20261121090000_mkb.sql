-- Agenda-abonnement: een persoonlijke, geheime link waarmee Outlook of Google Agenda de vergaderingen
-- ophaalt. Alleen de hash van de sleutel staat hier; de link zelf is één keer zichtbaar.
ALTER TABLE users ADD COLUMN calendar_token_hash text;
ALTER TABLE users ADD COLUMN calendar_token_at timestamptz;
CREATE UNIQUE INDEX users_calendar_token_idx ON users (calendar_token_hash) WHERE calendar_token_hash IS NOT NULL;

-- Agendapunten die deelnemers aandragen; de secretaris zet ze op een agenda of wijst ze af.
CREATE TABLE suggestions (
  id uuid PRIMARY KEY,
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'geplaatst', 'afgewezen')),
  reply text NOT NULL DEFAULT '',
  agenda_item_id uuid REFERENCES agenda_items(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  handled_at timestamptz
);
CREATE INDEX suggestions_overleg_idx ON suggestions (overleg_id, status);

-- E-mail vanuit het platform. Elke verzonden mail staat in het logboek: voor de beheerder
-- (is het aangekomen bij de mailserver?) en om een herinnering nooit twee keer te sturen.
CREATE TABLE mail_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  to_email text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'bezig' CHECK (status IN ('bezig', 'verzonden', 'mislukt')),
  error text NOT NULL DEFAULT '',
  dedupe_key text UNIQUE
);
CREATE INDEX mail_log_at_idx ON mail_log (at DESC);

-- Herinneringen (vergadering morgen, acties die aflopen) kan iedereen voor zichzelf uitzetten.
ALTER TABLE users ADD COLUMN mail_reminders boolean NOT NULL DEFAULT true;
