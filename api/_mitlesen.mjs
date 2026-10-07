// api/_mitlesen.mjs
// Dirk liest mit und kann uebernehmen (Wunsch vom 30.09.2026, Variante A).
//
//   Mitlesen:   Jedes Kundengespraech wird in Dirks Chat mit Alex
//               gespiegelt (Kunde + Alex-Antwort, mit Nummer der Akte).
//               "Mitlesen aus" / "Mitlesen an". Nachts (17-8 Uhr) wird
//               nicht gespiegelt, dafuer gibt es Morgenbriefing und
//               Abbruch-Meldungen.
//   Uebernahme: "Uebernehme 7" - ab dann geht alles, was Dirk an Alex
//               schreibt (ausser Befehlen), 1:1 an den Kunden, und Alex
//               schweigt. Kundennachrichten und Fotos landen direkt bei
//               Dirk. "Fertig" beendet die Uebernahme, Alex kennt danach
//               das Besprochene. Endet von selbst nach 12 Stunden.
//               Nur bei WhatsApp-Kunden moeglich: Den Website-Chat kann
//               niemand nachtraeglich erreichen.

import { redis, inhaberNummern, sendWA, sendWABild, istRuhezeit } from "./_termin.mjs";
import { akteFinden } from "./_anfragen.mjs";

const UEB_SEK = 12 * 3600;

export async function mitlesenAktiv() {
  return ((await redis("GET", "einstellung:mitlesen")) || "an") === "an";
}

// Gespraechszug an Dirk spiegeln (Best Effort, nie blockierend)
export async function spiegeln({ kanal, akte, kundeText, alexText, fotos }) {
  try {
    if (istRuhezeit() || !(await mitlesenAktiv())) return;
    const kopf = "💬 " + (akte ? "Nr. " + akte.nr + " · " : "") +
      (akte && akte.name ? akte.name : "unbekannt") + " · " + (kanal === "web" ? "Website" : "WhatsApp");
    const text = kopf + "\n" +
      "Kunde: " + String(kundeText || (fotos ? "(Foto)" : "")).replace(/\s+/g, " ").slice(0, 400) +
      (fotos ? "  [" + fotos + " Foto(s)]" : "") + "\n" +
      "Alex: " + String(alexText || "").replace(/\s+/g, " ").slice(0, 500) +
      (kanal === "whatsapp" && akte ? "\n→ eingreifen: \"Übernehme " + akte.nr + "\""
        : (akte && akte.tel ? "\n→ Website-Chat, eingreifen nur per Anruf: " + akte.tel : ""));
    for (const n of inhaberNummern()) await sendWA(n, text.slice(0, 1500));
  } catch (e) { console.error("spiegeln", e && e.message); }
}

// Laufende Uebernahme fuer einen Kunden?
export async function kundeInUebernahme(kundeNr) {
  try { return JSON.parse(await redis("GET", "ueb:kunde:" + kundeNr)) || null; } catch { return null; }
}
// Mit welchem Kunden schreibt dieser Inhaber gerade?
export async function uebernahmeKunde(owner) {
  return (await redis("GET", "ueb:owner:" + owner)) || "";
}

// Befehle: "Uebernehme 7", "Fertig", "Mitlesen an/aus"
export async function uebernahmeBefehl(owner, t) {
  const s = String(t || "").trim();
  let m;

  m = s.match(/^mitlesen\s+(an|aus|ein)$/i);
  if (m) {
    const an = !/aus/i.test(m[1]);
    await redis("SET", "einstellung:mitlesen", an ? "an" : "aus");
    return an ? "Mitlesen ist an. Du siehst jedes Kundengespräch (nachts nicht)." : "Mitlesen ist aus. Termine, Abbrüche und Briefings bekommst du weiter.";
  }

  m = s.match(/^(?:übernehme|uebernehme|übernehmen|uebernehmen)\s+(\d{1,4})$/i);
  if (m) {
    const akte = await akteFinden(Number(m[1]));
    if (!akte) return "Nr. " + m[1] + " kenne ich nicht.";
    if (akte.kanal !== "whatsapp" || !akte.kundeNr) {
      return "Nr. " + akte.nr + " kam über die Website, dort kann ich nicht mehr schreiben." + (akte.tel ? " Nummer zum Anrufen: " + akte.tel : "");
    }
    const lauf = await uebernahmeKunde(owner);
    if (lauf && lauf !== akte.kundeNr) await redis("DEL", "ueb:kunde:" + lauf);
    await redis("SET", "ueb:kunde:" + akte.kundeNr, JSON.stringify({ nr: akte.nr, owner, ts: Date.now() }), "EX", UEB_SEK);
    await redis("SET", "ueb:owner:" + owner, akte.kundeNr, "EX", UEB_SEK);
    const ok = await sendWA(akte.kundeNr, "Hier schreibt Ihnen jetzt die Werkstatt persönlich.");
    return "Du schreibst jetzt direkt mit Nr. " + akte.nr + (akte.name ? " (" + akte.name + ")" : "") + ".\n" +
      "Alles, was du mir schickst, geht 1:1 an den Kunden. Befehle wie \"Termine\" funktionieren weiter.\n" +
      "Beenden mit \"Fertig\" – dann übernimmt Alex wieder und kennt das Gespräch." +
      (ok ? "" : "\n⚠ Der Kunde hat seit über 24 Std. nicht geschrieben, WhatsApp lässt mich ihm gerade nicht schreiben.");
  }

  if (/^fertig$/i.test(s)) {
    const kunde = await uebernahmeKunde(owner);
    if (!kunde) return null;          // keine Uebernahme: normal weiter
    await redis("DEL", "ueb:kunde:" + kunde);
    await redis("DEL", "ueb:owner:" + owner);
    return "Übernahme beendet. Alex ist wieder dran und kennt das Besprochene.";
  }
  return null;
}

// Kundennachricht waehrend einer Uebernahme direkt an Dirk geben
export async function anUebernehmer(ueb, { text, mediaIds, name }) {
  const kopf = "👤 Nr. " + ueb.nr + (name ? " " + name : "") + ": ";
  if (text) await sendWA(ueb.owner, kopf + text);
  for (const id of (mediaIds || [])) await sendWABild(ueb.owner, id, kopf + "Foto");
}
