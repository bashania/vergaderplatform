-- Vergaderplatform: basisschema
-- ID's (uuid) worden door de applicatie aangemaakt.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  is_admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- Eenmalige links: uitnodiging (wachtwoord kiezen) of wachtwoord-reset.
CREATE TABLE user_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX user_tokens_user_idx ON user_tokens (user_id);

CREATE TABLE login_attempts (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  ip text,
  success boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_at ON login_attempts (email, at);
CREATE INDEX login_attempts_ip_at ON login_attempts (ip, at);

-- Een overleg is een vast gremium: MT, VvE-bestuur, bouwvergadering van een project.
CREATE TABLE overleggen (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('secretaris', 'deelnemer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (overleg_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);

CREATE TABLE meetings (
  id uuid PRIMARY KEY,
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  duration_min integer NOT NULL DEFAULT 60,
  location text NOT NULL DEFAULT '',
  online_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'concept' CHECK (status IN ('concept', 'gepubliceerd', 'afgerond')),
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX meetings_overleg_starts ON meetings (overleg_id, starts_at);

CREATE TABLE agenda_items (
  id uuid PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  position integer NOT NULL,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'bespreking' CHECK (kind IN ('informatie', 'bespreking', 'besluit')),
  presenter text NOT NULL DEFAULT '',
  duration_min integer,
  description text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT ''
);
CREATE INDEX agenda_items_meeting_idx ON agenda_items (meeting_id, position);

-- Metadata van stukken; de inhoud staat in delen (chunks) in Netlify Blobs.
-- meeting_id NULL = vast stuk van het overleg (reglement, jaarplan, contracten).
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE CASCADE,
  agenda_item_id uuid REFERENCES agenda_items(id) ON DELETE SET NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size bigint NOT NULL,
  chunk_size integer NOT NULL,
  chunk_count integer NOT NULL,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_meeting_idx ON documents (meeting_id);
CREATE INDEX documents_overleg_idx ON documents (overleg_id);

-- Doorlopende besluitnummering per overleg per jaar (2026-001, 2026-002, ...).
CREATE TABLE decision_counters (
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  year integer NOT NULL,
  last integer NOT NULL,
  PRIMARY KEY (overleg_id, year)
);

-- Geen cascade vanaf meetings: een vergadering met besluiten of acties
-- kan niet stilzwijgend verdwijnen.
CREATE TABLE decisions (
  id uuid PRIMARY KEY,
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  agenda_item_id uuid REFERENCES agenda_items(id) ON DELETE SET NULL,
  number text NOT NULL,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'genomen' CHECK (status IN ('genomen', 'ingetrokken')),
  decided_on date NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_overleg_idx ON decisions (overleg_id, decided_on DESC);
CREATE INDEX decisions_meeting_idx ON decisions (meeting_id);

CREATE TABLE actions (
  id uuid PRIMARY KEY,
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  agenda_item_id uuid REFERENCES agenda_items(id) ON DELETE SET NULL,
  text text NOT NULL,
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  due_date date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'gereed', 'vervallen')),
  done_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actions_overleg_idx ON actions (overleg_id, status);
CREATE INDEX actions_owner_idx ON actions (owner_id, status);
CREATE INDEX actions_meeting_idx ON actions (meeting_id);

CREATE TABLE attendance (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('aanwezig', 'afwezig')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  user_name text,
  action text NOT NULL,
  detail jsonb
);
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value text NOT NULL
);
