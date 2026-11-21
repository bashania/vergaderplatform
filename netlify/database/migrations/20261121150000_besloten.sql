-- Besloten overleg: alleen de deelnemers zien het. Het beheer van de organisatie geeft er geen toegang toe.
ALTER TABLE overleggen ADD COLUMN besloten boolean NOT NULL DEFAULT false;

-- Een besloten kring hoort bij een overleg: een deel van de deelnemers, bijvoorbeeld de toezichthouders zonder de bestuurder.
ALTER TABLE overleggen ADD COLUMN parent_id uuid REFERENCES overleggen(id) ON DELETE SET NULL;
CREATE INDEX overleggen_parent_idx ON overleggen (parent_id) WHERE parent_id IS NOT NULL;
