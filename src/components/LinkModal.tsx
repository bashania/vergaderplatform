import { useUser } from "../auth";
import { Button, CopyBox, Icon, Modal } from "../ui";

export type LinkInfo = { name: string; email: string; token: string; purpose: "invite" | "reset"; validDays: number };

/** Toont de eenmalige link. Er wordt niets automatisch gemaild: wie de link maakt, verstuurt hem zelf. */
export function LinkModal({ link, onClose }: { link: LinkInfo; onClose: () => void }) {
  const user = useUser();
  const url = `${window.location.origin}/welkom#${link.token}`;
  const invite = link.purpose === "invite";
  const subject = invite ? "Uitnodiging voor het vergaderplatform" : "Nieuw wachtwoord voor het vergaderplatform";
  const body = invite
    ? `Beste ${link.name},\n\nJe hebt toegang gekregen tot het vergaderplatform, met de agenda's, stukken, besluiten en acties van ons overleg.\n\nKies via deze link je wachtwoord:\n${url}\n\nDe link is ${link.validDays} dagen geldig en werkt één keer.\n\nMet vriendelijke groet,\n${user.name}`
    : `Beste ${link.name},\n\nVia deze link kies je een nieuw wachtwoord voor het vergaderplatform:\n${url}\n\nDe link is ${link.validDays} dagen geldig en werkt één keer.\n\nMet vriendelijke groet,\n${user.name}`;
  return (
    <Modal title={invite ? "Uitnodigingslink" : "Link voor nieuw wachtwoord"} onClose={onClose}>
      <div className="stack">
        <p>
          Stuur deze link naar <strong>{link.name}</strong> ({link.email}). De link is {link.validDays} dagen geldig en werkt één keer.
        </p>
        <CopyBox value={url} />
        <div className="notice">Het platform verstuurt zelf geen e-mail. Deze link is alleen nu zichtbaar; maak een nieuwe als je hem kwijt bent.</div>
        <div className="form-foot">
          <a className="btn secondary" href={`mailto:${link.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
            <Icon name="mail" size={17} />
            Open in mijn mailprogramma
          </a>
          <Button onClick={onClose}>Klaar</Button>
        </div>
      </div>
    </Modal>
  );
}
