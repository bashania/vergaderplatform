-- Eén platform, meerdere organisaties. Elke organisatie is een eigen omgeving met
-- eigen overleggen en eigen beheerders. Wie toegang heeft tot een organisatie volgt
-- uit het beheerderschap of uit deelname aan een van haar overleggen: er is bewust
-- geen aparte ledenlijst die daarmee uit de pas kan lopen.

CREATE TABLE organisations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organisations_name_key ON organisations (lower(name));

CREATE TABLE organisation_admins (
  organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id)
);
CREATE INDEX organisation_admins_user_idx ON organisation_admins (user_id);

ALTER TABLE overleggen ADD COLUMN organisation_id uuid REFERENCES organisations(id);

-- Overleggen van vóór deze migratie komen samen in één organisatie, met de bestaande
-- platformbeheerders als beheerder. Op een lege database doet dit niets.
INSERT INTO organisations (id, name)
SELECT gen_random_uuid(), 'Mijn organisatie' WHERE EXISTS (SELECT 1 FROM overleggen);

UPDATE overleggen
   SET organisation_id = (SELECT id FROM organisations ORDER BY created_at LIMIT 1)
 WHERE organisation_id IS NULL;

INSERT INTO organisation_admins (organisation_id, user_id)
SELECT o.id, u.id FROM organisations o CROSS JOIN users u WHERE u.is_admin;

ALTER TABLE overleggen ALTER COLUMN organisation_id SET NOT NULL;
CREATE INDEX overleggen_organisation_idx ON overleggen (organisation_id);
