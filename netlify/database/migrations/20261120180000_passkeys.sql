-- Passkeys (WebAuthn): inloggen met het apparaat plus vingerafdruk, gezicht of pincode.
-- Dat zijn samen twee factoren, zonder wachtwoord om te onthouden of te lekken.

CREATE TABLE passkeys (
  id text PRIMARY KEY,                    -- credential-id (base64url)
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key text NOT NULL,               -- COSE-sleutel (base64url)
  counter bigint NOT NULL DEFAULT 0,
  transports text NOT NULL DEFAULT '',    -- kommagescheiden hint voor de browser
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

-- Eenmalige uitdaging per registratie of inlogpoging, kort geldig.
CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY,
  challenge text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('register', 'login')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Hoe is deze sessie ingelogd? Alleen 'passkey' telt als tweestapsverificatie.
ALTER TABLE sessions ADD COLUMN method text NOT NULL DEFAULT 'password' CHECK (method IN ('password', 'passkey'));

-- Per organisatie af te dwingen: alleen toegang met een passkey-sessie.
ALTER TABLE organisations ADD COLUMN require_passkey boolean NOT NULL DEFAULT false;
