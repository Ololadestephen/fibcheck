import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadFindings, type Finding } from "./findings.js";
import { renderCardHtml } from "./card/html.js";

export { cardText, evidenceLine } from "./card/copy.js";
export { renderCardHtml } from "./card/html.js";

/** Finds a Chrome or Chromium to draw the card; Kane CLI already needs one. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.FIBCHECK_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((path): path is string => Boolean(path));
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error("Could not find Chrome or Chromium to draw the card. Set FIBCHECK_CHROME to its path.");
  return found;
}

/** Cards are laid out at 1200 by 675 and drawn at twice that, 2400 by 1350 pixels, so they stay sharp on phone and retina screens. */
export const CARD_SCALE = 2;

const FRAMES = 27;
const FPS = 9;
const END = (FRAMES - 1) / FPS;
const frameName = (index: number) => `frame-${String(index).padStart(2, "0")}.png`;

function capture(chrome: string, work: string, html: string, output: string): void {
  const page = join(work, "card.html");
  writeFileSync(page, html);
  execFileSync(chrome, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--disable-background-networking",
    `--user-data-dir=${join(work, "chrome")}`, `--force-device-scale-factor=${CARD_SCALE}`,
    "--window-size=1200,675", `--screenshot=${output}`, pathToFileURL(page).href], { stdio: "ignore", timeout: 60_000 });
  if (!existsSync(output)) throw new Error("Chrome did not write the card.");
}

function renderGif(work: string, frame: (index: number) => void, png: string): void {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 10_000 });
  if ((probe.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error(`Cannot animate: ffmpeg is not installed or not on PATH. PNG saved to ${png}.`);
  }
  if (probe.error || probe.status !== 0) throw new Error(`Cannot run ffmpeg. PNG saved to ${png}.`, { cause: probe.error });
  const run = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { cwd: work, timeout: 60_000 });
  for (let index = 0; index < FRAMES - 1; index++) frame(index);
  const input = ["-framerate", String(FPS), "-i", "frame-%02d.png"];
  run([...input, "-vf", "palettegen", "-frames:v", "1", "-update", "1", "palette.png"]);
  run([...input, "-i", "palette.png", "-lavfi", "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", "-loop", "0", "card.gif"]);
  if (statSync(join(work, "card.gif")).size >= 5_000_000) throw new Error(`GIF exceeds 5 MB. PNG saved to ${png}.`);
  // GIF uses a 256-colour palette. Decode its last frame so the paired PNG matches pixel for pixel.
  run(["-i", "card.gif", "-vf", `select=eq(n\\,${FRAMES - 1}),format=rgb24`, "-frames:v", "1", "-update", "1", "final.png"]);
  copyFileSync(join(work, "card.gif"), png.replace(/\.png$/, ".gif"));
  copyFileSync(join(work, "final.png"), png);
}

/** Writes `<outDir>/<id>.png` for one finding, and `<id>.gif` beside it when `animate` is set, and returns the PNG path. */
export function writeCard(findingsPath: string, id: string, outDir: string, chrome = findChrome(), animate = false): string {
  const findings = loadFindings(findingsPath);
  const finding = findings.find((entry) => entry.id === id);
  if (!finding) throw new Error(`No finding called ${id} in ${findingsPath}.`);
  return writeFindingCard(finding, findings, findingsPath, outDir, chrome, animate);
}

function writeFindingCard(finding: Finding, findings: readonly Finding[], findingsPath: string, outDir: string, chrome: string, animate: boolean): string {
  const image = resolve(dirname(findingsPath), finding.screenshot);
  const mime = extname(image).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
  const url = `data:${mime};base64,${readFileSync(image).toString("base64")}`;
  const work = mkdtempSync(join(tmpdir(), "fibcheck-card-"));
  try {
    mkdirSync(outDir, { recursive: true });
    const png = resolve(outDir, `${finding.id}.png`);
    const frame = (index: number) => capture(chrome, work, renderCardHtml(finding, url, findings, index / FPS), join(work, frameName(index)));
    const last = join(work, frameName(FRAMES - 1));
    capture(chrome, work, renderCardHtml(finding, url, findings, END), last);
    copyFileSync(last, png);
    if (animate) renderGif(work, frame, png);
    return png;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
