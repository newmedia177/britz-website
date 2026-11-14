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
//   4. Fallpflege: Karte an Dirk, sobald ein Gespraech ruht; Nachhaken,
//      wenn ein Kunde verstummt; Zwischenstand, bevor WhatsApp schliesst.
//   5. Lernrunde.
// Aufruf alle 15 Minuten durch cron-job.org (Vercel Hobby erlaubt selbst
// nur einen Lauf am Tag).

import { warteschlangeZustellen, offeneGespraecheMelden } from "./_termin.mjs";
import { weckerAufgaben, herzschlag } from "./_anfragen.mjs";
import { lernPflege } from "./_lernen.mjs";

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

  const start = Date.now();
  const ergebnis = { zugestellt: false, offene: 0, aufgaben: [] };
  // Lebenszeichen: Daran erkennt die Anlage, dass der Wecker laeuft.
  await herzschlag(true).catch(() => {});
  try {
    // Fallpflege, Briefing, Wochenbericht, Erinnerungen
    ergebnis.aufgaben = await weckerAufgaben({ bis: start + 35000 });
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
  // Lernrunde: woechentlich oder nach zehn neuen Gespraechen. Laeuft hier
  // und nicht im Kundengespraech, weil sie bis zu 45 Sekunden braucht.
  try {
    // Nur wenn noch genug Zeit ist; sonst macht es der naechste Lauf.
    if (Date.now() - start < 12000) ergebnis.lernen = await lernPflege();
  } catch (e) {
    console.error("cron lernen", e && e.message);
  }
  res.status(200).json({ ok: true, ...ergebnis, zeit: new Date().toISOString() });
}
