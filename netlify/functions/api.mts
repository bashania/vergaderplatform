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

// Eén functie voor de hele API: gedeelde code, één koude start.
export default (req: Request, context: Context) => handle(req, context);

export const config: Config = {
  path: "/api/*",
};
