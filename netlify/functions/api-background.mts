import type { Config, Context } from "@netlify/functions";
import { handle } from "../../server/router";
import "../../server/routes/transcripts";

// Achtergrondfunctie voor werk dat langer duurt dan de 60 seconden van een gewoon verzoek
// (concept-notulen uit een transcript). De aanroeper krijgt direct een 202; het resultaat
// komt in de database en het scherm vraagt de stand op via /api/jobs/:id.
export default (req: Request, context: Context) => handle(req, context);

export const config: Config = {
  background: true,
  path: "/api/background/*",
};
