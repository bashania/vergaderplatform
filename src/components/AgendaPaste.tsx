import { useMemo } from "react";
import { countItems, parseAgenda, type ParsedItem } from "../agendaParse";
import { labelTone } from "../lib";
import { Field } from "../ui";

/** Tekstvak om een bestaande agenda te plakken, met direct eronder wat het platform ervan maakt. */
export function AgendaPaste({
  value,
  onChange,
  startAt = 1,
  label = "Agenda plakken",
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Nummer van het eerste nieuwe hoofdpunt (bij toevoegen aan een bestaande agenda). */
  startAt?: number;
  label?: string;
  autoFocus?: boolean;
}) {
  const items = useMemo(() => parseAgenda(value), [value]);
  return (
    <>
      <Field
        label={label}
        hint="Kopieer de agenda uit Word, een pdf of een e-mail. Nummering (1, 2.1) wordt een hoofd- of subpunt; 'Ter informatie' en dergelijke worden het label."
      >
        <textarea className="input" rows={7} autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      {items.length > 0 && (
        <div className="sub">
          <span className="sub-label">
            Dit wordt de agenda: {countItems(items)} {countItems(items) === 1 ? "punt" : "punten"}. Controleer en pas zo nodig de tekst hierboven aan.
          </span>
          <AgendaPreview items={items} startAt={startAt} />
        </div>
      )}
    </>
  );
}

function Row({ nr, item, child }: { nr: string; item: ParsedItem; child?: boolean }) {
  return (
    <div className={child ? "prow child" : "prow"}>
      <span className="nr">{nr}</span>
      <span className="grow">
        {child ? item.title : <strong>{item.title}</strong>} {item.kind && <span className={`badge ${labelTone(item.kind)}`}>{item.kind}</span>}
        {item.description && <span className="small muted"> · met toelichting</span>}
      </span>
    </div>
  );
}

export function AgendaPreview({ items, startAt = 1 }: { items: ParsedItem[]; startAt?: number }) {
  return (
    <div className="preview">
      {items.map((it, i) => (
        <div key={i}>
          <Row nr={String(startAt + i)} item={it} />
          {it.children.map((ch, j) => (
            <Row key={j} nr={`${startAt + i}.${j + 1}`} item={ch} child />
          ))}
        </div>
      ))}
    </div>
  );
}
