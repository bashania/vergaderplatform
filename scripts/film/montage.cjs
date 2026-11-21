// Zet de opgenomen beelden om in een mp4, met de ondertitels in een balk onder het beeld.
//   node montage.cjs <map van film.cjs> <uitvoer.mp4>
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = process.argv[2];
// ffmpeg draait in de map van de opname; het pad van de film staat daar los van.
const out = path.resolve(process.argv[3]);
const { subs } = JSON.parse(fs.readFileSync(path.join(dir, "captions.json"), "utf8"));
const FONT = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf";
const W = 1920;
const H = 1080;
const BAR = 120;

const filters = [
  "fps=30",
  `scale=${W}:${H}:flags=lanczos`,
  `pad=${W}:${H + BAR}:0:0:color=0x18181b`,
  `drawbox=x=0:y=${H}:w=${W}:h=4:color=0xffd92e:t=fill`,
];
subs.forEach((s, i) => {
  // Tekst uit een bestand: geen gedoe met aanhalingstekens, dubbele punten of komma's in het filter.
  const file = path.join(dir, `sub${i}.txt`);
  fs.writeFileSync(file, s.text);
  filters.push(
    `drawtext=fontfile=${FONT}:textfile=${file}:fontsize=35:fontcolor=white:x=(w-text_w)/2:y=${H + 4}+(${BAR - 4}-text_h)/2:enable='between(t,${(s.from + 0.15).toFixed(2)},${s.to.toFixed(2)})'`,
  );
});
fs.writeFileSync(path.join(dir, "filter.txt"), filters.join(",\n"));

execFileSync(
  "ffmpeg",
  ["-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "frames.txt", "-filter_script:v", "filter.txt", "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out],
  { cwd: dir, stdio: "inherit" },
);
console.log("film:", out, `${(fs.statSync(out).size / 1048576).toFixed(1)} MB`);
