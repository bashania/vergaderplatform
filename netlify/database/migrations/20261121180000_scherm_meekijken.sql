-- Het stuk dat tijdens de vergadermodus op het scherm staat, met de pagina waar de secretaris is.
ALTER TABLE meetings ADD COLUMN live_doc_id uuid REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE meetings ADD COLUMN live_doc_page integer;

-- Meekijken zonder account: de secretaris zet het per vergadering aan. De link (QR-code) en de korte code
-- gelden alleen zolang de vergadermodus loopt, en hooguit tot watch_until.
ALTER TABLE meetings ADD COLUMN watch_token text;
ALTER TABLE meetings ADD COLUMN watch_code text;
ALTER TABLE meetings ADD COLUMN watch_until timestamptz;
CREATE UNIQUE INDEX meetings_watch_token_idx ON meetings (watch_token) WHERE watch_token IS NOT NULL;
CREATE UNIQUE INDEX meetings_watch_code_idx ON meetings (watch_code) WHERE watch_code IS NOT NULL;
