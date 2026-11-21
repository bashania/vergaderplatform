import type { Config, Context } from "@netlify/functions";
import { handle } from "../../server/router";
import "../../server/routes/auth";
import "../../server/routes/admin";
import "../../server/routes/passkeys";
import "../../server/routes/organisations";
import "../../server/routes/overleg";
import "../../server/routes/meetings";
import "../../server/routes/records";
import "../../server/routes/documents";
import "../../server/routes/ai";
import "../../server/routes/plaud";
import "../../server/routes/transcripts";
import "../../server/routes/calendar";
import "../../server/routes/suggestions";
import "../../server/routes/mail";
import "../../server/routes/insights";
import "../../server/routes/rsvp";
import "../../server/routes/ballots";
import "../../server/routes/system";
import "../../server/routes/backup";

// Eén functie voor de hele API: gedeelde code, één koude start.
export default (req: Request, context: Context) => handle(req, context);

export const config: Config = {
  path: "/api/*",
  // Langlopend werk gaat naar de achtergrondfunctie (api-background.mts).
  excludedPath: "/api/background/*",
};
