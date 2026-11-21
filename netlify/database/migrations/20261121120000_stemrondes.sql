-- Stemronde: een besluit nemen buiten de vergadering om. De secretaris legt een voorstel voor,
-- de deelnemers van het overleg stemmen, en een aangenomen voorstel komt in de besluitenlijst.
CREATE TABLE ballots (
  id uuid PRIMARY KEY,
  overleg_id uuid NOT NULL REFERENCES overleggen(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  closes_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'aangenomen', 'verworpen', 'ingetrokken')),
  decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at timestamptz
);
CREATE INDEX ballots_overleg_idx ON ballots (overleg_id, status);

-- Stemmen zijn open: iedereen in het overleg ziet wie wat heeft gestemd, zoals aan de vergadertafel.
CREATE TABLE ballot_votes (
  ballot_id uuid NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote text NOT NULL CHECK (vote IN ('akkoord', 'niet_akkoord', 'onthouding')),
  comment text NOT NULL DEFAULT '',
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ballot_id, user_id)
);
