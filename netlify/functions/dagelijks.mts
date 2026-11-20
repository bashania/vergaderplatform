import type { Config, Context } from "@netlify/functions";
import { env } from "../../server/http";
import { hasSecretKey, taskKey } from "../../server/secret";

// Dagelijkse taak: herinneringen voor de vergaderingen van morgen en voor acties die aflopen.
// Een geplande functie mag maar 30 seconden duren; het werk zelf loopt daarom in de
// achtergrondfunctie (api-background.mts), die hier alleen wordt aangestoten.
export default async (_req: Request, context: Context) => {
  const site = context.site?.url ?? env("URL");
  if (!site || !hasSecretKey()) return;
  const res = await fetch(`${site}/api/background/daily`, {
    method: "POST",
    headers: { origin: site, "content-type": "application/json", "x-task-key": taskKey("daily") },
    body: "{}",
  });
  console.log("dagelijkse herinneringen aangestoten:", res.status);
};

export const config: Config = {
  // 05:30 UTC is 06:30 (winter) of 07:30 (zomer) in Nederland: de herinnering ligt klaar bij het begin van de werkdag.
  schedule: "30 5 * * *",
};
