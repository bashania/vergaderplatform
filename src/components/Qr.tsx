import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** QR-code als vectorafbeelding, op het apparaat zelf gemaakt: er gaat niets naar een dienst van buiten. */
export function Qr({ text, size = 180, label = "QR-code" }: { text: string; size?: number; label?: string }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
    }
    return { count: n, path: d };
  }, [text]);
  // Witte rand van vier blokjes: zonder die rand herkennen camera's de code slecht.
  return (
    <svg className="qr" width={size} height={size} viewBox={`-4 -4 ${count + 8} ${count + 8}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-4} y={-4} width={count + 8} height={count + 8} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** De code in twee groepen van vier: makkelijker over te typen. */
export const fmtCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code);

/** Het adres waarmee iemand zonder account meekijkt. */
export const watchUrl = (token: string) => `${window.location.origin}/meekijken#${token}`;
