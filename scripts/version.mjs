#!/usr/bin/env node
/* Versionsnummer der Britz-Smartpage hochzaehlen.
   Anzeige im Footer: v. JAHR.KALENDERWOCHE.AUSGABE  (z. B. v. 2026.39.12)
   Jahr und Woche rechnet die Seite selbst, dieses Skript pflegt nur
   AUSGABE in index.html.

   Regeln:
   - AUSGABE zaehlt NUR HOCH, nie zurueck, auch nicht in einer neuen Woche.
   - Vor dem Hochzaehlen wird die Live-Seite gelesen und vom hoeheren Stand
     weitergezaehlt. Eine alte index.html kann die Zaehlung nicht
     zurueckwerfen.
   - Automatisch (Git-Hook) wird nur gezaehlt, wenn der Commit etwas an
     der Seite oder an Alex aendert (api/, assets/, prompts/, knowledge/,
     index.html, rechtliches.html). Reine Doku-Commits zaehlen nicht.
   - Jede Ausgabe bekommt eine Zeile in CHRONIK.md.

   Aufruf:
     node scripts/version.mjs "Direktbuchung"   von Hand, mit Notiz
     node scripts/version.mjs --auto            aus dem Git-Hook
*/
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const DATEI = "index.html";
const CHRONIK = "CHRONIK.md";
const LIVE = "https://www.autolackiererei-britz.de/";
const RELEVANT = /^(api\/|assets\/|prompts\/|knowledge\/|index\.html$|rechtliches\.html$|vercel\.json$)/;
const RE = /var AUSGABE = (\d+);[^\n]*/;

const auto = process.argv.includes("--auto");
const notiz = process.argv.slice(2).filter(a => !a.startsWith("--")).join(" ").trim();

function git(cmd) {
  try { return execSync("git " + cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString(); }
  catch { return ""; }
}

async function liveStand() {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(LIVE, { signal: ac.signal, headers: { "cache-control": "no-cache" } });
    clearTimeout(t);
    const m = (await r.text()).match(/var AUSGABE = (\d+)/);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }            // offline: nur lokal zaehlen
}

async function main() {
  if (!existsSync(DATEI)) { console.error("index.html nicht gefunden. Im Projektordner ausfuehren."); process.exit(0); }
  let html = readFileSync(DATEI, "utf8");
  const m = html.match(RE);
  if (!m) { console.error("AUSGABE nicht in index.html gefunden."); process.exit(0); }
  const lokal = Number(m[1]);

  let dateien = [];
  if (auto) {
    dateien = git("diff --cached --name-only").split("\n").filter(Boolean);
    if (!dateien.some(d => RELEVANT.test(d))) {
      console.log("Version: nichts Relevantes geaendert, bleibt bei " + lokal + ".");
      return;
    }
    // Schon von Hand hochgezaehlt in diesem Commit? Dann nichts tun.
    const vorher = git("show HEAD:" + DATEI).match(/var AUSGABE = (\d+)/);
    if (vorher && Number(vorher[1]) < lokal) {
      console.log("Version: in diesem Commit schon auf " + lokal + " gesetzt.");
      return;
    }
  }

  const live = await liveStand();
  const neu = Math.max(lokal, live) + 1;
  const heute = new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });
  // Im Pre-Commit-Hook gibt es die neue Commit-Nachricht noch nicht,
  // deshalb stehen dort die geaenderten Bereiche.
  const bereiche = [...new Set(dateien.filter(d => RELEVANT.test(d)).map(d => d.split("/")[0]))];
  const text = notiz || (auto ? "geändert: " + bereiche.join(", ") : "Update");
  html = html.replace(RE, "var AUSGABE = " + neu + ";  // " + heute + ": " + text.slice(0, 80) + "  (Verlauf: CHRONIK.md)");
  writeFileSync(DATEI, html);

  const zeile = "- **" + neu + "** · " + heute + " · " + (auto ? (dateien.filter(d => RELEVANT.test(d)).slice(0, 6).join(", ")) : text) + "\n";
  const alt = existsSync(CHRONIK) ? readFileSync(CHRONIK, "utf8") : "# Versionsverlauf Britz-Smartpage\n\nNeueste oben. Wird von scripts/version.mjs gepflegt.\n\n";
  const kopfEnde = alt.indexOf("\n- ");
  writeFileSync(CHRONIK, kopfEnde === -1 ? alt + zeile : alt.slice(0, kopfEnde + 1) + zeile + alt.slice(kopfEnde + 1));

  if (auto) git("add " + DATEI + " " + CHRONIK);
  console.log("Version: " + lokal + (live > lokal ? " (live " + live + ")" : "") + " -> " + neu);
}
main();
