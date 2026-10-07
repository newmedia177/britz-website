#!/usr/bin/env node
/* Trennungspruefung fuer das Britz-Projekt (Assistent Alex).

   Der Code von Alex stammt teilweise aus dem Haddad-Projekt (Assistent Tony).
   Dieses Skript sucht nach allem, was noch auf Haddad zeigt: Rufnummern,
   Domain, Adresse, Google-Kennungen, Meta-Kennungen, Vorlagennamen,
   Inhabernummern. Jede Fundstelle waere ein Risiko, dass Kunden, Meldungen
   oder Messwerte beim falschen Betrieb landen.

   Aufruf im Projektordner von Britz, vor JEDEM Deploy nach einer Uebernahme:
     node scripts/trennung-pruefen.mjs

   Ergebnis "sauber" = keine kritische Fundstelle. Sonst Liste mit Datei und
   Zeile, und das Skript endet mit Fehlercode 1. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

// Kritisch: darf im Britz-Projekt nirgends vorkommen
const KRITISCH = [
  ["haddad.berlin", "Domain von Haddad"],
  ["491775673178", "WhatsApp-Nummer von Tony"],
  ["5673178", "WhatsApp-Nummer von Tony"],
  ["56 73 178", "WhatsApp-Nummer von Tony"],
  ["79786300", "Festnetz von Haddad"],
  ["Lauenburger", "Adresse von Haddad"],
  ["12169", "Postleitzahl von Haddad"],
  ["AW-18206201874", "Google-Ads-Konto von Haddad"],
  ["sQsYCPqq2vgcEJKwsulD", "Google-Ads-Label von Haddad"],
  ["PnNzCP2q2vgcEJKwsulD", "Google-Ads-Label von Haddad"],
  ["ringCICr2vgcEJKwsulD", "Google-Ads-Label von Haddad"],
  ["3E1mCN2N2PgcEJKwsulD", "Google-Ads-Label von Haddad"],
  ["DCb3COCN2PgcEJKwsulD", "Google-Ads-Label von Haddad"],
  ["G-MY8J26HFDH", "Google Analytics von Haddad"],
  ["r6xzWVLvF5kiK2ntTqgqgUaPa4UgDm7HpHn1iWezn9E", "Search Console von Haddad"],
  ["1307309275789665", "Meta-Telefonnummer-ID von Haddad"],
  ["3481236488712420", "Meta-WhatsApp-Konto von Haddad"],
  ["1696940891361469", "Meta-Business-ID von Haddad"],
  ["491722769741", "Inhabernummer Haddad"],
  ["491723883035", "Inhabernummer Haddad"],
  ["kundenmeldung_tony", "Meta-Vorlage von Haddad"],
  ["tagesueberblick_tony", "Meta-Vorlage von Haddad"],
  ["prj_2UajAoAhjzjQYMOenYODTB2Xzgm9", "Vercel-Projekt von Haddad"],
  ["Haddad", "Name des Betriebs"]
];
// Hinweis: meist nur Texte oder Kommentare, trotzdem anpassen
const HINWEIS = [
  ["Tony", "Name des Haddad-Assistenten"],
  ["Steglitz", "Standort von Haddad"],
  ["Karosserie und Lack", "Betriebsbezeichnung von Haddad"]
];

const DURCHSUCHEN = [".js", ".mjs", ".cjs", ".json", ".html", ".md", ".css", ".txt", ".xml", ".env", ""];
const AUSLASSEN = new Set(["node_modules", ".git", ".vercel", ".next", "dist"]);
const SELBST = "trennung-pruefen.mjs";

function dateien(ordner, liste = []) {
  for (const name of readdirSync(ordner)) {
    if (AUSLASSEN.has(name)) continue;
    const pfad = join(ordner, name);
    const st = statSync(pfad);
    if (st.isDirectory()) dateien(pfad, liste);
    else if (name !== SELBST && DURCHSUCHEN.includes(extname(name)) && st.size < 3_000_000) liste.push(pfad);
  }
  return liste;
}

const funde = { kritisch: [], hinweis: [] };
for (const datei of dateien(".")) {
  const zeilen = readFileSync(datei, "utf8").split("\n");
  zeilen.forEach((z, i) => {
    for (const [muster, was] of KRITISCH) {
      if (z.includes(muster)) funde.kritisch.push(datei + ":" + (i + 1) + "  " + was + "  (" + muster + ")");
    }
    for (const [muster, was] of HINWEIS) {
      if (z.includes(muster)) funde.hinweis.push(datei + ":" + (i + 1) + "  " + was);
    }
  });
}

if (funde.hinweis.length) {
  console.log("Hinweise (" + funde.hinweis.length + "), bitte anpassen, oft nur Texte oder Kommentare:");
  for (const f of funde.hinweis.slice(0, 40)) console.log("  " + f);
  if (funde.hinweis.length > 40) console.log("  … und " + (funde.hinweis.length - 40) + " weitere");
  console.log("");
}
if (funde.kritisch.length) {
  console.log("KRITISCH (" + funde.kritisch.length + "): Diese Stellen zeigen noch auf Haddad.");
  console.log("Bitte NICHT deployen, bevor sie ersetzt sind:");
  for (const f of funde.kritisch) console.log("  " + f);
  process.exit(1);
}
console.log("sauber: keine kritische Spur von Haddad gefunden.");
console.log("Zusaetzlich in Vercel pruefen: eigene UPSTASH_REDIS_REST_URL, eigener WHATSAPP_TOKEN,");
console.log("eigene WHATSAPP_PHONE_ID, OWNER_NUMBERS ohne Haddad-Nummern, SITE_URL auf die Britz-Adresse.");
