import { useState, type ReactNode } from "react";
import { errorText } from "../api";
import { Button, type IconName } from "../ui";

/**
 * Knop die een passkey-handeling start (aanmaken of inloggen). De browser neemt het
 * daarna over met vingerafdruk, gezicht of pincode; een fout of afbreken staat eronder.
 */
export function PasskeyButton({
  run,
  onDone,
  children,
  variant = "primary",
  icon = "lock",
  small,
}: {
  run: () => Promise<void>;
  onDone: () => void | Promise<void>;
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  icon?: IconName;
  small?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Button
        variant={variant}
        icon={icon}
        small={small}
        busy={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await run();
            await onDone();
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Wacht op je apparaat…" : children}
      </Button>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
