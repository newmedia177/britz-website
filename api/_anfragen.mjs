// api/_anfragen.mjs
// Alex als digitaler Mitarbeiter: Jede Kundenanfrage bekommt eine Akte
// mit Status und wird bis zum Ende begleitet.
//
//   gespraech -> neu -> angebot -> termin -> erledigt   (oder: verloren)
//
// Seit 14.11.2026 denkt die Akte mit (siehe api/_denken.mjs):
//   - Dirk bekommt pro Kunde EINE Karte, sobald das Gespraech ruht oder
//     uebergeben ist: Zusammenfassung, was fehlt, Stimmung, Empfehlung,
//     Fotos, Knoepfe. Keine Einzelmeldungen mehr pro Foto oder Schritt.
//   - Verstummt ein Kunde mitten im Ablauf, hakt Alex einmal nach, mit
//     einer Nachricht, die zum Gespraech passt.
//   - Wer schon lange wartet oder veraergert ist, bekommt keinen
//     Standardtext. Das geht als "dringend" an Dirk.
//   - Das Gespraech bleibt in der Akte, damit Dirk jederzeit auf demselben
//     Stand uebernehmen kann ("Gespraech 7").
//
// Wo Meta das Schreiben nicht erlaubt (24-Stunden-Fenster ohne genehmigte
// Vorlage), sagt Alex das offen und gibt Dirk den fertigen Text.

import { jsonLesen, jsonSchreiben, redis, inhaberNummern, sendWA, sendMail, zustellenAnInhaber, fehlerLog,
         istRuhezeit, fetchMitZeit, rufnummerPruefen, sendWABild, sendWAVorlage, meldenOderAufheben,
         statPlus, statLesen, RE_KONTAKT, RE_KVA, RE_TERMIN } from "./_termin.mjs";
import { lageBeurteilen, gespraechText } from "./_denken.mjs";

const TAGE_AUFBEWAHRUNG = 30;      // erledigte Anfragen laenger nicht halten
const TAGE_OFFEN_MAX = 90;         // offene Anfragen spaetestens dann weg
const NACHFASS_TAGE = 3;           // Angebot raus, so lange still -> nachfassen?
const ANGEBOT_MAHNUNG_TAGE = 2;    // Anfrage wartet so lange auf Dirks Angebot

export const RE_DRINGEND = /\[\[DRINGEND\|([^\]]*)\]\]/;

// ---- Datum/Zeit in Berlin ------------------------------------------
export function berlinJetzt() {
  const t = new Intl.DateTimeFormat("de-DE", {
    weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin"
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    stunde: Number(t.hour), minute: Number(t.minute),
    wochentag: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"].indexOf(t.weekday.replace(".", "")),
    datum: t.year + "-" + t.month + "-" + t.day
  };
}


// ---- Darstellung fuer Dirk -----------------------------------------
// WhatsApp-Nummer "4917612345678" -> "+49 176 12345678" (antippbar)
export function nummerLesbar(n) {
  const z = String(n || "").replace(/\D/g, "");
  if (!z) return "";
  return z.startsWith("49") ? "+49 " + z.slice(2, 5) + " " + z.slice(5) : "+" + z;
}
function erreichbar(a) {
  return a.tel || nummerLesbar(a.kundeNr) || "";
}
function anliegenKurz(a) {
  return [a.schaden, a.fahrzeug, a.thema].filter(Boolean).join(" · ").replace(/\s+/g, " ").slice(0, 160) || "kein Anliegen notiert";
}
function alterText(ts) {
  const t = Math.round((Date.now() - ts) / 86400000);
  return t === 0 ? "heute" : t === 1 ? "seit gestern" : "seit " + t + " Tagen";
}
// Seit wann wartet der Kunde? Zaehlt ab dem Moment, in dem aus dem
// Gespraech eine Anfrage wurde.
function wartetSeit(a) { return a.leadTs || a.ts; }
function wartetTage(a) { return Math.floor((Date.now() - wartetSeit(a)) / 86400000); }
function uhrzeit(ts) {
  return new Date(ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
}
const STATUS_TEXT = { neu: "wartet auf dein Angebot", angebot: "Angebot ist raus", termin: "Termin gebucht",
                      erledigt: "erledigt", gespraech: "nur Gespräch", verloren: "ohne Rückweg gegangen" };
const OFFEN = a => !["erledigt", "gespraech", "verloren"].includes(a.status);

// ---- Zeitgrenzen ------------------------------------------------------
// WhatsApp laesst freie Nachrichten nur 24 Std. nach der letzten
// Kundennachricht zu. Danach ist der Kunde ohne genehmigte Vorlage nicht
// mehr erreichbar. Alles Nachhaken muss deshalb vorher passieren.
const RUHE_MIN = 8;                  // so lange still: Gespraech "ruht" -> Karte an Dirk
const NACHHAKEN_MIN = 30;            // Kunde haengt mitten im Ablauf -> einmal zurueckholen
const NACHHAKEN_MAX_STD = 3;         // spaeter nicht mehr (dann greift der Zwischenstand)
const ERINNERUNG_STD = 3;            // Dirk erinnern, wenn so lange kein Angebot raus ist
const ZWISCHENSTAND_AB_STD = 10;     // fruehestens so lange nach der letzten Kundennachricht
const FENSTER_STD = 23;              // danach nicht mehr frei schreiben
const UEBERFAELLIG_STD = 36;         // "in der Regel einen Tag spaeter" ist dann gerissen
const KUNDEN_VON = 8, KUNDEN_BIS = 20;  // Kunden nur tagsueber anschreiben

function fensterOffen(a) {
  return a.kanal === "whatsapp" && !!a.kundeNr && !!a.letzterKontakt &&
         Date.now() - a.letzterKontakt < FENSTER_STD * 3600000;
}
function fensterBis(a) {
  const ende = new Date(a.letzterKontakt + 24 * 3600000);
  const tag = d => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  return (tag(ende) === tag(new Date()) ? "heute " : "morgen ") + uhrzeit(ende.getTime());
}

// ---- Das Gespraech in der Akte ------------------------------------------
// Damit Dirk auf demselben Stand uebernehmen kann, bleibt der Wortlaut
// (nur Text, keine Bilder) bei der Akte, so lange wie die Akte selbst.
// w: "K" Kunde, "A" Alex, "D" Werkstatt persoenlich.
const GESPRAECH_MAX = 60;
const GESPRAECH_SEK = 90 * 86400;           // Anfrage: so lange wie die Akte hoechstens lebt
const UNTERHALTUNG_SEK = 7 * 86400;         // reine Unterhaltung ohne Anfrage: eine Woche
const ABGESCHLOSSEN_SEK = TAGE_AUFBEWAHRUNG * 86400;
const gespraechDauer = a => a && a.status === "gespraech" ? UNTERHALTUNG_SEK
  : a && ["erledigt", "verloren"].includes(a.status) ? ABGESCHLOSSEN_SEK : GESPRAECH_SEK;

export async function gespraechLaden(nr) {
  return jsonLesen("akte:g:" + nr, []);
}
export async function gespraechAnhaengen(nr, w, text, sek = GESPRAECH_SEK) {
  const t = String(text || "").replace(/\[\[[A-Z_]+\|[^\]]*\]\]/g, "").trim();
  if (!nr || !t) return;
  const l = await gespraechLaden(nr);
  l.push({ w, t: t.slice(0, 700), ts: Date.now() });
  await jsonSchreiben("akte:g:" + nr, l.slice(-GESPRAECH_MAX), sek);
}
// Website: Das Widget schickt jedes Mal den ganzen Verlauf mit.
export async function gespraechSetzen(nr, verlauf, sek = GESPRAECH_SEK) {
  if (!nr || !Array.isArray(verlauf)) return;
  const l = verlauf.slice(-GESPRAECH_MAX).map(m => ({
    w: m.role === "assistant" ? "A" : "K",
    t: String(typeof m.content === "string" ? m.content : "(Foto)").replace(/\[\[[A-Z_]+\|[^\]]*\]\]/g, "").trim().slice(0, 700),
    ts: Date.now()
  })).filter(z => z.t);
  await jsonSchreiben("akte:g:" + nr, l, sek);
}
function gespraechFuerDirk(zuege, max = 24) {
  return (zuege || []).slice(-max).map(z =>
    (z.w === "K" ? "👤 " : z.w === "D" ? "🔧 " : "Alex: ") + String(z.t).replace(/\s+/g, " ").slice(0, 400)).join("\n");
}

export function anfrageDetail(a) {
  const l = a.lage || {};
  const z = [];
  z.push("📋 Anfrage Nr. " + a.nr + (a.kanal === "web" ? " (Website)" : " (WhatsApp)"));
  z.push("────────");
  z.push("Kunde: " + (a.name || "Name nicht genannt"));
  z.push("Erreichbar: " + (erreichbar(a) || "keine Nummer, kam über die Website"));
  if (l.kurz) z.push("Kurz: " + l.kurz);
  if (a.schaden) z.push("Schadensart: " + a.schaden);
  if (a.fahrzeug) z.push("Fahrzeug: " + a.fahrzeug);
  if (!l.kurz && a.thema) z.push("Anliegen: " + a.thema);
  if (l.fehlt && !/^(nichts|keine?s?|-)\.?$/i.test(l.fehlt)) z.push("Fehlt: " + l.fehlt);
  if (a.notizen && a.notizen.length && !l.kurz) z.push("Kunde schrieb:\n" + a.notizen.map(n => "„" + n + "“").join("\n"));
  z.push("Fotos: " + (a.fotos || 0) + ((a.medien || []).length ? " (abrufbar mit \"Fotos " + a.nr + "\")" : a.fotos ? " (vor dem 13.11. eingegangen, nicht mehr abrufbar)" : ""));
  z.push("Status: " + (STATUS_TEXT[a.status] || a.status) + ", " + alterText(wartetSeit(a)) +
    (a.dringend ? " · 🔴 " + a.dringend.grund : ""));
  if (a.anruf) z.push("Anruf zugesagt am " + new Date(a.anruf).toLocaleDateString("de-DE"));
  if (a.termin) z.push("Termin: " + a.termin);
  if (a.angebot) z.push("Angebot: " + a.angebot);
  if (a.verlauf && a.verlauf.length) z.push("Verlauf: " + a.verlauf.slice(-4).join(" · "));
  if (l.empfehlung) z.push("👉 " + l.empfehlung);
  z.push("");
  z.push(a.status === "neu"
    ? "Weiter: \"Angebot " + a.nr + ": [Preis], [was gemacht wird]\" · \"Erledigt " + a.nr + "\" · \"Gespräch " + a.nr + "\"" +
      (a.kanal === "whatsapp" && !fensterOffen(a)
        ? "\nDer Kunde hat seit über 24 Std. nicht geschrieben: am besten selbst anrufen oder schreiben."
        : a.kanal === "whatsapp" ? " · \"Vorbeikommen " + a.nr + "\" · \"Übernehme " + a.nr + "\"" : "")
    : "Weiter: \"Gespräch " + a.nr + "\" · \"Erledigt " + a.nr + "\"" + (a.kanal === "whatsapp" ? " · \"Übernehme " + a.nr + "\"" : ""));
  return z.join("\n");
}

// ---- Die Karte: eine Meldung pro Kunde -------------------------------
// Alles, was Dirk braucht, um in fuenf Sekunden zu entscheiden. Hoechstens
// 1000 Zeichen, damit die Knoepfe darunter passen.
export function fallKarte(a) {
  const l = a.lage || {};
  const dringend = !!a.dringend;
  const erste = !(a.karten > 0);
  const symbol = dringend ? "🔴 Dringend · " : !erste ? "🔄 " : (a.kvaTs || a.status !== "neu") ? "🆕 " : "🟡 ";
  const z = [];
  z.push(symbol + "Nr. " + a.nr + " · " + (a.name || "Name nicht genannt") + " · " +
    (erreichbar(a) || (a.kanal === "web" ? "Website, kein Rückweg" : "keine Nummer")));
  z.push((l.kurz || anliegenKurz(a)).slice(0, 230));
  const da = l.liegtVor || [(a.fotos ? a.fotos + " Foto(s)" : ""), (a.fahrzeug ? "Fahrzeugdaten" : "")].filter(Boolean).join(", ");
  const fehlt = l.fehlt && !/^(nichts|keine?s?|-)\.?$/i.test(l.fehlt) ? l.fehlt : "";
  if (da || fehlt) z.push([da ? "Da: " + da : "", fehlt ? "Fehlt: " + fehlt : ""].filter(Boolean).join(" · "));
  if (l.will) z.push("Will: " + l.will);

  const tage = wartetTage(a);
  if (dringend) {
    const g = String(a.dringend.grund || "").trim().replace(/\.$/, "");
    z.push((tage >= 1 ? "Seit " + (tage === 1 ? "gestern" : tage + " Tagen") + " ohne Antwort. " : "") +
      (g ? g.charAt(0).toUpperCase() + g.slice(1) + "." : "") +
      (a.dringend.zitat ? "\n„" + a.dringend.zitat + "“" : ""));
  } else if (a.status === "termin") {
    z.push("Termin ist gebucht.");
  } else if (a.status === "neu" && !a.kvaTs) {
    z.push("Gespräch ruht, Angaben noch unvollständig." +
      (a.kanal === "whatsapp" && fensterOffen(a) && !a.nachhak1 && a.alexFragt ? " Ich hake gleich nach." : ""));
  } else if (l.stimmung && l.stimmung !== "ruhig") {
    z.push("Wirkt " + l.stimmung + ".");
  }
  if (l.empfehlung) z.push("👉 " + l.empfehlung);
  else if (dringend) z.push("👉 Bitte persönlich melden.");

  if (a.status === "neu") {
    z.push(a.kanal !== "whatsapp" ? "Kam über die Website, bitte anrufen oder mailen."
         : fensterOffen(a) ? "Preis schicken: einfach auf diese Nachricht antworten."
         : "WhatsApp ist zu, bitte anrufen.");
  }
  return z.join("\n").slice(0, 1000);
}

export function kartenKnoepfe(a) {
  const nr = a.nr;
  if (a.status === "neu" && a.kanal === "whatsapp" && fensterOffen(a) && !a.dringend) {
    return [{ id: "a:anruf:" + nr, titel: "Ich rufe an" }, { id: "a:vorbei:" + nr, titel: "Vorbeikommen" }, { id: "a:details:" + nr, titel: "Details" }];
  }
  return [{ id: "a:anruf:" + nr, titel: "Ich rufe an" }, { id: "a:details:" + nr, titel: "Details" }, { id: "a:erledigt:" + nr, titel: "Erledigt" }];
}

// Karte bauen und an Dirk geben (tagsueber sofort, nachts in die Morgen-
// Sammlung). Die KI-Aufbereitung dauert einige Sekunden; in der Zeit kann
// der Kunde weiterschreiben. Deshalb wird die Akte danach frisch geladen
// und nur gezielt geaendert, nie als veraltete Kopie zurueckgeschrieben.
export async function karteSenden(nr) {
  let a = await akteFinden(nr);
  if (!a) return false;
  const zuege = await gespraechLaden(nr);
  const lage = zuege.length
    ? await lageBeurteilen({ akte: a, zuege, anlass: "karte", fakten: { uebergeben: !!a.kvaTs } }).catch(() => null)
    : null;
  let bilder = [];
  a = await akteAendern(nr, x => {
    if (lage) x.lage = lage;
    bilder = (x.medienNeu || []).slice();
    x.medienNeu = [];
    x.karteOffen = false;
    x.karteTs = Date.now();
  });
  if (!a) return false;
  const ok = await meldenOderAufheben(fallKarte(a), {
    kurz: "Nr. " + a.nr + " · " + (a.name || "Kunde") + " · " + ((a.lage && a.lage.kurz) || anliegenKurz(a)).slice(0, 70),
    bilder, knoepfe: kartenKnoepfe(a), akteNr: a.nr, prio: a.dringend ? 2 : 0
  });
  await akteAendern(nr, x => { x.karten = (x.karten || 0) + 1; if (x.dringend) x.dringend.gemeldet = true; });
  await statPlus("karten").catch(() => {});
  return ok;
}

// Fotos einer Akte an eine Nummer schicken. Rueckgabe: Anzahl.
async function fotosSenden(an, a) {
  let n = 0;
  for (const id of (a.medien || [])) {
    if (await sendWABild(an, id, "Nr. " + a.nr + " · " + (a.name || "Kunde") + (a.medien.length > 1 ? " (" + (n + 1) + "/" + a.medien.length + ")" : ""))) n++;
  }
  return n;
}

// ---- Akte anlegen / fortschreiben ----------------------------------
// Akten von vor dem 14.11.2026 kennen die neuen Felder nicht.
function altAnpassen(a) {
  if (!a.kvaTs && (a.gemeldetKVA || (a.fahrzeug && a.status !== "gespraech"))) a.kvaTs = a.ts;
  if (a.gemeldetNeu && !a.karteTs) { a.karteTs = a.ts; a.karten = a.karten || 1; }
  if (!Array.isArray(a.verlauf)) a.verlauf = [];
  return a;
}

async function alleLaden() {
  const liste = await jsonLesen("anfragen", []);
  // Erledigte und reine Gespraeche nach 30 Tagen weg. Offene Anfragen
  // bleiben bis 90 Tage, sonst verschwinden genau die, die liegen.
  const jetzt = Date.now();
  const frisch = liste.filter(a => ["erledigt", "gespraech", "verloren"].includes(a.status)
    ? (a.letzterKontakt || a.ts) > jetzt - TAGE_AUFBEWAHRUNG * 86400000
    : a.ts > jetzt - TAGE_OFFEN_MAX * 86400000);
  if (frisch.length !== liste.length) {
    await jsonSchreiben("anfragen", frisch);
    // Mit der Akte verschwindet auch der Wortlaut des Gespraechs.
    for (const a of liste) if (!frisch.includes(a)) await redis("DEL", "akte:g:" + a.nr);
  }
  return frisch.map(altAnpassen);
}

function neueAkte(liste, { sitzung, kanal, kundeNr, status }) {
  const nr = (liste.length ? Math.max(...liste.map(x => x.nr)) : 0) + 1;
  const a = { nr, sitzung: sitzung || "", kanal, kundeNr: kanal === "whatsapp" ? String(kundeNr || "") : "",
              name: "", tel: "", thema: "", schaden: "", fahrzeug: "", fotos: 0,
              status: status || "neu", ts: Date.now(), verlauf: [] };
  liste.push(a);
  return a;
}
// Die laufende Akte einer Sitzung. Eine abgeschlossene zaehlt nicht:
// Meldet sich derselbe Kunde Wochen spaeter mit einem neuen Schaden,
// beginnt eine neue Anfrage.
function laufende(liste, sitzung) {
  return liste.filter(x => x.sitzung === sitzung && x.status !== "erledigt").pop() || null;
}

// Wird nach jeder Kundenantwort aufgerufen. Legt bei Bedarf eine Akte an
// und traegt nach, was neu bekannt wurde. Rueckgabe: Akte oder null.
//   antwort:    Alex' Antwort MIT Markern
//   alexText:   dieselbe Antwort, wie der Kunde sie sieht
//   verlaufWeb: nur Website, kompletter Verlauf aus dem Widget
export async function anfrageFortschreiben({ sitzung, kanal, kundeNr, antwort, kundentext, fotos, profilName, mediaIds, alexText, verlaufWeb }) {
  if (!sitzung) return null;
  const roh = String(antwort || "");
  const mK = roh.match(RE_KONTAKT), mV = roh.match(RE_KVA), mT = roh.match(RE_TERMIN), mD = roh.match(RE_DRINGEND);
  const mB = /\[\[BUCHUNG\|/.test(roh);
  const relevant = mK || mV || mT || mB || mD || (fotos > 0);
  const liste = await alleLaden();
  let akte = laufende(liste, sitzung);
  if (!akte && !relevant) return null;          // Smalltalk bekommt keine Akte
  const jetzt = Date.now();
  if (!akte) akte = neueAkte(liste, { sitzung, kanal, kundeNr, status: "neu" });

  const vorher = { kva: !!akte.kvaTs, dringend: !!akte.dringend, still: jetzt - (akte.letzterKontakt || akte.ts) };
  if (["gespraech", "verloren"].includes(akte.status) && relevant) { akte.status = "neu"; akte.leadTs = jetzt; }
  if (mK) { akte.name = (mK[1] || "").trim().slice(0, 60) || akte.name;
            akte.tel  = (mK[2] || "").trim().slice(0, 40) || akte.tel; }
  // WhatsApp liefert den Profilnamen mit: besser als "Name unbekannt"
  if (mK && (mK[1] || "").trim()) akte.nameQuelle = "kunde";
  if (!akte.name && profilName) { akte.name = String(profilName).trim().slice(0, 60); akte.nameQuelle = "profil"; }
  if (mV) { akte.schaden  = (mV[1] || "").trim().slice(0, 120) || akte.schaden;
            akte.fahrzeug = (mV[2] || "").trim().slice(0, 120) || akte.fahrzeug;
            if (!akte.kvaTs) akte.kvaTs = jetzt; }
  if (mT) { akte.status = "termin"; akte.termin = (mT[1] || "").trim(); }
  // Was der Kunde selbst geschrieben hat (ohne Platzhalter wie "(Foto vom
  // Schaden)"), damit Dirk die Anfrage versteht, ohne nachzufragen.
  const echt = String(kundentext || "").trim();
  const echterText = echt && !/^\(.*\)$/.test(echt) && echt.length > 3 ? echt : "";
  if (echterText) {
    if (!akte.thema) akte.thema = echterText.slice(0, 300);
    akte.notizen = [...(akte.notizen || []), echterText.slice(0, 300)].slice(-6);
  }
  akte.zuege = (akte.zuege || 0) + 1;
  akte.fotos += fotos || 0;
  // Foto-Kennungen bei WhatsApp, damit Dirk die Bilder bekommt und spaeter
  // abrufen kann ("Fotos N"). Gespeichert wird nur die Kennung.
  if (Array.isArray(mediaIds) && mediaIds.length) {
    akte.medien = [...(akte.medien || []), ...mediaIds].slice(-20);
    akte.medienNeu = [...(akte.medienNeu || []), ...mediaIds].slice(-20);
  }
  akte.letzterKontakt = jetzt;

  // Wartet Alex' Antwort auf etwas vom Kunden? (fuer das Nachhaken)
  const sichtbar = String(alexText != null ? alexText : roh).replace(/\[\[[A-Z_]+\|[^\]]*\]\]/g, "").trim();
  akte.alexFragt = /\?\s*$/.test(sichtbar);
  // Der Kunde ist nach einem Nachhaken zurueckgekommen: fuer die Auswertung.
  if (akte.nachhakOffen) { akte.nachhakOffen = false; akte.zurueckgeholt = (akte.zurueckgeholt || 0) + 1; await statPlus("zurueckgeholt").catch(() => {}); }
  // Neuer Anlauf nach einer langen Pause: Nachhaken darf wieder einmal.
  if (vorher.still > 6 * 3600000) { akte.nachhak1 = 0; akte.zwischenstand = 0; akte.erinnert = 0; }

  // ---- Dringend? ---------------------------------------------------
  // Entweder Alex erkennt es im Gespraech ([[DRINGEND|Grund]]), oder der
  // Kunde meldet sich erneut, obwohl die zugesagte Rueckmeldung laengst
  // ueberfaellig ist. Dann ist es Chefsache und kein Fall fuer Standardtexte.
  let neuDringend = false;
  const ueberfaellig = akte.status === "neu" && jetzt - (akte.kvaTs || wartetSeit(akte)) > UEBERFAELLIG_STD * 3600000;
  if (!vorher.dringend && (mD || (ueberfaellig && (echterText || fotos > 0)))) {
    akte.dringend = {
      grund: mD ? ((mD[1] || "").trim().slice(0, 120) || "Kunde ist verärgert.") : "Meldet sich erneut und hat noch keine Antwort.",
      zitat: echterText.slice(0, 160), ts: jetzt
    };
    neuDringend = true;
    await statPlus("dringend").catch(() => {});
  } else if (akte.dringend && echterText) {
    akte.dringend.zitat = echterText.slice(0, 160);
  }

  // ---- Braucht Dirk eine (neue) Karte? --------------------------------
  const neuKva = !!akte.kvaTs && !vorher.kva;
  if (fotos > 0 || neuKva || neuDringend || (mK && !akte.karteTs)) akte.karteOffen = true;
  // Eine Buchung meldet sich selbst. Die Karte kommt dann nur noch, wenn
  // sie Fotos oder Fahrzeugdaten mitbringt.
  if ((mB || mT) && !((akte.medienNeu || []).length || akte.kvaTs)) akte.karteOffen = false;

  await jsonSchreiben("anfragen", liste.slice(-120));

  // Gespraech festhalten
  try {
    const dauer = gespraechDauer(akte);
    if (kanal === "web" && Array.isArray(verlaufWeb)) {
      await gespraechSetzen(akte.nr, verlaufWeb, dauer);
    } else {
      await gespraechAnhaengen(akte.nr, "K", (fotos > 0 && !echterText ? "(" + fotos + " Foto" + (fotos > 1 ? "s" : "") + ")" : echt) +
        (fotos > 0 && echterText ? " (" + fotos + " Foto" + (fotos > 1 ? "s" : "") + ")" : ""), dauer);
      await gespraechAnhaengen(akte.nr, "A", sichtbar, dauer);
    }
  } catch (e) { console.error("gespraech", e && e.message); }

  // Sofort melden, wenn die Anfrage uebergeben oder dringend ist. Alles
  // andere kommt, sobald das Gespraech ruht (fallPflege).
  // (Website-Besucher ohne Nummer: Dirk koennte nichts tun. Dann fragt
  // Alex zuerst nach dem Rueckweg; die Karte kommt, sobald er da ist.)
  const erreichbarJetzt = akte.kanal === "whatsapp" || !!akte.tel;
  if (akte.karteOffen && (neuKva || neuDringend) && erreichbarJetzt) {
    await karteSenden(akte.nr).catch(e => console.error("karte", e && e.message));
  }
  return akte;
}

// ---- Akten-Helfer (auch fuer die Buchung) ----------------------------
export async function akteFinden(nr) {
  return (await alleLaden()).find(a => a.nr === Number(nr)) || null;
}
export async function akteSpeichern(akte) {
  const liste = await alleLaden();
  const i = liste.findIndex(a => a.nr === akte.nr);
  if (i >= 0) liste[i] = akte; else liste.push(akte);
  await jsonSchreiben("anfragen", liste.slice(-120));
}
// Eine Akte gezielt aendern: frisch laden, aendern, sofort schreiben. So
// ueberschreibt eine lange laufende Aufgabe (KI-Anfrage, Versand) nichts,
// was in der Zwischenzeit dazugekommen ist.
export async function akteAendern(nr, fn) {
  const liste = await alleLaden();
  const a = liste.find(x => x.nr === Number(nr));
  if (!a) return null;
  fn(a);
  await jsonSchreiben("anfragen", liste.slice(-120));
  return a;
}
export async function akteHolenOderAnlegen({ kanal, kundeNr, sitzung, name, tel, thema, status }) {
  const liste = await alleLaden();
  let a = (sitzung && laufende(liste, sitzung)) ||
          (kanal === "whatsapp" && kundeNr && liste.filter(x => x.kundeNr === String(kundeNr) && x.status !== "erledigt").pop());
  if (!a) a = neueAkte(liste, { sitzung, kanal, kundeNr, status: status || "neu" });
  if (name && !a.name) a.name = String(name).slice(0, 60);
  if (tel && !a.tel) a.tel = String(tel).slice(0, 40);
  if (thema && !a.thema) a.thema = String(thema).slice(0, 140);
  a.letzterKontakt = kanal === "whatsapp" ? Date.now() : a.letzterKontakt;
  await jsonSchreiben("anfragen", liste.slice(-120));
  return a;
}

// ---- An den Kunden schreiben (mit ehrlicher Grenze) ------------------
// Rueckgabe: { ok, grund } - bei !ok bekommt Dirk den Text zum Selbstschicken.
export async function anKunde(akte, text, vorlage) {
  if (akte.kanal !== "whatsapp" || !akte.kundeNr) {
    return { ok: false, grund: "Anfrage kam über die Website, dort kann ich nicht mehr schreiben" };
  }
  // Innerhalb von 24 h nach der letzten Kundennachricht darf frei
  // geschrieben werden.
  const frei = akte.letzterKontakt && (Date.now() - akte.letzterKontakt) < 23.5 * 3600000;
  if (frei && await sendWA(akte.kundeNr, text)) return { ok: true };

  // Sonst nur mit genehmigter Meta-Vorlage. Name der Vorlage kommt aus
  // der Umgebung (siehe META_VORLAGEN.md). Ohne Vorlage: ehrlich sagen.
  if (vorlage && process.env[vorlage]) {
    const r = await sendWAVorlage(akte.kundeNr, process.env[vorlage], [akte.name || "Kundin/Kunde", text]);
    if (r) return { ok: true };
    return { ok: false, grund: "Vorlage " + process.env[vorlage] + " wurde von WhatsApp abgelehnt" };
  }
  return { ok: false, grund: "der Kunde hat sich seit über 24 h nicht gemeldet und es ist keine genehmigte WhatsApp-Vorlage hinterlegt" };
}

async function anInhaber(text, kurz, art) {
  // Briefing und Wochenbericht entstehen nur tagsueber (siehe
  // weckerAufgaben), deshalb hier keine Nachtliste mehr: Sie kaemen sonst
  // Stunden spaeter mit dem irrefuehrenden Kopf "kam nachts rein".
  return zustellenAnInhaber(text, { kurz, art });
}

function zeile(a) {
  return "Nr. " + a.nr + " · " + (a.name || "Name nicht genannt") + " · " + (erreichbar(a) || "keine Nummer") +
    "\n   " + anliegenKurz(a) + (a.fotos ? " · " + a.fotos + " Foto(s)" : "") +
    "\n   " + (STATUS_TEXT[a.status] || a.status) + ", " + alterText(a.ts) + (a.kanal === "web" ? " · Website" : "");
}

// ---- Befehle vom Inhaber -----------------------------------------
export async function offeneAnfragen() {
  return (await alleLaden()).filter(OFFEN);
}

// Lange Texte in WhatsApp-taugliche Stuecke teilen (an Absaetzen)
function stuecke(text, max = 3500) {
  const teile = []; let akt = "";
  for (const absatz of String(text).split("\n\n")) {
    if (akt && (akt + "\n\n" + absatz).length > max) { teile.push(akt); akt = absatz; }
    else akt = akt ? akt + "\n\n" + absatz : absatz;
  }
  if (akt) teile.push(akt);
  return teile;
}

// Dirk fragt frei nach allem ("Schick mir saemtliche Fotos und
// detaillierte Anfragen"). Erkennen ohne KI, damit es sicher klappt.
export function willAlleDetails(s) {
  const t = String(s || "").toLowerCase();
  if (/^(merk|lern|notiz|vergiss|angebot|erledigt|l(ö|oe)sch)/.test(t.trim()) || t.length > 200) return false;
  const menge = /(alle|sämtliche|saemtliche|samtliche|jede|komplett|gesamt|ganzen?)/.test(t);
  const was = /(anfrage|foto|bild|detail)/.test(t);
  return (menge && was) || /^(details|alle details|alles im detail)$/.test(t.trim());
}

export async function anfrageBefehl(t, an) {
  const s = String(t || "").trim();
  let m;

  if (/^(offene\s+)?anfragen\??$/i.test(s)) {
    const offen = await offeneAnfragen();
    return offen.length
      ? "Offene Anfragen (" + offen.length + ")\n────────\n" + offen.map(zeile).join("\n\n") +
        "\n\n\"Anfrage 3\" zeigt alles zu Nr. 3 samt Fotos · \"Alle Details\" schickt alle\n" +
        "\"Angebot 3: [Preis], [was gemacht wird]\" · \"Erledigt 3\""
      : "Keine offenen Anfragen.";
  }

  m = s.match(/^(?:anfrage|nr\.?|details?)\s*(\d+)$/i);
  if (m) {
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht. \"Anfragen\" zeigt die offenen.";
    if (an && (a.medien || []).length) {
      await sendWA(an, anfrageDetail(a));
      await fotosSenden(an, a);
      return "Das waren alle " + a.medien.length + " Foto(s) zu Nr. " + a.nr + ".";
    }
    return anfrageDetail(a);
  }

  m = s.match(/^(?:vorbeikommen|begutachtung|einladen)\s+(\d+)$/i);
  if (m) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    const r = await zurBegutachtungEinladen(a);
    await akteAendern(a.nr, x => {
      x.verlauf.push(heuteKurz() + " zur Begutachtung eingeladen" + (r.ok ? "" : " (nicht zugestellt)"));
      if (r.ok) { x.eingeladen = Date.now(); x.zwischenstand = Date.now(); x.nachhakOffen = true; }
    });
    return r.ok
      ? "Erledigt: " + (a.name || "Der Kunde") + " ist zur kostenlosen Begutachtung eingeladen. Bucht er einen Termin, siehst du ihn sofort.\n\nGeschickt:\n" + r.text
      : "Konnte Nr. " + a.nr + " nicht einladen: " + r.grund + ". Bitte selbst melden: " + (erreichbar(a) || "keine Nummer");
  }

  // Das Gespraech im Wortlaut: damit Dirk auf demselben Stand uebernimmt
  m = s.match(/^(?:gespr(?:ä|ae)ch|verlauf|chat)\s*(?:von|zu|nr\.?)?\s*(\d+)$/i);
  if (m) {
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    const zuege = await gespraechLaden(a.nr);
    if (!zuege.length) return "Zu Nr. " + a.nr + " habe ich kein Gespräch mehr. Der Wortlaut wird seit dem 14.11. aufbewahrt." +
      (a.notizen && a.notizen.length ? "\n\nDer Kunde schrieb:\n" + a.notizen.map(n => "„" + n + "“").join("\n") : "");
    const text = "Gespräch Nr. " + a.nr + " · " + (a.name || "Kunde") + (erreichbar(a) ? " · " + erreichbar(a) : "") + "\n────────\n" + gespraechFuerDirk(zuege, 40);
    if (!an) return text;
    const teile = stuecke(text.replace(/\n/g, "\n\n"), 3500).map(t => t.replace(/\n\n/g, "\n"));
    for (const st of teile.slice(0, -1)) await sendWA(an, st);
    return teile[teile.length - 1];
  }

  m = s.match(/^(?:anruf|ich rufe an|rufe an)\s*(\d+)$/i);
  if (m) return karteAktion(an, "anruf", Number(m[1]));

  m = s.match(/^(?:fotos?|bilder?)\s*(?:von|zu|nr\.?)?\s*(\d+)$/i);
  if (m) {
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    if (!(a.medien || []).length) return a.fotos
      ? "Zu Nr. " + a.nr + " kamen " + a.fotos + " Foto(s), aber vor dem 13.11. habe ich mir die Bilder noch nicht gemerkt. " +
        (erreichbar(a) ? "Bitte beim Kunden nachfragen: " + erreichbar(a) : "")
      : "Zu Nr. " + a.nr + " gibt es keine Fotos.";
    const n = an ? await fotosSenden(an, a) : 0;
    return n ? n + " Foto(s) zu Nr. " + a.nr + " geschickt." : "Die Fotos konnte ich gerade nicht schicken. WhatsApp hält sie etwa 30 Tage bereit.";
  }

  // Alles auf einmal: jede offene Anfrage im Detail, Fotos hinterher
  if (willAlleDetails(s)) {
    const offen = await offeneAnfragen();
    if (!offen.length) return "Es gibt gerade keine offenen Anfragen.";
    const text = "Alle offenen Anfragen im Detail (" + offen.length + ")\n\n" + offen.map(anfrageDetail).join("\n\n");
    if (!an) return text;
    for (const st of stuecke(text)) await sendWA(an, st);
    let fotos = 0, alteFotos = 0;
    for (const a of offen) { fotos += await fotosSenden(an, a); if (a.fotos && !(a.medien || []).length) alteFotos++; }
    return (fotos ? fotos + " Foto(s) sind mitgekommen." : "Fotos konnte ich keine mitschicken.") +
      (alteFotos ? " Bei " + alteFotos + " älteren Anfrage(n) kamen die Fotos vor dem 13.11., die Bilder habe ich mir damals noch nicht gemerkt." : "");
  }

  m = s.match(/^angebot\s+(\d+)\s*[:\-–]\s*([\s\S]{3,})$/i);
  if (m) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht. \"Anfragen\" zeigt die offenen.";
    const inhalt = m[2].trim();
    const text = "Guten Tag" + (a.name ? " " + a.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
      "Dirk hat Ihren Schaden kalkuliert: " + inhalt + ". " +
      "Der Kostenvoranschlag ist unverbindlich, der genaue Betrag steht nach der Begutachtung fest. " +
      "Wenn das für Sie passt, schlage ich Ihnen gern einen Termin vor. Bei Fragen erreichen Sie uns unter 030 607 97 930.";
    const r = await anKunde(a, text, "WA_VORLAGE_ANGEBOT");
    if (r.ok) {
      await verlaufAnhaengen(a.kundeNr, text).catch(() => {});
      await gespraechAnhaengen(a.nr, "A", text).catch(() => {});
    }
    await akteAendern(a.nr, x => {
      x.status = "angebot"; x.angebotTs = Date.now(); x.angebot = inhalt;
      delete x.dringend; x.karteOffen = false; x.nachhakOffen = false;
      x.verlauf.push(heuteKurz() + " Angebot: " + inhalt.slice(0, 80) + (r.ok ? " (an Kunden geschickt)" : " (nicht zustellbar)"));
    });
    return r.ok
      ? "Angebot an " + (a.name || "den Kunden") + " geschickt. Ich melde mich, wenn er antwortet oder nach " + NACHFASS_TAGE + " Tagen still bleibt."
      : "Angebot notiert, aber ich konnte es nicht selbst schicken: " + r.grund + ".\n" +
        (a.tel || a.kundeNr ? "Bitte selbst an " + (a.tel || a.kundeNr) + " schicken, hier der Text:\n\n" + text : "Es liegt keine Nummer vor.");
  }

  // "Erledigt 3" oder mehrere auf einmal: "Erledigt 2 3 4"
  m = s.match(/^erledigt\s+((?:\d+[\s,]*(?:und\s+)?)+)$/i);
  if (m) {
    const nummern = (m[1].match(/\d+/g) || []).map(Number);
    const weg = [], fehlt = [];
    for (const nr of nummern) {
      const a = await akteAendern(nr, x => {
        x.status = "erledigt"; x.erledigtTs = Date.now(); delete x.dringend; x.karteOffen = false;
        x.verlauf.push(heuteKurz() + " erledigt");
      });
      if (a) await redis("EXPIRE", "akte:g:" + nr, ABGESCHLOSSEN_SEK);
      (a ? weg : fehlt).push(nr);
    }
    // Bewertungsbitte NICHT automatisch: unaufgefordert kann sie als
    // Werbung ohne Einwilligung gelten. Dirk schickt sie mit
    // "Bewertung N", wenn der Kunde zugestimmt hat.
    const zusatz = process.env.BEWERTUNGS_LINK && weg.length === 1
      ? " Hat der Kunde gesagt, dass er eine Bewertung schreiben mag? Dann \"Bewertung " + weg[0] + "\"." : "";
    return (weg.length ? (weg.length === 1 ? "Anfrage " + weg[0] + " abgeschlossen." : "Abgeschlossen: Nr. " + weg.join(", ") + ".") : "") +
      (fehlt.length ? " Nicht gefunden: Nr. " + fehlt.join(", ") + "." : "") + zusatz;
  }

  m = s.match(/^bewertung\s+(\d+)$/i);
  if (m) {
    if (!process.env.BEWERTUNGS_LINK) return "Es ist noch kein Bewertungslink hinterlegt (Vercel: BEWERTUNGS_LINK).";
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    const text = "Guten Tag" + (a.name ? " " + a.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
      "Vielen Dank, dass Sie bei uns waren. Wie besprochen hier der Link für Ihre Bewertung: " + process.env.BEWERTUNGS_LINK;
    const r = await anKunde(a, text, "WA_VORLAGE_BEWERTUNG");
    return r.ok ? "Bewertungslink an " + (a.name || "den Kunden") + " geschickt."
                : "Konnte nicht schicken (" + r.grund + ")." + (a.tel ? " Bitte selbst an " + a.tel + ":\n\n" + text : "");
  }

  m = s.match(/^nachfassen\s+(\d+)$/i);
  if (m) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    const text = "Guten Tag" + (a.name ? " " + a.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
      "Ich wollte kurz nachhören, ob Sie unser Angebot erhalten haben und ob noch Fragen offen sind. " +
      "Wenn Sie möchten, schlage ich Ihnen gern einen Termin vor.";
    const r = await anKunde(a, text, "WA_VORLAGE_NACHFASSEN");
    a.nachgefasst = Date.now();
    a.verlauf.push(new Date().toLocaleDateString("de-DE") + " nachgefasst" + (r.ok ? "" : " (nicht zustellbar)"));
    await jsonSchreiben("anfragen", liste);
    return r.ok ? "Nachgefasst bei " + (a.name || "dem Kunden") + "."
                : "Konnte nicht nachfassen: " + r.grund + "." + (a.tel ? " Nummer: " + a.tel : "");
  }

  if (/^protokoll(\s+gestern)?$/i.test(s)) {
    const gestern = /gestern/i.test(s);
    const d = new Date(Date.now() - (gestern ? 86400000 : 0));
    const tag = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    return await protokoll(tag);
  }

  return null;
}

// ---- Kundennachricht kam nicht an ---------------------------------------
// WhatsApp meldet erst nachtraeglich, wenn eine Nachricht an einen Kunden
// nicht zugestellt wurde (meist: Kunde hat seit ueber 24 Std. nicht
// geschrieben). Dann darf Dirk nicht glauben, der Kunde habe das Angebot.
export async function kundenZustellungGescheitert({ kunde, text }) {
  const a = (await alleLaden()).filter(x => x.kundeNr === String(kunde) && x.status !== "erledigt").pop();
  if (!a) return false;
  await akteAendern(a.nr, x => {
    x.verlauf.push(heuteKurz() + " Nachricht an Kunden NICHT angekommen");
    x.nachhakOffen = false;
    // Der Kunde ist nicht mehr per WhatsApp erreichbar
    x.letzterKontakt = Math.min(x.letzterKontakt || 0, Date.now() - FENSTER_STD * 3600000);
  });
  if (!(await einmalHeute("nichtzugestellt:" + a.nr))) return true;
  await meldenOderAufheben("⚠ Nr. " + a.nr + " · " + (a.name || "Kunde") + ": Meine Nachricht kam NICHT an. " +
    "WhatsApp lässt nach 24 Std. ohne Antwort des Kunden nichts mehr durch.\n" +
    (erreichbar(a) ? "Bitte anrufen: " + erreichbar(a) + "\n" : "") +
    (text ? "Das sollte ankommen:\n„" + String(text).slice(0, 400) + "“" : ""),
    { kurz: "Nachricht an Nr. " + a.nr + " nicht angekommen", akteNr: a.nr, knoepfe: kartenKnoepfe(await akteFinden(a.nr) || a), prio: 1 }).catch(() => {});
  return true;
}

// ---- Knoepfe unter der Karte ------------------------------------------
// aktion: anruf | vorbei | details | erledigt
export async function karteAktion(an, aktion, nr) {
  const a = await akteFinden(nr);
  if (!a) return "Anfrage " + nr + " kenne ich nicht.";

  if (aktion === "anruf") {
    // Der Kunde erfaehrt es, solange WhatsApp offen ist. Kein Tag, keine Uhrzeit.
    let gesagt = false;
    if (fensterOffen(a) && !a.anruf) {
      gesagt = await kundeSchreiben(a, "Kurze Rückmeldung von Alex aus der Autolackiererei in Britz. Die Werkstatt meldet sich persönlich telefonisch bei Ihnen.");
    }
    await akteAendern(nr, x => { x.anruf = Date.now(); delete x.dringend; x.karteOffen = false; x.verlauf.push(heuteKurz() + " Anruf zugesagt"); });
    return "Notiert, du rufst an: " + (a.name || "Kunde") + " · " + (erreichbar(a) || "keine Nummer") + "." +
      (gesagt ? " Der Kunde weiß Bescheid." : "") + "\nDanach: \"Erledigt " + nr + "\" oder das Angebot als Antwort auf die Karte.";
  }
  if (aktion === "vorbei") return anfrageBefehl("Vorbeikommen " + nr, an);
  if (aktion === "erledigt") return anfrageBefehl("Erledigt " + nr, an);
  if (aktion === "details") {
    const zuege = await gespraechLaden(nr);
    const text = anfrageDetail(a) + (zuege.length ? "\n\nGespräch (letzte Nachrichten)\n────────\n" + gespraechFuerDirk(zuege, 12) : "");
    if (!an) return text;
    await sendWA(an, text.slice(0, 3900));
    const n = await fotosSenden(an, a);
    return n ? "Dazu " + n + " Foto(s)." : "";
  }
  return null;
}

// Dirk antwortet direkt auf eine Karte (in WhatsApp: Nachricht nach rechts
// wischen). Dann ist klar, welche Anfrage gemeint ist. Rueckgabe: Text
// fuer Dirk, oder null, wenn Alex frei antworten soll.
export async function antwortAufKarte(an, nr, text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/^(erledigt|abgeschlossen|kann weg|weg damit)\.?$/i.test(t)) return karteAktion(an, "erledigt", nr);
  if (/^(vorbeikommen|begutachtung|einladen|soll vorbeikommen|ansehen)\.?$/i.test(t)) return karteAktion(an, "vorbei", nr);
  if (/^(details?|mehr|zeig|alles)\.?$/i.test(t)) return karteAktion(an, "details", nr);
  if (/^(ich )?(rufe?|ruf) (ihn |sie |den |die )?an\.?$/i.test(t) || /^anruf\.?$/i.test(t)) return karteAktion(an, "anruf", nr);
  if (/^(fotos?|bilder?)\.?$/i.test(t)) return anfrageBefehl("Fotos " + nr, an);
  if (/^(gespr(ä|ae)ch|verlauf|chat)\.?$/i.test(t)) return anfrageBefehl("Gespräch " + nr, an);
  if (/^(übernehme|uebernehme|übernehmen|uebernehmen)\.?$/i.test(t)) return null;   // macht whatsapp.js
  // Beginnt die Antwort mit einem Betrag ("480 Euro, Stoßfänger lackieren"),
  // ist das das Angebot und geht so raus. Freier formuliert ("sag ihr 950
  // fuer beide Teile") macht Alex daraus erst einen Entwurf zum Bestaetigen.
  if (/^(ca\.?\s*|etwa\s*|rund\s*)?\d[\d.,]*\s*(€|euro|eur\b)/i.test(t)) return anfrageBefehl("Angebot " + nr + ": " + t, an);
  return null;
}

// ---- Protokoll (anonymisierte Verlaeufe + Akten) ---------------------
async function protokoll(tag) {
  const idx = await jsonLesen("lern:index", []);
  const teile = [];
  for (const k of idx) {
    let g = null;
    try { g = JSON.parse(await redis("GET", "lern:g:" + k)); } catch (_) {}
    if (!g) continue;
    const gTag = new Date(g.ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    if (gTag !== tag) continue;
    const uhr = new Date(g.ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
    teile.push("▶ " + uhr + " · " + (g.kanal === "web" ? "Website" : "WhatsApp") + "\n" +
      g.zuege.map(z => (z.wer === "Alex" ? "  Alex: " : "  Kunde: ") + z.text.replace(/\n+/g, " ").slice(0, 220)).join("\n"));
  }
  const akten = (await alleLaden()).filter(a => new Date(a.ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) === tag);
  const kopf = "Protokoll " + tag.split("-").reverse().join(".") + "\n────────\n" +
    "Gespräche: " + teile.length + " · neue Anfragen: " + akten.length + "\n" +
    (akten.length ? akten.map(a => "· Nr. " + a.nr + " " + (a.name || "ohne Name") + " – " + (a.schaden || a.thema || "").slice(0, 60)).join("\n") + "\n" : "") +
    "(Verläufe anonymisiert: Namen/Nummern durch Platzhalter ersetzt)\n\n";
  if (!teile.length) return kopf + "Keine Gespräche an diesem Tag.";
  return kopf + teile.join("\n\n");
}

// ---- Fehlerzaehler (fuer Wochenbericht und Stoerungsmeldung) ------------
const ART_KLAR = {
  leer: "Die KI hat geantwortet, aber ohne Text für den Gesprächspartner – auch ein zweiter Versuch blieb leer.",
  modell: "Die KI war nicht erreichbar oder hat mit einem Fehler geantwortet.",
  strom: "Die Antwort im Website-Chat ist mittendrin abgebrochen.",
  zustellung: "Eine Meldung an Dirk kam weder per WhatsApp noch per E-Mail an.",
  vorlage: "WhatsApp hat eine Nachrichtenvorlage abgelehnt."
};

export async function fehlerZaehlen(art, grund, ersatz) {
  const tag = berlinJetzt().datum;
  const n = Number(await redis("INCR", "fehler:" + tag + ":" + art)) || 0;
  await redis("EXPIRE", "fehler:" + tag + ":" + art, 8 * 86400);
  await fehlerLog(art, grund || "");
  // Erster Aussetzer des Tages: kurze, verstaendliche Mail an die Technik
  // (nicht an Dirk). Weitere stehen unter "Status".
  if (n === 1 && await einmalHeute("technikmail")) {
    await sendMail("Alex: Aussetzer heute – " + (ersatz ? "Gesprächspartner hat eine Ersatzantwort bekommen" : "bitte kurz prüfen"),
      "Was passiert ist:\n" + (ART_KLAR[art] || art) + "\n\n" +
      "Einzelheiten:\n" + (grund || "keine") + "\n\n" +
      (ersatz ? "Was stattdessen geschickt wurde:\n„" + String(ersatz).slice(0, 300) + "“\n\n" +
                "Handlungsbedarf: keiner, das Gespräch ist nicht abgerissen. Häufen sich solche Fälle, bitte melden.\n\n"
              : "Handlungsbedarf: bitte prüfen.\n\n") +
      "Alle Aussetzer mit Uhrzeit: per WhatsApp „Status“ an Alex. Weitere Mails kommen heute nicht.",
      process.env.TECHNIK_MAIL || process.env.NOTFALL_MAIL);
  }
  return n;
}

async function fehlerSumme(tage) {
  const arten = ["modell", "strom", "leer", "whatsapp"];
  let summe = 0;
  for (let i = 0; i < tage; i++) {
    const tag = new Date(Date.now() - i * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    for (const a of arten) summe += Number(await redis("GET", "fehler:" + tag + ":" + a)) || 0;
  }
  return summe;
}

// ---- Wecker-Aufgaben (aus api/cron.js) --------------------------------
// Morgenbriefing um 8 Uhr an Werktagen, Wochenbericht freitags 16 Uhr,
// Terminerinnerung fuer morgen, Mahnung bei liegenden Angeboten,
// Nachfass-Vorschlag bei stillen Angeboten. Jede Aufgabe laeuft pro Tag
// hoechstens einmal (Marke im Speicher).
// Einmal pro Kalenderwoche (Montag als Wochenstart)
async function einmalDieseWoche(name) {
  const j = berlinJetzt();
  const d = new Date(j.datum + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const r = await redis("SET", "einmal:" + name + ":" + d.toISOString().slice(0, 10), "1", "NX", "EX", 9 * 86400);
  return r === "OK";
}

async function einmalHeute(name) {
  const tag = berlinJetzt().datum;
  const r = await redis("SET", "einmal:" + name + ":" + tag, "1", "NX", "EX", 2 * 86400);
  return r === "OK";
}


// ---- Fallpflege: der Herzschlag der Anlage ----------------------------
// Laeuft alle 15 Minuten (Wecker) und zusaetzlich nach jeder Nachricht.
// Sieht jede offene Akte an und tut das, was ein aufmerksamer Mitarbeiter
// taete:
//   1. Gespraech ruht -> Dirk bekommt die Karte (einmal, vollstaendig).
//   2. Kunde ist mittendrin verstummt -> einmal freundlich zurueckholen.
//   3. WhatsApp schliesst bald, noch kein Angebot -> ehrlicher
//      Zwischenstand. NICHT bei Kunden, die schon lange warten oder
//      veraergert sind: Die sind Chefsache.
//   4. Dirk erinnern, wenn ein Angebot aussteht.
// Jede Aktion wird ERST in der Akte vermerkt und DANN ausgefuehrt. Bricht
// die Funktion mittendrin ab, faellt eine Nachricht aus, aber keine geht
// doppelt raus.

// Nachricht von Alex in den Gespraechsverlauf des Kunden schreiben,
// damit Alex die Antwort des Kunden ("ja, Donnerstag") versteht.
async function verlaufAnhaengen(kundeNr, text) {
  const l = await jsonLesen("wa:" + kundeNr, []);
  const letzte = l[l.length - 1];
  if (letzte && letzte.role === "assistant" && typeof letzte.content === "string") letzte.content += "\n" + text;
  else l.push({ role: "assistant", content: text });
  await jsonSchreiben("wa:" + kundeNr, l.slice(-20), 86400);
}

async function freieBegutachtung(max = 3) {
  try {
    // Je Tag ein Vorschlag, damit der Kunde echte Auswahl hat
    const { freieFenster } = await import("./_buchung.mjs");
    const tage = (await freieFenster(max)).slice(0, max);
    const t = tage.map(d => d.label + " (" + Number(d.datum.slice(8)) + "." + Number(d.datum.slice(5, 7)) + ".) " +
      d.fenster[0][0] + "–" + d.fenster[0][1] + " Uhr");
    return t.length > 1 ? t.slice(0, -1).join(", ") + " oder " + t[t.length - 1] : t.join("");
  } catch (_) { return ""; }
}

async function inUebernahme(a) {
  return !!(a.kundeNr && await redis("GET", "ueb:kunde:" + a.kundeNr));
}

// An den Kunden schreiben und es ueberall festhalten: im Gedaechtnis von
// Alex und im Gespraech der Akte.
async function kundeSchreiben(a, text, wer = "A") {
  if (!(await sendWA(a.kundeNr, text))) return false;
  await verlaufAnhaengen(a.kundeNr, wer === "D" ? "[Werkstatt persönlich] " + text : text).catch(() => {});
  await gespraechAnhaengen(a.nr, wer, text).catch(() => {});
  return true;
}

// Fester Text, falls die KI gerade nicht erreichbar ist.
function einladungsText(a, zwischenstand, frei) {
  // Profilnamen aus WhatsApp ("Mo 🚗") nicht als Anrede verwenden
  const anrede = "Guten Tag" + (a.name && a.nameQuelle !== "profil" ? " " + a.name : "") + ", hier ist noch einmal Alex von der Autolackiererei in Britz. ";
  return anrede + (zwischenstand
      ? "Kurzer Zwischenstand: Ihre Anfrage liegt bei unserem Team, der Kostenvoranschlag ist noch in Arbeit. "
      : "Unser Team möchte sich Ihren Schaden gern einmal direkt ansehen, damit der Preis wirklich stimmt. ") +
    "Wenn Sie nicht warten möchten: Die Begutachtung ist kostenlos und dauert etwa 15 bis 30 Minuten, Haarlemer Straße 48-54 in Britz." +
    (frei ? " Frei wäre zum Beispiel " + frei + "." : "") +
    " Soll ich Ihnen einen Termin eintragen, oder warten Sie lieber auf den Kostenvoranschlag?";
}

// Kunde zur kostenlosen Begutachtung einladen (Dirk: "Vorbeikommen N").
async function zurBegutachtungEinladen(a) {
  if (!fensterOffen(a)) return { ok: false, grund: "der Kunde hat seit über 24 Std. nicht geschrieben" };
  const text = einladungsText(a, false, await freieBegutachtung(3));
  if (!(await kundeSchreiben(a, text))) return { ok: false, grund: "WhatsApp hat die Nachricht nicht angenommen" };
  return { ok: true, text };
}

const heuteKurz = () => new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });

// Schalter: Darf Alex Kunden von sich aus anschreiben (Nachhaken,
// Zwischenstand, Nachhaken im Website-Chat)? Dirk: "Nachhaken aus/an".
export async function nachhakenAktiv() {
  return ((await redis("GET", "einstellung:nachhaken")) || "an") !== "aus";
}

export async function fallPflege({ kiBudget = 2, bis = 0 } = {}) {
  // "bis": nach diesem Zeitpunkt keine KI-Anfrage mehr beginnen (die
  // Funktion hat nur 60 Sekunden; was nicht mehr passt, macht der naechste Lauf).
  const zeitDa = () => !bis || Date.now() < bis;
  // Nur ein Lauf gleichzeitig: Wecker und Kundennachricht koennen zusammenfallen.
  const sperre = await redis("SET", "sperre:fallpflege", "1", "NX", "EX", 100);
  if (sperre === null) return [];
  const getan = [];
  try {
    const j = berlinJetzt();
    const jetzt = Date.now();
    const kundenzeit = j.stunde >= KUNDEN_VON && j.stunde < KUNDEN_BIS && await nachhakenAktiv();

    for (const s of await alleLaden()) {
      if (["erledigt", "verloren"].includes(s.status)) continue;
      const still = jetzt - (s.letzterKontakt || s.ts);

      // Website-Besucher mit Fotos, aber ohne Rueckweg: Niemand kann etwas
      // tun. Nicht als "wartet auf dein Angebot" stehen lassen.
      if (s.kanal === "web" && s.status === "neu" && !s.tel && !s.kundeNr && still > 2 * 3600000) {
        await akteAendern(s.nr, a => { a.status = "verloren"; a.karteOffen = false; a.verlauf.push(heuteKurz() + " ohne Rückweg gegangen"); });
        await statPlus("abbruchWeb").catch(() => {});
        getan.push("verloren " + s.nr);
        continue;
      }

      // 1) Gespraech ruht: Karte an Dirk
      // (Website-Besucher ganz ohne Rueckweg: keine Karte, Dirk koennte nichts tun.)
      if (s.karteOffen && s.status !== "gespraech" && still >= RUHE_MIN * 60000 && kiBudget > 0 && zeitDa() &&
          !(s.kanal === "web" && !s.tel && !s.kundeNr && !s.kvaTs)) {
        kiBudget--;
        await karteSenden(s.nr);
        getan.push("karte " + s.nr);
        continue;
      }

      if (s.kanal !== "whatsapp" || !fensterOffen(s) || !kundenzeit) continue;
      if (!["neu", "gespraech"].includes(s.status)) continue;

      // 2) Kunde ist mittendrin verstummt: einmal zurueckholen
      if (!s.kvaTs && !s.nachhak1 && s.alexFragt && !s.dringend && (s.zuege || 0) >= 1 &&
          still >= NACHHAKEN_MIN * 60000 && still <= NACHHAKEN_MAX_STD * 3600000 && kiBudget > 0 && zeitDa()) {
        if (await inUebernahme(s)) continue;
        kiBudget--;
        await akteAendern(s.nr, a => { a.nachhak1 = jetzt; });
        const lage = await lageBeurteilen({
          akte: s, zuege: await gespraechLaden(s.nr), anlass: "nachhaken1",
          fakten: { stillMin: Math.round(still / 60000), uebergeben: false }
        }).catch(() => null);
        if (!lage) continue;
        const frisch = await akteFinden(s.nr);
        // Hat der Kunde in der Zwischenzeit geschrieben, ist er ja wieder da.
        if (!frisch || frisch.letzterKontakt !== s.letzterKontakt) continue;
        const gesendet = lage.haengt && lage.nachricht ? await kundeSchreiben(frisch, lage.nachricht) : false;
        await akteAendern(s.nr, a => {
          a.lage = { ...lage, nachricht: "" };
          if (gesendet) { a.nachhakOffen = true; a.nachhakTs = Date.now(); a.verlauf.push(heuteKurz() + " nachgehakt"); }
        });
        if (gesendet) { await statPlus("nachgehakt").catch(() => {}); getan.push("nachhaken " + s.nr); }
        continue;
      }

      // 3) Zwischenstand, bevor WhatsApp schliesst (nur echte Anfragen)
      if (s.status === "neu" && !s.zwischenstand && still >= ZWISCHENSTAND_AB_STD * 3600000) {
        if (await inUebernahme(s)) continue;
        await akteAendern(s.nr, a => { a.zwischenstand = jetzt; });
        // Wer lange wartet, veraergert ist oder einen Anruf zugesagt bekam,
        // bekommt keinen Standardtext. Das ist Chefsache.
        const langeWartend = jetzt - wartetSeit(s) > UEBERFAELLIG_STD * 3600000;
        if (s.dringend || s.anruf || langeWartend) {
          if (!s.dringend) await akteAendern(s.nr, a => {
            a.dringend = { grund: "Hat noch keine Antwort, WhatsApp schließt " + fensterBis(a) + " Uhr.", zitat: "", ts: jetzt };
            a.karteOffen = true;
          });
          continue;
        }
        let lage = null;
        if (kiBudget > 0 && zeitDa()) {
          kiBudget--;
          lage = await lageBeurteilen({
            akte: s, zuege: await gespraechLaden(s.nr), anlass: "nachhaken2",
            fakten: { stillStd: Math.round(still / 3600000), uebergeben: !!s.kvaTs, frei: await freieBegutachtung(3) }
          }).catch(() => null);
        }
        if (lage && lage.stimmung === "verärgert") {
          await akteAendern(s.nr, a => {
            a.lage = { ...lage, nachricht: "" };
            a.dringend = { grund: "Wirkt verärgert und hat noch keine Antwort.", zitat: "", ts: jetzt };
            a.karteOffen = true;
          });
          continue;
        }
        const text = (lage && lage.nachricht) || einladungsText(s, true, await freieBegutachtung(3));
        const frisch = await akteFinden(s.nr);
        if (!frisch || frisch.letzterKontakt !== s.letzterKontakt) continue;
        const ok = await kundeSchreiben(frisch, text);
        const a2 = await akteAendern(s.nr, a => {
          if (lage) a.lage = { ...lage, nachricht: "" };
          a.nachhakOffen = !!ok; a.nachhakTs = Date.now();
          a.verlauf.push(heuteKurz() + " Zwischenstand an Kunden" + (ok ? "" : " (nicht zugestellt)"));
        });
        if (ok && a2) {
          await statPlus("nachgehakt").catch(() => {});
          await meldenOderAufheben("📨 Nr. " + a2.nr + " · " + (a2.name || "Kunde") + ": Noch kein Angebot raus. " +
            "Ich habe dem Kunden den Stand gesagt und die kostenlose Begutachtung angeboten.",
            { kurz: "Zwischenstand an Nr. " + a2.nr, akteNr: a2.nr, knoepfe: kartenKnoepfe(a2) }).catch(() => {});
          getan.push("zwischenstand " + s.nr);
        }
        continue;
      }
    }

    // 4) Dirk erinnern: Anfrage ist uebergeben, Angebot steht aus,
    //    WhatsApp ist noch offen (nur werktags zu seinen Zeiten)
    if (!istRuhezeit() && j.wochentag >= 1 && j.wochentag <= 5) {
      const faellig = (await alleLaden()).filter(a => a.status === "neu" && a.kvaTs && a.karteTs && !a.erinnert && !a.dringend &&
        !a.anruf && fensterOffen(a) && jetzt - Math.max(a.kvaTs, a.karteTs) >= ERINNERUNG_STD * 3600000);
      for (const a of faellig) await akteAendern(a.nr, x => { x.erinnert = jetzt; });
      if (faellig.length === 1) {
        const a = faellig[0];
        await meldenOderAufheben("⏰ Nr. " + a.nr + " · " + (a.name || "Kunde") + " wartet auf dein Angebot.\n" +
          ((a.lage && a.lage.kurz) || anliegenKurz(a)).slice(0, 160) + "\n" +
          "WhatsApp offen bis " + fensterBis(a) + " Uhr. Preis: einfach hier antworten.",
          { kurz: "Nr. " + a.nr + " wartet auf dein Angebot", akteNr: a.nr, knoepfe: kartenKnoepfe(a) }).catch(() => {});
      } else if (faellig.length > 1) {
        await meldenOderAufheben("⏰ Warten auf dein Angebot (" + faellig.length + ")\n" +
          faellig.map(a => "· Nr. " + a.nr + " " + (a.name || "Kunde") + " · " + ((a.lage && a.lage.kurz) || anliegenKurz(a)).slice(0, 70) +
            " · offen bis " + fensterBis(a)).join("\n") +
          "\nPreis: \"Angebot " + faellig[0].nr + ": …\" · lieber ansehen: \"Vorbeikommen " + faellig[0].nr + "\"",
          { kurz: faellig.length + " Anfrage(n) warten auf dein Angebot" }).catch(() => {});
      }
      if (faellig.length) getan.push("erinnerung");
    }
  } catch (e) {
    console.error("fallPflege", e && e.message);
  } finally {
    await redis("DEL", "sperre:fallpflege");
  }
  return getan;
}

// ---- Laeuft der Wecker noch? ------------------------------------------
// Der Wecker (cron-job.org, alle 15 Min.) traegt sich hier ein. Bleibt er
// aus, merkt es die naechste Kundennachricht und die Technik bekommt
// einmal am Tag eine Mail. Ohne Wecker kaemen Karten und Nachhaken nur
// noch, wenn zufaellig jemand schreibt.
export async function herzschlag(vomWecker) {
  if (vomWecker) { await redis("SET", "herz:wecker", String(Date.now()), "EX", 30 * 86400); return true; }
  const letzter = Number(await redis("GET", "herz:wecker")) || 0;
  if (!letzter) return true;                       // Wecker war nie eingerichtet
  if (Date.now() - letzter < 75 * 60000) return true;
  if (await einmalHeute("weckermail")) {
    await sendMail("Alex: Der Wecker läuft nicht",
      "Der Wecker (cron-job.org, alle 15 Minuten) hat sich seit " + Math.round((Date.now() - letzter) / 60000) + " Minuten nicht gemeldet.\n\n" +
      "Folge: Meldungen an Dirk, das Nachhaken bei Kunden und die Erinnerungen kommen nur noch, wenn gerade jemand schreibt.\n\n" +
      "Bitte bei cron-job.org nachsehen, ob der Job \"Auto Britz\" aktiv ist und 200 meldet.",
      process.env.TECHNIK_MAIL || process.env.NOTFALL_MAIL).catch(() => {});
  }
  return false;
}

export async function weckerAufgaben({ bis = 0 } = {}) {
  const j = berlinJetzt();
  const werktag = j.wochentag >= 1 && j.wochentag <= 5;
  const erledigt = [];

  // 0) Fallpflege: Karten, Nachhaken, Zwischenstand, Erinnerung
  try { erledigt.push(...await fallPflege({ bis })); } catch (e) { console.error("fallPflege", e && e.message); }

  // 1) Morgenbriefing, Werktage ab 8 Uhr
  if (werktag && j.stunde >= 8 && !istRuhezeit() && await einmalHeute("briefing")) {
    const liste = await alleLaden();
    const offen = liste.filter(OFFEN);
    const neu = offen.filter(a => a.status === "neu");
    const dringend = neu.filter(a => a.dringend);
    const anruf = neu.filter(a => a.anruf && !a.dringend);
    const frisch = neu.filter(a => !a.dringend && !a.anruf && wartetTage(a) <= 5);
    const alt = neu.filter(a => !a.dringend && !a.anruf && wartetTage(a) > 5);
    const angebote = offen.filter(a => a.status === "angebot");
    const buchungen = (await jsonLesen("buchungen", [])).filter(b => b.status === "aktiv");
    const heute = buchungen.filter(b => b.datum === j.datum).sort((a, b) => a.von - b.von);
    const morgenTag = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const morgen = buchungen.filter(b => b.datum === morgenTag);
    const zeile1 = a => "· Nr. " + a.nr + " " + (a.name || "Name nicht genannt") + (erreichbar(a) ? " · " + erreichbar(a) : "");

    const t = ["Guten Morgen Dirk."];
    t.push("Heute: " + (heute.length ? heute.length + " Termin(e)\n" +
      heute.map(b => "· " + b.von + "–" + b.bis + " " + (b.name || "ohne Name") + " (" + b.art + ")").join("\n") : "keine Termine"));
    if (dringend.length) t.push("🔴 Bitte heute melden (" + dringend.length + ")\n" +
      dringend.map(a => zeile1(a) + "\n  " + ((a.lage && a.lage.kurz) || anliegenKurz(a)).slice(0, 80) + " · wartet " + alterText(wartetSeit(a))).join("\n"));
    if (anruf.length) t.push("📞 Anruf zugesagt (" + anruf.length + ")\n" + anruf.map(zeile1).join("\n"));
    t.push("Warten auf dein Angebot: " + frisch.length + (frisch.length ? "\n" +
      frisch.slice(0, 8).map(a => zeile1(a) + "\n  " + ((a.lage && a.lage.kurz) || anliegenKurz(a)).slice(0, 80) +
        (a.fotos ? " · " + a.fotos + " Foto(s)" : "") + " · " + alterText(wartetSeit(a))).join("\n") : ""));
    if (alt.length) t.push("Schon länger offen (" + alt.length + "): Nr. " + alt.map(a => a.nr).join(", ") +
      ".\nAnrufen oder abschließen: \"Erledigt " + alt.slice(0, 3).map(a => a.nr).join(" ") + "\"");
    // Nachfass-Vorschlag
    const still = angebote.filter(a => a.angebotTs && Date.now() - a.angebotTs > NACHFASS_TAGE * 86400000 && !a.nachgefasst);
    if (angebote.length) t.push("Angebote raus, noch offen: " + angebote.length +
      (still.length ? "\nStill seit " + NACHFASS_TAGE + " Tagen: Nr. " + still.map(a => a.nr).join(", ") + " → \"Nachfassen " + still[0].nr + "\"" : ""));
    // Terminerinnerung fuer morgen
    const erinnerungen = [];
    for (const b of morgen) {
      const a = liste.find(x => x.nr === b.akteNr) || { kanal: b.kanal, kundeNr: b.kundeNr, name: b.name, letzterKontakt: 0 };
      const ort = b.ort === "kleinmachnow" ? "Albert-Einstein-Ring 45, 14532 Kleinmachnow" : "Haarlemer Straße 48-54, 12359 Berlin";
      const r = await anKunde(a, "Guten Tag" + (b.name ? " " + b.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
        "Kurze Erinnerung an Ihren Termin morgen zwischen " + b.von + " und " + b.bis + " Uhr, " + ort + ". Bis morgen!", "WA_VORLAGE_ERINNERUNG");
      erinnerungen.push("· " + b.von + "–" + b.bis + " " + (b.name || "ohne Name") + ": " +
        (r.ok ? "erinnert" : "Erinnerung nicht möglich" + (b.tel ? ", " + b.tel : "")));
    }
    if (erinnerungen.length) t.push("Morgen\n" + erinnerungen.join("\n"));

    const kurzB = (heute.length ? heute.length + " Termin(e) heute" : "Heute keine Termine") +
      (dringend.length ? ", " + dringend.length + " dringend" : "") +
      (frisch.length ? ", " + frisch.length + " Anfrage(n) warten auf dein Angebot" : "");
    await anInhaber(t.join("\n\n"), kurzB, "tagesstart");
    erledigt.push("briefing");
  }

  // 2) Wochenbericht, Freitag ab 16 Uhr (sonst Samstagmorgen)
  if (((j.wochentag === 5 && j.stunde >= 16) || j.wochentag === 6) && !istRuhezeit() && await einmalDieseWoche("wochenbericht")) {
    const liste = await alleLaden();
    const woche = Date.now() - 7 * 86400000;
    const neu = liste.filter(a => wartetSeit(a) > woche && !["gespraech"].includes(a.status));
    const erl = liste.filter(a => a.erledigtTs && a.erledigtTs > woche);
    const ang = liste.filter(a => a.angebotTs && a.angebotTs > woche);
    const nachgehakt = await statLesen("nachgehakt"), zurueck = await statLesen("zurueckgeholt");
    const abbruchWeb = await statLesen("abbruchWeb");
    const k = await jsonLesen("lern:kennzahlen", null);
    const aktiv = await jsonLesen("lern:aktiv", []);
    const offenVorschlaege = await jsonLesen("lern:vorschlaege", []);
    const fehler = await fehlerSumme(7);
    const technik =
      (k ? "Letzte Auswertung der Gespräche (" + k.d + "): " + (k.gespraeche ?? "?") + " Gespräche, Abschlüsse " + (k.mit_abschluss ?? "?") +
           ", Abbrüche " + (k.abbrueche ?? "?") + ", Schleifen " + (k.schleifen ?? "?") + "\n" : "Noch keine Auswertung der Gespräche.\n") +
      "Gelernte Regeln aktiv: " + aktiv.length + (offenVorschlaege.length ? " · " + offenVorschlaege.length + " Vorschläge warten auf Freigabe (\"Lernen\")" : "") + "\n" +
      "Technische Aussetzer: " + fehler + (fehler ? " (Einzelheiten: \"Status\")" : "");
    const eigeneTechnik = !!(process.env.TECHNIK_NUMMERN || "").trim();
    const text = "Deine Woche\n────────\n" +
      "Neue Anfragen: " + neu.length + " (Website " + neu.filter(a => a.kanal === "web").length + ", WhatsApp " + neu.filter(a => a.kanal === "whatsapp").length + ")\n" +
      "Angebote verschickt: " + ang.length + " · Abgeschlossen: " + erl.length + "\n" +
      reaktionszeit(liste, woche) +
      (nachgehakt ? "Zurückgeholt: " + zurueck + " von " + nachgehakt + " Kunden, die verstummt waren\n" : "") +
      (abbruchWeb ? "Website-Besucher ohne Rückweg gegangen: " + abbruchWeb + "\n" : "") +
      "Noch offen: " + liste.filter(OFFEN).length +
      (eigeneTechnik ? "" : "\n\n" + technik) +
      "\n\nSchönes Wochenende!";
    await anInhaber(text, "Wochenbericht: " + neu.length + " neue Anfrage(n), " + erl.length + " abgeschlossen");
    if (eigeneTechnik) await zustellenAnInhaber("Technik-Wochenbericht\n────────\n" + technik, { kurz: "Technik-Wochenbericht", art: "technik" }).catch(() => {});
    erledigt.push("wochenbericht");
  }

  return erledigt;
}

// Wie schnell bekommen Kunden ein Angebot? Die wichtigste Zahl, damit
// keine Anfrage liegen bleibt.
function reaktionszeit(liste, seit) {
  const mit = liste.filter(a => a.angebotTs && a.angebotTs > seit);
  const std = mit.map(a => (a.angebotTs - wartetSeit(a)) / 3600000).sort((x, y) => x - y);
  const median = std.length ? std[Math.floor(std.length / 2)] : null;
  const liegen = liste.filter(a => a.status === "neu" && Date.now() - wartetSeit(a) > 86400000).length;
  return (median !== null ? "Zeit bis zum Angebot (Mittel): " + (median < 24 ? Math.round(median) + " Std." : Math.round(median / 24) + " Tage") + "\n" : "") +
    "Länger als 1 Tag ohne Angebot: " + liegen + (liegen ? " ⚠" : "") + "\n";
}

// ---- Kontext fuer Alex im Gespraech ------------------------------------
// Damit Alex im WhatsApp-Gespraech weiss, wo die Akte steht UND wie lange
// der Kunde schon wartet. Ohne die Wartezeit sagte Alex einer Kundin nach
// elf Tagen noch "Ihre Unterlagen sind bei Dirk, als Naechstes kommt der
// Kostenvoranschlag".
export async function akteKontext(kundeNr) {
  if (!kundeNr) return "";
  const a = (await alleLaden()).filter(x => x.kundeNr === String(kundeNr) && x.status !== "erledigt").pop();
  if (!a || a.status === "gespraech") return "";
  const bekannt = (a.schaden ? " Schadensart: " + a.schaden + "." : "") + (a.fahrzeug ? " Fahrzeug: " + a.fahrzeug + "." : "") +
    (a.fotos ? " Fotos bisher: " + a.fotos + "." : "");
  let t = "\n\nSTAND DIESES KUNDEN (Anfrage Nr. " + a.nr + ")." + bekannt + " Beziehe dich darauf, statt von vorn zu beginnen. Frag nicht erneut nach Dingen, die schon vorliegen.";
  if (a.status === "angebot") return t + " Das Angebot ist raus: " + (a.angebot || "") + ". Bei Fragen dazu hilfst du weiter oder bietest einen Termin an.";
  if (a.status === "termin") return t + " Ein Termin ist gebucht" + (a.termin ? " (" + a.termin + ")" : "") + ".";
  if (a.anruf) t += " Die Werkstatt hat zugesagt, den Kunden persönlich anzurufen.";

  const std = (Date.now() - (a.kvaTs || wartetSeit(a))) / 3600000;
  const tage = Math.floor(std / 24);
  if (!a.kvaTs) return t + " Die Anfrage ist noch nicht vollständig übergeben.";
  if (std < 30) return t + " Die Anfrage liegt seit " + (std < 1.5 ? "eben" : Math.round(std) + " Stunden") + " bei der Werkstatt, das Angebot ist in Arbeit.";
  // Die Zusage "in der Regel einen Tag spaeter" ist gerissen.
  return t + "\nACHTUNG, WICHTIG: Der Kunde wartet seit " + (tage >= 2 ? tage + " Tagen" : "über einem Tag") +
    " auf den Kostenvoranschlag und hat noch KEINE Antwort bekommen. Die Zusage \"in der Regel einen Tag später\" wurde nicht gehalten. " +
    "Sag deshalb NICHT, die Unterlagen lägen bei Dirk und der Kostenvoranschlag komme als Nächstes. Das hat er schon gehört. " +
    "Stattdessen: Entschuldige dich ehrlich und in einem Satz dafür, dass er so lange nichts gehört hat, ohne Ausreden und ohne Floskel. " +
    "Sag, dass du es jetzt als dringend direkt an den Chef gibst und dass sich die Werkstatt persönlich bei ihm meldet. Nenne keine Uhrzeit und keinen Tag. " +
    "Biete zusätzlich an, sofort einen Termin zur kostenlosen Begutachtung einzutragen, falls er nicht länger warten möchte. " +
    "Ist der Kunde verärgert, gib ihm recht, verteidige nichts. Setze am Ende [[DRINGEND|wartet seit " + (tage >= 2 ? tage + " Tagen" : "über einem Tag") + " auf Antwort]].";
}

// ---- Uebergabe Website -> WhatsApp ---------------------------------
// Nennt der Kunde im Web-Chat seine WhatsApp-Nummer, schreibt Alex ihn
// dort an, damit das Gespraech einen dauerhaften Kanal bekommt. Das ist
// eine unternehmensseitig begonnene Nachricht und geht bei Meta NUR mit
// genehmigter Vorlage (WA_VORLAGE_UEBERGABE). Ohne Vorlage: kein Versand,
// aber die Akte merkt sich die Nummer fuer Dirk.
export function nummerInternational(roh) {
  let n = String(roh || "").replace(/[^\d+]/g, "");
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("00")) n = n.slice(2);
  else if (n.startsWith("0")) n = "49" + n.slice(1);
  return /^\d{10,15}$/.test(n) ? n : "";
}

export async function uebergabeAnWhatsApp(akte) {
  if (!akte || akte.kanal !== "web" || akte.uebergeben) return { ok: false, grund: "" };
  const nr = nummerInternational(akte.tel);
  if (!nr) return { ok: false, grund: "keine gültige Nummer" };
  if (!process.env.WA_VORLAGE_UEBERGABE) return { ok: false, grund: "keine Vorlage hinterlegt" };
  const ok = await sendWAVorlage(nr, process.env.WA_VORLAGE_UEBERGABE,
    [akte.name || "Kundin/Kunde", (akte.schaden || akte.thema || "Ihre Anfrage").slice(0, 120)]);
  if (ok) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === akte.nr);
    if (a) { a.uebergeben = true; a.kundeNr = nr; a.verlauf.push(new Date().toLocaleDateString("de-DE") + " auf WhatsApp übergeben"); await jsonSchreiben("anfragen", liste); }
  }
  return { ok, grund: ok ? "" : "Vorlage abgelehnt" };
}


// ---- Echter Stand fuer Alex, wenn Dirk schreibt ---------------------
// Alex darf Dirk nur aus diesen Daten antworten.
export async function chefUeberblick() {
  const offen = await offeneAnfragen();
  const buch = (await jsonLesen("buchungen", [])).filter(b => b.status === "aktiv")
    .sort((a, b) => (a.datum + String(a.von).padStart(2, "0")).localeCompare(b.datum + String(b.von).padStart(2, "0")));
  const z = [];
  z.push("OFFENE ANFRAGEN (" + offen.length + "), Stand jetzt aus dem System:");
  if (!offen.length) z.push("keine");
  for (const a of offen) z.push("- Nr. " + a.nr + ": " + (a.name || "Name nicht genannt") + ", " + (erreichbar(a) || "keine Nummer") +
    ", " + ((a.lage && a.lage.kurz) || anliegenKurz(a)) + ", Fotos: " + (a.fotos || 0) + ((a.medien || []).length ? " (abrufbar)" : a.fotos ? " (nicht mehr abrufbar)" : "") +
    ", " + (STATUS_TEXT[a.status] || a.status) + ", " + alterText(wartetSeit(a)) + ", " + (a.kanal === "web" ? "Website" : "WhatsApp" + (fensterOffen(a) ? " (erreichbar bis " + fensterBis(a) + ")" : " (nur noch per Anruf erreichbar)")) +
    (a.dringend ? ", DRINGEND: " + a.dringend.grund : "") + (a.anruf ? ", Anruf zugesagt" : "") +
    (a.lage && a.lage.stimmung && a.lage.stimmung !== "ruhig" ? ", wirkt " + a.lage.stimmung : "") +
    (a.lage && a.lage.empfehlung ? ", Empfehlung: " + a.lage.empfehlung : ""));
  z.push("");
  z.push("GEBUCHTE TERMINE (" + buch.length + "):");
  if (!buch.length) z.push("keine");
  for (const b of buch.slice(0, 15)) z.push("- " + b.datum.split("-").reverse().join(".") + " " + b.von + "–" + b.bis + ": " +
    (b.name || "ohne Name") + " (" + b.art + ")" + (b.akteNr ? ", Anfrage Nr. " + b.akteNr : ""));
  return z.join("\n");
}

// Alles zu EINER Anfrage, samt Wortlaut: Wenn Dirk sich auf eine Karte
// bezieht oder eine Nummer nennt, antwortet Alex daraus.
export async function chefAkteKontext(nr) {
  const a = await akteFinden(nr);
  if (!a) return "";
  const zuege = await gespraechLaden(nr);
  return "\n\nDIRK MEINT ANFRAGE NR. " + a.nr + ". Alles, was dazu vorliegt:\n" + anfrageDetail(a).split("\n\nWeiter:")[0] +
    (zuege.length ? "\n\nGESPRÄCH IM WORTLAUT:\n" + gespraechText(zuege, 30) : "\n(Kein Wortlaut gespeichert.)");
}

// Nennt Dirk in seinem Text genau eine Anfragenummer ("was will Nr. 7")?
export function nummerImText(text) {
  const m = String(text || "").match(/(?:nr\.?|nummer|anfrage|kunde)\s*(\d{1,4})\b/gi) || [];
  const n = [...new Set(m.map(x => Number(x.match(/\d+/)[0])))];
  return n.length === 1 ? n[0] : 0;
}

// Entwurf einer Kundennachricht, die Dirk frei formuliert in Auftrag gibt
// ("schreib der Steffi, dass ..."). Sie geht erst nach seinem Ja raus.
export async function entwurfSenden(an, entwurf) {
  const a = await akteFinden(entwurf.nr);
  if (!a) return "Anfrage " + entwurf.nr + " gibt es nicht mehr.";
  const r = await anKunde(a, entwurf.text, "WA_VORLAGE_ANGEBOT");
  if (!r.ok) return "Konnte nicht schicken: " + r.grund + "." +
    (erreichbar(a) ? "\nBitte selbst an " + erreichbar(a) + ":\n\n" + entwurf.text : "");
  await verlaufAnhaengen(a.kundeNr, entwurf.text).catch(() => {});
  await gespraechAnhaengen(a.nr, "A", entwurf.text).catch(() => {});
  const mitPreis = /\d/.test(entwurf.text) && /(€|euro|eur\b)/i.test(entwurf.text);
  await akteAendern(a.nr, x => {
    if (mitPreis) { x.status = "angebot"; x.angebotTs = Date.now(); x.angebot = entwurf.text.slice(0, 200); }
    delete x.dringend; x.karteOffen = false;
    x.verlauf.push(heuteKurz() + (mitPreis ? " Angebot geschickt" : " Nachricht an Kunden"));
  });
  return "Geschickt an " + (a.name || "den Kunden") + "." + (mitPreis ? " Steht jetzt als Angebot in der Akte." : "");
}
