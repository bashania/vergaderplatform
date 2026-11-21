#!/bin/bash
# Start de lokale server met een lege database voor de tests: de gebouwde schermen, de functies,
# de database en de opslag, zonder verbinding met Netlify. Gebruikt door de automatische tests
# (.github/workflows/test.yml) en ook met de hand te draaien na `npm run build`.
set -e
cd "$(dirname "$0")/.."
cp scripts/test.env .env
# Lege database en lege opslag; een koppeling met een Netlify-project (.netlify/state.json) blijft staan.
rm -rf .netlify/db .netlify/blobs-serve
nohup npx netlify dev --framework "#static" --dir dist --no-open --geo mock --offline -c "sleep 1000000" > dev.log 2>&1 &
for _ in $(seq 1 90); do
  if grep -q "Loaded function api$" dev.log; then break; fi
  sleep 2
done
if ! grep -q "Loaded function api$" dev.log; then
  echo "De lokale server is niet gestart:" >&2
  cat dev.log >&2
  exit 1
fi
npx netlify database migrations apply
