-- Koppeling met Plaud, per gebruiker. De toegangssleutels geven toegang tot alle opnames van die
-- gebruiker en staan daarom versleuteld in de database (sleutel: omgevingsvariabele TOKEN_KEY).
CREATE TABLE plaud_connections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  refresh_token text NOT NULL DEFAULT '',
  expires_at timestamptz,
  connected_at timestamptz NOT NULL DEFAULT now()
);

-- Lopende inlogpogingen bij Plaud (OAuth met PKCE): eenmalig en kort geldig.
CREATE TABLE oauth_states (
  state text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Het transcript van een vergadering: woordelijk wie wat zei, dus alleen voor de secretaris
-- en bedoeld om na het vaststellen van het verslag te verwijderen. Eén per vergadering.
CREATE TABLE transcripts (
  meeting_id uuid PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('plaud', 'tekst')),
  title text NOT NULL DEFAULT '',
  recorded_at timestamptz,
  body text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Werk voor de AI-assistent dat langer duurt dan één verzoek mag duren (60 seconden):
-- loopt op de achtergrond, het scherm vraagt de stand op.
CREATE TABLE ai_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'wacht' CHECK (status IN ('wacht', 'bezig', 'klaar', 'mislukt')),
  result jsonb,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX ai_jobs_meeting_idx ON ai_jobs (meeting_id, created_at DESC);
