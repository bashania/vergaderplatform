import react from "@vitejs/plugin-react";
import { cpSync, mkdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * De pdf-weergave haalt lettertypen en reserve-decoders pas op als een pdf erom vraagt. Die bestanden
 * komen uit het pakket zelf en gaan bij elke bouw mee naar /pdfjs; ze staan niet in de repository.
 */
function pdfAssets(): Plugin {
  return {
    name: "pdf-assets",
    buildStart() {
      const from = "node_modules/pdfjs-dist";
      mkdirSync("public/pdfjs/wasm", { recursive: true });
      cpSync(`${from}/standard_fonts`, "public/pdfjs/standard_fonts", { recursive: true });
      for (const file of ["jbig2_nowasm_fallback.js", "openjpeg_nowasm_fallback.js"]) cpSync(`${from}/wasm/${file}`, `public/pdfjs/wasm/${file}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), pdfAssets()],
  build: { target: "es2022", sourcemap: false },
});
