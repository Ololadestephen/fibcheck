import type { Finding } from "../findings.js";
import { cardText } from "./copy.js";

const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
const escapeHtml = (text: string) => text.replace(/[&<>"'`]/g, (character) => entities[character] ?? character);

export function renderCardHtml(finding: Finding, imageDataUrl: string, entries: readonly Finding[] = [finding], seconds = 3): string {
  const text = cardText(finding, entries);
  const time = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 3)) : 3;
  const angle = text.resolved ? -90 + 180 * text.held / text.resolved : 0;
  const count = Math.round(text.held * Math.min(1, Math.max(0, (time - 0.55) / 1.05)));
  const tone = finding.verdict === "true" || finding.verdict === "worded_differently" ? "#164c3d" : finding.verdict === "unconfirmed" ? "#5a544b" : "#a13722";
  const ticks = Array.from({ length: 13 }, (_, i) => `<line x1="240" y1="27" x2="240" y2="${i % 3 === 0 ? 48 : 39}" transform="rotate(${i * 15 - 90} 240 220)"/>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
*{box-sizing:border-box;margin:0}
body{--ink:#242b23;--paper:#f9f0dc;--tone:${tone};--time:-${time}s;--angle:${angle}deg;width:1200px;height:675px;overflow:hidden;color:var(--ink);background:repeating-linear-gradient(0deg,transparent 0 23px,#ab835022 23px 24px),repeating-linear-gradient(90deg,transparent 0 23px,#ab835022 23px 24px),var(--paper);font-family:Georgia,serif;padding:36px 40px}
main{display:grid;grid-template-columns:510px minmax(0,1fr);grid-template-rows:minmax(0,1fr);column-gap:36px;height:100%;border:2px solid #453b2b;background:#fbf3e4eb;padding:24px 27px}
.left{text-align:center}
.label,.source,.notes,.evidence{font:700 22px/1.22 Menlo,Consolas,monospace}
.label{letter-spacing:.08em;text-transform:uppercase}
.meter{color:var(--tone);display:block;width:420px;height:206px;margin:5px auto 0;overflow:visible}
.score{font:bold 96px/.93 Georgia,serif;letter-spacing:-.065em;font-variant-numeric:tabular-nums}
.score.empty{font-size:56px;letter-spacing:-.04em;line-height:1.6}
.truth{font:bold 30px/1.13 Georgia,serif}
.notes{font-size:20px;min-height:27px;margin-top:8px}
.verdict{text-align:center;margin-top:10px}
.stamp{display:inline-block;border:5px double currentColor;border-radius:3px;background:#fff7e9;color:var(--tone);padding:2px 15px;font:900 29px/1.25 Menlo,Consolas,monospace;animation:land 2.35s linear var(--time) both paused}
.caption{font:bold 28px/1.18 Georgia,serif;margin:10px auto 0;max-width:510px}
.right{min-width:0;display:grid;grid-template-rows:minmax(164px,auto) minmax(0,1fr);gap:12px}
.quote{font:bold 28px/1.19 Georgia,serif;margin:8px 0 9px;overflow-wrap:anywhere}
.source{font-size:18px;overflow-wrap:anywhere}
.proof{border-top:1px solid #ad9273;padding-top:12px;display:flex;flex-direction:column;min-height:0}
.shot{margin-top:8px;flex:1 1 265px;max-height:265px;min-height:0;background:#e3d3b9;border:1px solid #ad9273}
.shot img{display:block;width:100%;height:100%;object-fit:contain}
.evidence{font:700 22px/1.21 Georgia,serif;margin-top:8px;flex:none}
.merged{color:#164c3d}
.needle{transform-origin:240px 220px;animation:needle 1.65s ease-in-out var(--time) both paused}
@keyframes needle{0%{transform:rotate(-86deg)}9%{transform:rotate(-51deg)}17%{transform:rotate(-100deg)}25%{transform:rotate(-35deg)}34%{transform:rotate(-83deg)}100%{transform:rotate(var(--angle))}}
@keyframes land{0%,74%{opacity:0;transform:translateY(-4px) rotate(-3deg) scale(1.08)}75%{opacity:1;transform:translateY(-4px) rotate(-3deg) scale(1.08)}87%{transform:translateY(4px) rotate(-3deg) scale(.98)}94%{transform:translateY(-5px) rotate(-4deg)}100%{opacity:1;transform:rotate(-3deg)}}
</style></head>
<body><main><section class="left" aria-label="Recorded findings score">
<div class="label">Fib meter / Recorded findings</div>
<svg class="meter" viewBox="0 0 480 235" aria-hidden="true">
<path d="M39 220a201 201 0 0 1 402 0" fill="none" stroke="#dec6a5" stroke-width="12"/>
<path d="M39 220a201 201 0 0 1 402 0" fill="none" stroke="currentColor" stroke-width="2"/>
<path d="M68 220a172 172 0 0 1 344 0" fill="none" stroke="#bea583" stroke-width="1" stroke-dasharray="3 6"/>
<g stroke="#493c2a" stroke-width="2">${ticks}</g>
${text.resolved ? '<path class="needle" d="M235 220L240 59l5 161Z" fill="currentColor"/>' : ""}<circle cx="240" cy="220" r="8" fill="currentColor"/>
</svg>
${text.resolved ? `<div aria-label="${escapeHtml(text.score)}"><div class="score">${count} of ${text.resolved}</div><div class="truth">${text.resolved === 1 ? "claim" : "claims"} told the truth</div></div>` : `<div class="score empty">${escapeHtml(text.score)}</div>`}
<div class="notes">${escapeHtml(text.note)}</div>
<div class="verdict"><div class="stamp">${escapeHtml(text.stamp)}</div><p class="caption">${escapeHtml(text.caption)}</p></div>
</section><aside class="right"><section><div class="label">The docs said</div><blockquote class="quote">“${escapeHtml(text.quote)}”</blockquote><p class="source">${escapeHtml(text.source)}</p></section>
<figure class="proof"><figcaption class="label">What Kane saw</figcaption><div class="shot"><img alt="Kane screenshot, scaled only" src="${escapeHtml(imageDataUrl)}"></div>
${text.evidence ? `<div class="evidence">${escapeHtml(text.evidence)}</div>` : ""}${text.merged ? `<div class="evidence merged">${escapeHtml(text.merged)}</div>` : ""}</figure>
</aside></main></body></html>
`;
}
