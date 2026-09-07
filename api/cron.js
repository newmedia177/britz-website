// api/cron.js
// Der "Wecker" der Anlage. Wird von Vercel Cron regelmaessig aufgerufen
// und erledigt alles, was NICHT davon abhaengen darf, dass gerade
// jemand schreibt:
//
//   1. Zurueckgehaltene Nachtmeldungen zustellen, sobald Buerozeit ist.
//      Vorher lagen sie in der Warteschlange, bis zufaellig jemand
//      schrieb. Schrieb niemand, erfuhr der Inhaber nie davon.
//   2. Angefangene, aber nicht beendete Gespraeche melden. Gerade im
//      Web-Chat sind die Daten sonst weg, sobald der Kunde das Fenster
//      schliesst.
//   3. Haengengebliebene Meldungen per E-Mail nachreichen, wenn
//      WhatsApp sie nicht annimmt (24-Stunden-Fenster von Meta).

import { warteschlangeZustellen, offeneGespraecheMelden } from "./_termin.mjs";
import { weckerAufgaben } from "./_anfragen.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // Vercel schickt bei Cron-Aufrufen einen Authorization-Kopf mit
  // CRON_SECRET. Ist das Geheimnis gesetzt, verlangen wir es auch.
  const noetig = process.env.CRON_SECRET;
  if (noetig) {
    const kopf = req.headers.authorization || "";
    if (kopf !== "Bearer " + noetig) {
      res.status(401).json({ error: "nicht erlaubt" });
      return;
    }
  }

  const ergebnis = { zugestellt: false, offene: 0, aufgaben: [] };
  try {
    ergebnis.aufgaben = await weckerAufgaben();   // Briefing, Wochenbericht, Erinnerungen
  } catch (e) {
    console.error("cron aufgaben", e && e.message);
  }
  try {
    ergebnis.zugestellt = await warteschlangeZustellen();
  } catch (e) {
    console.error("cron warteschlange", e && e.message);
  }
  try {
    ergebnis.offene = await offeneGespraecheMelden();
  } catch (e) {
    console.error("cron offene", e && e.message);
  }
  res.status(200).json({ ok: true, ...ergebnis, zeit: new Date().toISOString() });
}
