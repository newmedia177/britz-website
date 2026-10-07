#!/usr/bin/env node
/* Einmalig ausfuehren, dann zaehlt die Versionsnummer bei jedem Commit
   von selbst hoch (auch mit GitHub Desktop):
     node scripts/hook-einrichten.mjs
   Der Hook blockiert nie einen Commit. Findet er Node nicht, gibt er nur
   einen Hinweis aus. */
import { writeFileSync, existsSync, readFileSync, chmodSync, renameSync } from "node:fs";

if (!existsSync(".git")) { console.error("Hier ist kein Git-Projekt. Bitte im Projektordner ausfuehren."); process.exit(1); }
if (!existsSync("scripts/version.mjs")) { console.error("scripts/version.mjs fehlt."); process.exit(1); }

const ZIEL = ".git/hooks/pre-commit";
const MARKE = "# britz-versionsnummer";
const hook = `#!/bin/sh
${MARKE}
# Zaehlt vor jedem Commit die Versionsnummer in index.html hoch, wenn der
# Commit etwas an der Seite oder an Alex aendert. Blockiert nie.
# GitHub Desktop kennt den normalen Suchpfad oft nicht, deshalb hier die
# ueblichen Orte fuer Node ergaenzen.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/*/bin "$HOME"/.volta/bin; do
  [ -d "$d" ] && PATH="$d:$PATH"
done
export PATH
if command -v node >/dev/null 2>&1; then
  node scripts/trennung-pruefen.mjs >/dev/null 2>&1 || echo "WARNUNG: Trennungspruefung meldet Fremdspuren. Vor dem Push: node scripts/trennung-pruefen.mjs"
  node scripts/version.mjs --auto || echo "Hinweis: Versionsnummer konnte nicht erhoeht werden."
else
  echo "Hinweis: Node nicht gefunden, Versionsnummer bleibt unveraendert."
fi
exit 0
`;
if (existsSync(ZIEL)) {
  const alt = readFileSync(ZIEL, "utf8");
  if (!alt.includes(MARKE)) { renameSync(ZIEL, ZIEL + ".vorher"); console.log("Vorhandener Hook gesichert als " + ZIEL + ".vorher"); }
}
writeFileSync(ZIEL, hook);
chmodSync(ZIEL, 0o755);
console.log("Fertig. Ab jetzt zaehlt jeder relevante Commit die Version hoch.");
