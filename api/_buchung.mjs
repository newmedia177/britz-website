// api/_buchung.mjs
// Verbindliche Terminvergabe durch Alex. Regeln laut Dirk (23.09.2026):
//
//   Zeitfenster statt Punktzeiten:  8-10 / 11-13 / 14-17 Uhr
//                                   Montag erst ab 9, Freitag nur bis 15
//   10-11 und 13-14 Uhr:            tabu
//   Hoechstens 5 Termine pro Tag:   Begutachtung + Abgabe + Abholung zusammen
//   Vorlauf:                        mindestens 1 Stunde Restzeit im Fenster
//   Begutachtung:                   nur Haarlemer Strasse (Britz)
//   Abgabe:                         nur nach Kostenvoranschlag; Kleinmachnow
//                                   moeglich, aber nie aktiv anbieten
//   Abholung:                       erst nach Dirks "Fertig N"
//   Haftpflicht-Gutachten:          eigener Prozess, bucht Alex nicht
//
// Der Code prueft jede Buchung hart gegen diese Regeln. Der Prompt sorgt
// nur dafuer, dass Alex von vornherein Passendes anbietet.

import { jsonLesen, jsonSchreiben, redis, inhaberNummern, sendWA, sendMail, zustellenAnInhaber,
         istRuhezeit, icsAdresse } from "./_termin.mjs";
import { akteHolenOderAnlegen, akteFinden, akteSpeichern, anKunde } from "./_anfragen.mjs";

export const MAX_PRO_TAG = 5;
const VORLAUF_MIN = 60;
const TAGE_VORAUS = 21;

export const ORTE = {
  britz: "Haarlemer Straße 48-54, 12359 Berlin",
  kleinmachnow: "Albert-Einstein-Ring 45, 14532 Kleinmachnow"
};
const ARTEN = {
  begutachtung: "Kostenfreie Begutachtung",
  abgabe: "Fahrzeugabgabe zur Reparatur",
  abholung: "Fahrzeugabholung"
};

// Marker, den Alex setzt: [[BUCHUNG|2026-09-24|11-13|begutachtung]]
// Optional als fuenftes Feld der Ort: kleinmachnow (nur bei Abgabe).
export const RE_BUCHUNG =
  /\[\[BUCHUNG\|(\d{4}-\d{2}-\d{2})\|(\d{1,2})\s*[-–]\s*(\d{1,2})\|([a-zäöü]+)(?:\|([a-zäöü]+))?\]\]/i;

// ---- Zeit in Berlin ------------------------------------------------
const WT_NAME = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

export function berlin(d = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Berlin"
  }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return {
    datum: p.year + "-" + p.month + "-" + p.day,
    wt: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
    stunde: parseInt(p.hour, 10), minute: parseInt(p.minute, 10)
  };
}
// Wochentag eines Datums (Mittag UTC, damit Sommerzeit nie stoert)
function wtVon(datum) { return new Date(datum + "T12:00:00Z").getUTCDay(); }
function plusTage(datum, n) {
  const d = new Date(datum + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function datumLesbar(datum) {
  const [j, m, t] = datum.split("-");
  return WT_NAME[wtVon(datum)] + ", " + Number(t) + "." + Number(m) + ".";
}
function fensterText(v, b) { return v + "–" + b + " Uhr"; }

// ---- Feiertage Berlin ------------------------------------------------
function ostersonntag(j) {
  const a = j % 19, b = Math.floor(j / 100), c = j % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monat = Math.floor((h + l - 7 * m + 114) / 31), tag = ((h + l - 7 * m + 114) % 31) + 1;
  return j + "-" + String(monat).padStart(2, "0") + "-" + String(tag).padStart(2, "0");
}
export function istFeiertag(datum) {
  const j = Number(datum.slice(0, 4)), os = ostersonntag(j);
  const fest = ["01-01", "03-08", "05-01", "10-03", "12-25", "12-26"].map(x => j + "-" + x);
  const beweglich = [-2, 1, 39, 50].map(n => plusTage(os, n));
  return fest.includes(datum) || beweglich.includes(datum);
}

// ---- Regeln --------------------------------------------------------
export function fensterAm(datum) {
  const wt = wtVon(datum);
  if (wt === 0 || wt === 6 || istFeiertag(datum)) return [];
  const erstes = wt === 1 ? [9, 10] : [8, 10];
  const letztes = wt === 5 ? [14, 15] : [14, 17];
  return [erstes, [11, 13], letztes];
}

async function buchungenLaden() {
  const l = await jsonLesen("buchungen", []);
  const heute = berlin().datum;
  // Vergangene Termine nach 14 Tagen verwerfen
  const grenze = plusTage(heute, -14);
  const frisch = l.filter(b => b.datum >= grenze);
  if (frisch.length !== l.length) await jsonSchreiben("buchungen", frisch);
  return frisch;
}
export async function aktiveAm(datum) {
  return (await buchungenLaden()).filter(b => b.datum === datum && b.status === "aktiv");
}

// Ist das Fenster an diesem Tag grundsaetzlich buchbar? (ohne Kapazitaet)
function fensterZulaessig(datum, v, b, sperr) {
  const fenster = fensterAm(datum);
  if (!fenster.length) return "an diesem Tag ist die Werkstatt geschlossen";
  if (!fenster.some(([fv, fb]) => fv === v && fb === b)) return "zu dieser Zeit vergeben wir keine Termine";
  if (sperr.includes(datum)) return "an diesem Tag nimmt die Werkstatt keine Termine an";
  const j = berlin();
  if (datum < j.datum) return "das Datum liegt in der Vergangenheit";
  if (datum === j.datum) {
    const rest = b * 60 - (j.stunde * 60 + j.minute);
    if (rest < VORLAUF_MIN) return "dafür ist es heute zu knapp (mindestens 1 Stunde Vorlauf)";
  }
  return "";
}

// Freie Fenster der naechsten Tage, fuer Alex und fuer Kundennachrichten
export async function freieFenster(maxTage = 6) {
  const sperr = await jsonLesen("sperrtage", []);
  const alle = await buchungenLaden();
  const heute = berlin().datum;
  const aus = [];
  for (let i = 0; i < TAGE_VORAUS && aus.length < maxTage; i++) {
    const datum = plusTage(heute, i);
    const fenster = fensterAm(datum);
    if (!fenster.length || sperr.includes(datum)) continue;
    const belegt = alle.filter(b => b.datum === datum && b.status === "aktiv").length;
    const frei = MAX_PRO_TAG - belegt;
    if (frei <= 0) continue;
    const offen = fenster.filter(([v, b]) => !fensterZulaessig(datum, v, b, sperr));
    if (!offen.length) continue;
    aus.push({ datum, label: i === 0 ? "heute" : i === 1 ? "morgen" : WT_NAME[wtVon(datum)],
               fenster: offen, frei });
  }
  return aus;
}

export function freieAlsText(liste, max = 3) {
  const teile = [];
  for (const t of liste) {
    for (const [v, b] of t.fenster) {
      teile.push(t.label + " (" + Number(t.datum.slice(8)) + "." + Number(t.datum.slice(5, 7)) + ".) " + fensterText(v, b));
      if (teile.length >= max) return teile.join(", ");
    }
  }
  return teile.join(", ");
}

// Kontextblock fuer den Prompt (beide Kanaele)
export async function buchungKontext() {
  try {
    const frei = await freieFenster(6);
    const zeilen = frei.map(t =>
      "- " + t.label + " (" + datumLesbar(t.datum) + ", Datum " + t.datum + "): " +
      t.fenster.map(([v, b]) => fensterText(v, b)).join(", ") + "  [noch " + t.frei + " von " + MAX_PRO_TAG + " Plätzen]");
    return "\n\nFREIE TERMINFENSTER (verbindlich buchbar, nur diese anbieten):\n" +
      (zeilen.length ? zeilen.join("\n") : "- In den nächsten Tagen ist nichts frei. Biete an, dass sich die Werkstatt meldet, und nenne 030 607 97 930.");
  } catch (_) {
    return "\n\nFREIE TERMINFENSTER: gerade nicht abrufbar. Buche nichts, nimm den Wunsch auf und sag, dass sich die Werkstatt meldet.";
  }
}

// ---- Nachricht an Dirk ------------------------------------------------
async function anInhaber(text) {
  if (istRuhezeit()) {
    const l = await jsonLesen("wartend", []);
    l.push({ text, bilder: [], ts: Date.now() });
    await jsonSchreiben("wartend", l.slice(-30));
    return true;
  }
  return zustellenAnInhaber(text, { kurz: String(text).split("\n")[0] + " · " + String(text).split("\n")[2] });
}

// ---- Buchung aus einer Alex-Antwort verarbeiten ----------------------------
// Rueckgabe null (kein Marker), {ok:true,...} oder {ok:false, korrektur}
export async function buchungVerarbeiten({ antwort, kanal, sitzung, kundeNr, name, tel, thema, fotos }) {
  const m = String(antwort || "").match(RE_BUCHUNG);
  if (!m) return null;
  // Name/Nummer zur Sicherheit auch direkt aus dem KONTAKT-Marker lesen
  const mK = String(antwort).match(/\[\[KONTAKT\|([^|\]]*)\|([^\]]*)\]\]/);
  if (mK) { name = name || mK[1].trim(); tel = tel || mK[2].trim(); }
  const datum = m[1], v = Number(m[2]), b = Number(m[3]);
  const art = ({ begutachtung: "begutachtung", besichtigung: "begutachtung", abgabe: "abgabe",
                 abholung: "abholung" })[m[4].toLowerCase()];
  let ort = (m[5] || "").toLowerCase() === "kleinmachnow" ? "kleinmachnow" : "britz";
  if (!art) return { ok: false, korrektur: "" };
  if (art !== "abgabe") ort = "britz";            // Begutachtung/Abholung nur Britz

  const alternativen = async () => {
    const t = freieAlsText(await freieFenster(4), 3);
    return t ? " Frei wären zum Beispiel: " + t + ". Was passt Ihnen?" : " Die Werkstatt meldet sich dann bei Ihnen: 030 607 97 930.";
  };

  const sperr = await jsonLesen("sperrtage", []);
  const grund = fensterZulaessig(datum, v, b, sperr);
  if (grund) return { ok: false, korrektur: "Kleine Korrektur: Dieses Zeitfenster kann ich leider nicht vergeben, " + grund + "." + await alternativen() };

  // Akte des Kunden (fuer Abgabe-/Abholungsregel und einheitliche Nummer)
  const akte = await akteHolenOderAnlegen({ kanal, kundeNr, sitzung, name, tel, thema });

  if (art === "abholung" && !akte.fertig) {
    return { ok: false, korrektur: "Kleine Korrektur: Eine Abholung kann ich erst eintragen, wenn die Werkstatt Ihr Fahrzeug als fertig gemeldet hat. Sie bekommen dann automatisch eine Nachricht mit den freien Zeiten." };
  }

  const alle = await buchungenLaden();
  // Dieselbe Sitzung hat schon genau diesen Termin: nichts doppelt anlegen
  const gleich = alle.find(x => x.akteNr === akte.nr && x.status === "aktiv" && x.datum === datum && x.von === v && x.art === art);
  if (gleich) return { ok: true, buchung: gleich, doppelt: true, ...kalender(gleich) };

  const amTag = alle.filter(x => x.datum === datum && x.status === "aktiv");
  // Umbuchung derselben Akte zaehlt nicht gegen sich selbst
  const eigeneAlt = alle.find(x => x.akteNr === akte.nr && x.status === "aktiv" && x.art === art);
  const belegt = amTag.filter(x => x !== eigeneAlt).length;
  if (belegt >= MAX_PRO_TAG) {
    return { ok: false, korrektur: "Kleine Korrektur: Der " + datumLesbar(datum) + " ist gerade voll geworden." + await alternativen() };
  }

  if (eigeneAlt) { eigeneAlt.status = "umgebucht"; }
  const buchung = {
    akteNr: akte.nr, datum, von: v, bis: b, art, ort,
    name: akte.name || name || "", tel: akte.tel || tel || "", kanal,
    kundeNr: kanal === "whatsapp" ? String(kundeNr || "") : "",
    quelle: "alex", status: "aktiv", ts: Date.now(),
    ohneKV: art === "abgabe" && !akte.angebot
  };
  alle.push(buchung);
  await jsonSchreiben("buchungen", alle.slice(-300));

  akte.status = "termin";
  akte.termin = datum + " " + fensterText(v, b);
  akte.verlauf = akte.verlauf || [];
  akte.verlauf.push(new Date().toLocaleDateString("de-DE") + (eigeneAlt ? " umgebucht auf " : " Termin: ") + datumLesbar(datum) + " " + fensterText(v, b));
  await akteSpeichern(akte);

  const auslastung = belegt + 1;
  await anInhaber(
    (eigeneAlt ? "Termin umgebucht (Nr. " : "Neuer Termin (Nr. ") + akte.nr + ")\n────────\n" +
    datumLesbar(datum) + " " + fensterText(v, b) + " · " + ARTEN[art] +
    (ort === "kleinmachnow" ? " · KLEINMACHNOW" : "") + "\n" +
    (buchung.name || "Name nicht genannt") + (buchung.tel ? " · " + buchung.tel : (buchung.kundeNr ? " · WhatsApp" : "")) + "\n" +
    (akte.schaden || akte.thema ? "Anliegen: " + (akte.schaden ? akte.schaden + ", " : "") + (akte.fahrzeug || akte.thema || "").slice(0, 100) + "\n" : "") +
    (akte.fotos ? akte.fotos + " Foto(s) liegen vor\n" : "") +
    (buchung.ohneKV ? "⚠ Abgabe ohne Kostenvoranschlag in der Akte – laut Kunde liegt einer vor, bitte prüfen.\n" : "") +
    (eigeneAlt ? "Vorher: " + datumLesbar(eigeneAlt.datum) + " " + fensterText(eigeneAlt.von, eigeneAlt.bis) + "\n" : "") +
    "Auslastung " + datumLesbar(datum) + ": " + auslastung + " von " + MAX_PRO_TAG + "\n" +
    "Du musst nichts tun. Ändern: \"Verschieben " + akte.nr + " Freitag 8-10\" · \"Absagen " + akte.nr + "\""
  );
  return { ok: true, buchung, ...kalender(buchung) };
}

function kalender(bu) {
  const titel = ARTEN[bu.art] + ", Zeitfenster " + fensterText(bu.von, bu.bis) + ", Autolackiererei in Britz";
  const iso = bu.datum + "T" + String(bu.von).padStart(2, "0") + ":00";
  return { iso, titel, ort: ORTE[bu.ort], ics: icsAdresse(iso, titel, ORTE[bu.ort]) };
}

// ---- Befehle vom Inhaber --------------------------------------------
// Tag aus "heute", "morgen", "Donnerstag", "24.9.", "24.09.2026"
function tagLesen(s) {
  const heute = berlin().datum;
  const t = String(s || "").trim().toLowerCase();
  if (/^heute$/.test(t)) return heute;
  if (/^morgen$/.test(t)) return plusTage(heute, 1);
  if (/^übermorgen$|^uebermorgen$/.test(t)) return plusTage(heute, 2);
  const wi = ["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"]
    .findIndex(w => t === w || t === w.slice(0, 2) || t === w.slice(0, 3));
  if (wi >= 0) {
    for (let i = 0; i < 7; i++) { const d = plusTage(heute, i); if (wtVon(d) === wi) return d; }
  }
  const m = t.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2,4})?$/);
  if (m) {
    let j = m[3] ? Number(m[3]) : Number(heute.slice(0, 4));
    if (j < 100) j += 2000;
    const d = j + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0");
    if (!m[3] && d < heute) return (j + 1) + d.slice(4);
    return d;
  }
  return "";
}
function fensterLesen(s) {
  const m = String(s || "").match(/(\d{1,2})\s*(?:[-–]|bis)\s*(\d{1,2})/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
const TAG_RE = "(heute|morgen|übermorgen|uebermorgen|mo(?:ntag)?|di(?:enstag)?|mi(?:ttwoch)?|do(?:nnerstag)?|fr(?:eitag)?|sa(?:mstag)?|so(?:nntag)?|\\d{1,2}\\.\\d{1,2}\\.?(?:\\d{2,4})?)";

function kundenText(name, rumpf) {
  return "Guten Tag" + (name ? " " + name : "") + ", hier ist Alex von der Autolackiererei in Britz. " + rumpf;
}

async function kundeInformieren(bu, text) {
  const akte = await akteFinden(bu.akteNr);
  const r = akte ? await anKunde(akte, text, "WA_VORLAGE_ANGEBOT") : { ok: false, grund: "keine Akte" };
  return r.ok ? "Kunde ist informiert."
    : "Kunde konnte ich nicht selbst informieren (" + r.grund + ")." +
      (bu.tel ? " Bitte selbst an " + bu.tel + ":\n\n" + text : " Es liegt keine Nummer vor.");
}

export async function buchungBefehl(t) {
  const s = String(t || "").trim();
  let m;

  // Termine / Termine morgen / Termine Donnerstag
  m = s.match(new RegExp("^(?:zeig\\s+)?termine(?:\\s+" + TAG_RE + ")?$", "i"));
  if (m) {
    const alle = (await buchungenLaden()).filter(b => b.status === "aktiv" && b.datum >= berlin().datum);
    const tag = m[1] ? tagLesen(m[1]) : "";
    const liste = (tag ? alle.filter(b => b.datum === tag) : alle)
      .sort((a, b) => (a.datum + String(a.von).padStart(2, "0")).localeCompare(b.datum + String(b.von).padStart(2, "0")));
    const sperr = (await jsonLesen("sperrtage", [])).filter(d => d >= berlin().datum).sort();
    if (!liste.length) return (tag ? "Am " + datumLesbar(tag) + " keine Termine." : "Keine kommenden Termine.") +
      (sperr.length ? "\nGesperrt: " + sperr.slice(0, 8).map(datumLesbar).join(", ") : "");
    let aus = "Termine\n────────", tagAlt = "";
    for (const b of liste) {
      if (b.datum !== tagAlt) { aus += "\n" + datumLesbar(b.datum) + " (" + liste.filter(x => x.datum === b.datum).length + "/" + MAX_PRO_TAG + ")"; tagAlt = b.datum; }
      aus += "\n  " + fensterText(b.von, b.bis) + " · Nr. " + b.akteNr + " " + (b.name || "ohne Name") + " · " + ARTEN[b.art].replace("Kostenfreie ", "") +
        (b.ort === "kleinmachnow" ? " · Kleinmachnow" : "") + (b.quelle === "telefon" ? " · tel." : "");
    }
    if (sperr.length) aus += "\n\nGesperrt: " + sperr.slice(0, 8).map(datumLesbar).join(", ");
    return aus;
  }

  // Voll Donnerstag / Frei Donnerstag
  m = s.match(new RegExp("^(voll|frei)\\s+" + TAG_RE + "$", "i"));
  if (m) {
    const d = tagLesen(m[2]);
    if (!d) return "Den Tag habe ich nicht verstanden.";
    let sperr = await jsonLesen("sperrtage", []);
    if (/voll/i.test(m[1])) { if (!sperr.includes(d)) sperr.push(d); }
    else sperr = sperr.filter(x => x !== d);
    await jsonSchreiben("sperrtage", sperr.filter(x => x >= berlin().datum));
    const schon = (await aktiveAm(d)).length;
    return /voll/i.test(m[1])
      ? datumLesbar(d) + " ist gesperrt, ich vergebe dort nichts mehr." + (schon ? " Bereits gebuchte " + schon + " Termin(e) bleiben bestehen." : "")
      : datumLesbar(d) + " ist wieder frei für Buchungen.";
  }

  // Urlaub 1.10. bis 5.10.
  m = s.match(/^urlaub\s+(\d{1,2}\.\d{1,2}\.?(?:\d{2,4})?)\s*(?:bis|-|–)\s*(\d{1,2}\.\d{1,2}\.?(?:\d{2,4})?)$/i);
  if (m) {
    const von = tagLesen(m[1]), bis = tagLesen(m[2]);
    if (!von || !bis || bis < von) return "Den Zeitraum habe ich nicht verstanden. Beispiel: \"Urlaub 1.10. bis 5.10.\"";
    const sperr = await jsonLesen("sperrtage", []);
    let n = 0;
    for (let d = von; d <= bis && n < 60; d = plusTage(d, 1), n++) if (!sperr.includes(d)) sperr.push(d);
    await jsonSchreiben("sperrtage", sperr);
    const betroffen = (await buchungenLaden()).filter(b => b.status === "aktiv" && b.datum >= von && b.datum <= bis);
    return "Urlaub eingetragen: " + datumLesbar(von) + " bis " + datumLesbar(bis) + " Ich vergebe dort nichts." +
      (betroffen.length ? "\n⚠ Schon gebucht in dem Zeitraum: " + betroffen.map(b => "Nr. " + b.akteNr + " " + b.name + " (" + datumLesbar(b.datum) + ")").join(", ") + ". Absagen oder verschieben?" : "");
  }

  // Absagen 7
  m = s.match(/^absagen\s+(\d{1,4})$/i);
  if (m) {
    const alle = await buchungenLaden();
    const bu = alle.find(b => b.akteNr === Number(m[1]) && b.status === "aktiv");
    if (!bu) return "Zu Nr. " + m[1] + " gibt es keinen aktiven Termin. \"Termine\" zeigt alle.";
    bu.status = "abgesagt";
    await jsonSchreiben("buchungen", alle);
    const info = await kundeInformieren(bu, kundenText(bu.name,
      "Leider müssen wir Ihren Termin am " + datumLesbar(bu.datum) + " (" + fensterText(bu.von, bu.bis) + ") absagen. " +
      "Schreiben Sie mir gern, dann suche ich Ihnen einen neuen. Entschuldigen Sie die Umstände."));
    return "Termin Nr. " + bu.akteNr + " abgesagt. " + info;
  }

  // Verschieben 7 Freitag 8-10
  m = s.match(new RegExp("^verschieben\\s+(\\d{1,4})\\s+(?:auf\\s+)?" + TAG_RE + "\\s+(.+)$", "i"));
  if (m) {
    const d = tagLesen(m[2]), f = fensterLesen(m[3]);
    if (!d || !f) return "Beispiel: \"Verschieben 7 Freitag 8-10\"";
    if (!fensterAm(d).some(([v, b]) => v === f[0] && b === f[1])) return fensterText(f[0], f[1]) + " ist am " + datumLesbar(d) + " kein Zeitfenster. Möglich: " + fensterAm(d).map(([v, b]) => fensterText(v, b)).join(", ");
    const alle = await buchungenLaden();
    const bu = alle.find(b => b.akteNr === Number(m[1]) && b.status === "aktiv");
    if (!bu) return "Zu Nr. " + m[1] + " gibt es keinen aktiven Termin.";
    const vorher = datumLesbar(bu.datum) + " " + fensterText(bu.von, bu.bis);
    const dort = alle.filter(b => b.datum === d && b.status === "aktiv" && b !== bu).length;
    bu.datum = d; bu.von = f[0]; bu.bis = f[1];
    await jsonSchreiben("buchungen", alle);
    const info = await kundeInformieren(bu, kundenText(bu.name,
      "Wir müssen Ihren Termin verschieben: statt " + vorher + " jetzt am " + datumLesbar(d) + ", " + fensterText(f[0], f[1]) + ", " + ORTE[bu.ort] + ". " +
      "Passt das nicht, schreiben Sie mir einfach, dann finden wir einen anderen Termin."));
    return "Nr. " + bu.akteNr + " verschoben auf " + datumLesbar(d) + " " + fensterText(f[0], f[1]) + "." +
      (dort >= MAX_PRO_TAG ? " ⚠ Der Tag hat damit " + (dort + 1) + " Termine (mehr als " + MAX_PRO_TAG + ")." : "") + " " + info;
  }

  // Eintragen Donnerstag 11-13 Meier [Begutachtung|Abgabe|Abholung]
  m = s.match(new RegExp("^eintragen\\s+" + TAG_RE + "\\s+(\\d{1,2}\\s*(?:[-–]|bis)\\s*\\d{1,2})\\s+(.+)$", "i"));
  if (m) {
    const d = tagLesen(m[1]), f = fensterLesen(m[2]);
    let rest = m[3].trim();
    let art = "begutachtung";
    const am = rest.match(/\s+(begutachtung|besichtigung|abgabe|abholung)$/i);
    if (am) { art = am[1].toLowerCase() === "besichtigung" ? "begutachtung" : am[1].toLowerCase(); rest = rest.slice(0, am.index).trim(); }
    if (!d || !f || !rest) return "Beispiel: \"Eintragen Donnerstag 11-13 Meier\" (optional am Ende: Abgabe oder Abholung)";
    if (!fensterAm(d).some(([v, b]) => v === f[0] && b === f[1])) return fensterText(f[0], f[1]) + " ist am " + datumLesbar(d) + " kein Zeitfenster. Möglich: " + fensterAm(d).map(([v, b]) => fensterText(v, b)).join(", ");
    const akte = await akteHolenOderAnlegen({ kanal: "telefon", sitzung: "tel:" + Date.now(), name: rest });
    const alle = await buchungenLaden();
    const dort = alle.filter(b => b.datum === d && b.status === "aktiv").length;
    alle.push({ akteNr: akte.nr, datum: d, von: f[0], bis: f[1], art, ort: "britz", name: rest, tel: "",
                kanal: "telefon", kundeNr: "", quelle: "telefon", status: "aktiv", ts: Date.now() });
    await jsonSchreiben("buchungen", alle);
    akte.status = "termin"; akte.termin = d + " " + fensterText(f[0], f[1]); await akteSpeichern(akte);
    return "Eingetragen: Nr. " + akte.nr + " " + rest + ", " + datumLesbar(d) + " " + fensterText(f[0], f[1]) + " · " + ARTEN[art] + ".\n" +
      "Auslastung: " + (dort + 1) + " von " + MAX_PRO_TAG + (dort + 1 > MAX_PRO_TAG ? " ⚠ über der Obergrenze" : "");
  }

  // Fertig 7 -> Abholung freigeben, Kunde bekommt freie Zeiten
  m = s.match(/^fertig\s+(\d{1,4})$/i);
  if (m) {
    const akte = await akteFinden(Number(m[1]));
    if (!akte) return "Nr. " + m[1] + " kenne ich nicht. \"Anfragen\" zeigt alle.";
    akte.fertig = true; akte.fertigTs = Date.now();
    akte.verlauf = akte.verlauf || [];
    akte.verlauf.push(new Date().toLocaleDateString("de-DE") + " Fahrzeug fertig");
    await akteSpeichern(akte);
    const frei = freieAlsText(await freieFenster(4), 3);
    const text = kundenText(akte.name,
      "Ihr Fahrzeug ist fertig und kann abgeholt werden, " + ORTE.britz + ". " +
      (frei ? "Freie Zeitfenster zur Abholung: " + frei + ". Schreiben Sie mir einfach, welches Ihnen passt." : "Schreiben Sie mir einfach, wann es Ihnen passt."));
    const modus = (await redis("GET", "einstellung:abholnachricht")) || "alex";
    if (modus === "selbst") {
      return "Nr. " + akte.nr + " ist als fertig markiert, Abholung ist jetzt buchbar. Du schreibst dem Kunden selbst (eingestellt)." +
        (akte.tel || akte.kundeNr ? "\nVorschlag für den Text an " + (akte.tel || akte.kundeNr) + ":\n\n" + text : "");
    }
    const r = await anKunde(akte, text, "WA_VORLAGE_ANGEBOT");
    return "Nr. " + akte.nr + " ist als fertig markiert. " +
      (r.ok ? "Kunde hat die Abholnachricht mit freien Zeiten bekommen und bucht bei mir."
            : "Ich konnte dem Kunden nicht schreiben (" + r.grund + ")." + (akte.tel ? " Bitte selbst an " + akte.tel + ":\n\n" + text : ""));
  }

  // Abholnachricht selbst / Abholnachricht Alex
  m = s.match(/^abholnachricht\s+(selbst|ich|alex)$/i);
  if (m) {
    const modus = /alex/i.test(m[1]) ? "alex" : "selbst";
    await redis("SET", "einstellung:abholnachricht", modus);
    return modus === "alex"
      ? "Ab jetzt schicke ich die Abholnachricht nach \"Fertig N\" selbst an den Kunden."
      : "Ab jetzt schreibst du die Abholnachricht selbst. Ich markiere nur als fertig und gebe dir einen Textvorschlag.";
  }

  return null;
}
