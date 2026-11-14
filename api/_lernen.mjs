// api/_lernen.mjs
// Lernrunde fuer Alex: Gespraeche werden anonymisiert 14 Tage aufbewahrt,
// nach je LERN_INTERVALL Gespraechen ausgewertet, und daraus entstehen
// Lernvorschlaege. NICHTS wird automatisch uebernommen: Jeder Vorschlag
// braucht eine Freigabe per WhatsApp ("Lernen 3 ok"). Freigegebene
// Regeln fliessen in den Prompt ein, getrennt von Dirks "Merk dir"-
// Hinweisen und unterhalb davon.
//
// Datenschutz: Vor dem Speichern werden Namen (aus Markern), Rufnummern,
// E-Mail-Adressen, FIN, Kennzeichen und IBAN-artige Ketten ersetzt.
// Fotos werden nie gespeichert. Aufbewahrung LERN_TAGE Tage.

import { jsonLesen, jsonSchreiben, redis, zustellenAnInhaber, meldenOderAufheben,
         istRuhezeit, fetchMitZeit, fehlerLog, statLesen } from "./_termin.mjs";

export const LERN_INTERVALL = 10;   // neue Gespraeche bis zur naechsten Runde
export const LERN_TAGE = 14;        // Aufbewahrung anonymisierter Gespraeche
export const MAX_GELERNT = 15;      // Obergrenze aktiver Regeln im Prompt
const LERN_WOCHE_MIN = 3;           // woechentliche Runde ab so vielen neuen Gespraechen
const MAX_GESPRAECHE = 60;          // Sicherheitsdeckel im Speicher

// Kennung eines WhatsApp-Kunden fuer die Lernrunde: ein Hash, nie die Nummer.
export function lernKennung(nummer) {
  let h = 0;
  for (const c of String(nummer)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return "wa" + h.toString(36);
}

// ---- Anonymisierung ---------------------------------------------
export function anonymisieren(text) {
  let s = String(text || "");
  // Marker: Name und Nummer raus, Struktur bleibt erkennbar
  s = s.replace(/\[\[KONTAKT\|[^|\]]*\|[^\]]*\]\]/g, "[[KONTAKT|[Name]|[Nummer]]]");
  // E-Mail
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[E-Mail]");
  // FIN: 17 Zeichen ohne I, O, Q
  s = s.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "[FIN]");
  // Deutsche Kennzeichen (B-AB 1234, HH AB 12, mit oder ohne Trennzeichen)
  s = s.replace(/\b[A-ZÄÖÜ]{1,3}[- ]?[A-Z]{1,2}[- ]?\d{1,4}[EH]?\b/g, "[Kennzeichen]");
  // Rufnummern: 8+ Ziffern mit optionalen Trennern, +49 / 0
  s = s.replace(/(\+49|0)[\d\s\/().-]{7,}\d/g, "[Nummer]");
  // Anrede mit Nachnamen
  s = s.replace(/\b(Herr|Frau)\s+[A-ZÄÖÜ][a-zäöüß-]+(\s+[A-ZÄÖÜ][a-zäöüß-]+)?/g, "$1 [Name]");
  return s;
}

// ---- Gespraech ablegen --------------------------------------------
// Wird nach jeder Antwort aufgerufen. `kennung` ist die Sitzung (Web:
// zufaellige Kennung des Widgets; WhatsApp: gehashte Nummer). Der
// komplette Verlauf ueberschreibt den vorherigen Stand derselben Sitzung.
export async function gespraechAblegen({ kennung, kanal, verlauf }) {
  if (!kennung || !Array.isArray(verlauf) || !verlauf.length) return false;
  const eintrag = {
    kanal, kennung,
    ts: Date.now(),
    zuege: verlauf.slice(-24).map(m => ({
      wer: m.role === "assistant" ? "Alex" : "Kunde",
      text: anonymisieren(typeof m.content === "string" ? m.content : "(Foto)").slice(0, 900)
    }))
  };
  const neu = !(await redis("GET", "lern:g:" + kennung));
  await redis("SET", "lern:g:" + kennung, JSON.stringify(eintrag), "EX", LERN_TAGE * 86400);
  // Index der Sitzungen pflegen (fuer die Auswertung)
  const idx = await jsonLesen("lern:index", []);
  if (!idx.includes(kennung)) {
    idx.push(kennung);
    await jsonSchreiben("lern:index", idx.slice(-MAX_GESPRAECHE));
  }
  if (neu) {
    // Zaehler nur bei neuer Sitzung erhoehen
    const z = Number(await redis("INCR", "lern:zaehler")) || 0;
    return z >= LERN_INTERVALL;   // true = Lernrunde faellig
  }
  return false;
}

async function gespraecheLaden() {
  const idx = await jsonLesen("lern:index", []);
  const liste = [];
  for (const k of idx) {
    const raw = await redis("GET", "lern:g:" + k);
    if (raw) { try { liste.push(JSON.parse(raw)); } catch (_) {} }
  }
  return liste;
}

// ---- Auswertung -------------------------------------------------
const RUBRIK = `Du wertest Gespraeche eines KI-Serviceberaters ("Alex") einer Autolackiererei aus, damit er besser wird. Die Gespraeche sind anonymisiert. Unter jedem Gespraech steht, was daraus geworden ist ("Ergebnis"). Zeilen mit "[Werkstatt persönlich]" hat der Chef selbst geschrieben.

Pruefe jedes Gespraech:
1. Verstanden? Ist Alex konkret auf Fahrzeug, Bauteil und Anliegen eingegangen, oder hat er allgemein geantwortet?
2. Ausstieg: Wenn der Kunde verstummt ist, nach welcher Nachricht von Alex? Was war daran die Huerde (zu lang, mehrere Bitten auf einmal, Unterlage verlangt, keine klare naechste Frage, zu frueh nach Daten gefragt)?
3. Abbruch nach Lieferung: Kunde liefert Daten, danach kommt kein Abschluss (was liegt vor, was passiert, wann Rueckmeldung, nichts weiter noetig).
4. Schleifen: dieselbe Frage zweimal, oder nach etwas gefragt, das schon im Gespraech stand.
5. Ungeduld oder Aerger: "Hallo?", "und jetzt?", Beschwerde. Wie hat Alex reagiert, hat es gepasst?
6. Nachhaken: Wenn Alex nach einer Pause nachgehakt hat, kam der Kunde zurueck? Wenn nicht: Was haette besser gepasst?
7. Werkstatt persoenlich: Was macht der Chef anders als Alex (Ton, Laenge, Inhalt)? Das ist das Vorbild.
8. Preisfrage nur abgewehrt, ohne Einordnung. Versicherung falsch erklaert. Anrede falsch.
9. Wissensluecken: Fragen, auf die Alex keine gute Antwort hatte.
10. Was gut lief und bleiben soll.

Antworte NUR mit JSON, ohne Text davor oder danach:
{
 "kennzahlen": {"gespraeche": 0, "mit_abschluss": 0, "abbrueche": 0, "schleifen": 0, "ungeduld": 0, "zurueckgeholt": 0},
 "gut": ["..."],
 "ausstieg": "Ein Satz: die haeufigste Stelle, an der Kunden aussteigen, oder leer.",
 "vorschlaege": [
   {"regel": "Eine konkrete, kurze Anweisung an Alex (max 200 Zeichen), die direkt in seinen Prompt passt.",
    "grund": "Was in welchem Gespraech schiefging (1 Satz, ohne Kundendaten).",
    "beispiel": "Ein Satz, wie Alex es kuenftig sagen wuerde (max 160 Zeichen), oder leer.",
    "art": "stil" oder "fachlich"}
 ]
}
Regeln: Hoechstens 3 Vorschlaege, die wichtigsten zuerst, nur bei einem echten Muster (nicht aus einem Einzelfall, ausser er hat einen Kunden gekostet). Keine Preise, keine Versicherungsberatung, keine Zusagen erfinden. Bei "fachlich" nur, was eine Werkstatt bestaetigen kann. Schlage NICHTS vor, was unter BEREITS GEREGELT steht, auch nicht umformuliert.`;

// Was ist aus dem Gespraech geworden? Aus der Anfrage-Akte, ohne Namen.
function ergebnisText(a) {
  if (!a) return "keine Anfrage entstanden (nur Unterhaltung oder Besucher ging ohne Angaben)";
  const tage = Math.floor((Date.now() - (a.leadTs || a.ts)) / 86400000);
  const t = [];
  if (a.status === "gespraech") t.push("nur Unterhaltung, keine Anfrage");
  else if (a.status === "verloren") t.push("Besucher ging ohne Rückweg");
  else if (a.status === "termin") t.push("Termin gebucht");
  else if (a.status === "angebot") t.push("Angebot verschickt" + (a.angebotTs ? " nach " + Math.max(1, Math.round((a.angebotTs - (a.leadTs || a.ts)) / 3600000)) + " Std." : ""));
  else if (a.status === "erledigt") t.push("abgeschlossen");
  else t.push((a.kvaTs ? "an die Werkstatt übergeben" : "Angaben unvollständig") + ", noch kein Angebot, seit " + tage + " Tag(en)");
  if (a.nachhakTs) t.push("Alex hat nachgehakt, Kunde kam " + (a.zurueckgeholt ? "zurück" : "nicht zurück"));
  if (a.dringend) t.push("Kunde verärgert oder wartet zu lange");
  if (a.anruf) t.push("Chef ruft persönlich an");
  return t.join("; ");
}

function jsonAus(roh) {
  const s = String(roh || "");
  const a = s.indexOf("{"), e = s.lastIndexOf("}");
  if (a < 0 || e <= a) return null;
  try { return JSON.parse(s.slice(a, e + 1)); } catch (_) { return null; }
}

export async function lernrunde() {
  const gespraeche = await gespraecheLaden();
  if (gespraeche.length < 3) return null;
  const seit = Number(await redis("GET", "lern:letzte")) || 0;
  const frisch = gespraeche.filter(g => g.ts > seit);
  if (frisch.length < 3) return null;

  // Ergebnis je Gespraech aus den Akten (Zuordnung ueber die Kennung)
  const akten = await jsonLesen("anfragen", []);
  const akteZu = g => akten.filter(a => g.kennung && (g.kanal === "whatsapp"
    ? a.kundeNr && lernKennung(a.kundeNr) === g.kennung
    : a.sitzung === g.kennung)).pop() || null;

  const aktiv = await jsonLesen("lern:aktiv", []);
  const offen = await jsonLesen("lern:vorschlaege", []);
  const abgelehnt = await jsonLesen("lern:abgelehnt", []);
  const geregelt = [...aktiv.map(a => a.regel), ...offen.map(v => v.regel), ...abgelehnt.map(v => v.regel + " (abgelehnt)")];

  const text = (geregelt.length ? "BEREITS GEREGELT:\n" + geregelt.map(r => "- " + r).join("\n") + "\n\n" : "") +
    frisch.map((g, i) =>
      "### Gespraech " + (i + 1) + " (" + g.kanal + ")\n" +
      g.zuege.map(z => z.wer + ": " + z.text).join("\n") +
      "\nErgebnis: " + ergebnisText(akteZu(g))).join("\n\n");

  let ergebnis = null, grund = "";
  try {
    const r = await fetchMitZeit("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL_DENKEN || process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 1800,
        system: RUBRIK,
        messages: [{ role: "user", content: text.slice(0, 60000) }]
      })
    }, 45000);
    if (!r.ok) grund = "KI antwortet mit Fehler " + r.status;
    else {
      const j = await r.json();
      ergebnis = jsonAus((j.content || []).filter(c => c.type === "text").map(c => c.text).join(""));
      if (!ergebnis) grund = "Antwort der KI war nicht lesbar";
    }
  } catch (e) {
    grund = "Zeitlimit oder Netzfehler (" + (e && e.name) + ")";
  }
  if (!ergebnis || !Array.isArray(ergebnis.vorschlaege)) {
    // Frueher scheiterte die Runde still und wurde bei jedem Gespraech neu
    // versucht. Jetzt steht der Grund unter "Status".
    await fehlerLog("lernen", "Lernrunde nicht gelaufen: " + (grund || "keine Vorschlagsliste"));
    return null;
  }

  // Vorschlaege durchnummerieren und ablegen (offen, bis Freigabe)
  let nr = Math.max(0, ...offen.map(v => v.nr), Number(await redis("GET", "lern:nr")) || 0);
  const neue = ergebnis.vorschlaege.slice(0, 3).map(v => ({
    nr: ++nr,
    regel: String(v.regel || "").slice(0, 220),
    grund: String(v.grund || "").slice(0, 200),
    beispiel: String(v.beispiel || "").slice(0, 180),
    art: v.art === "fachlich" ? "fachlich" : "stil",
    d: new Date().toISOString().slice(0, 10),
    gefragt: true
  })).filter(v => v.regel);
  await redis("SET", "lern:nr", String(nr));
  await jsonSchreiben("lern:vorschlaege", [...offen, ...neue].slice(-30));
  await redis("SET", "lern:letzte", String(Date.now()));
  await redis("SET", "lern:zaehler", "0");
  const k = { ...(ergebnis.kennzahlen || {}), d: new Date().toISOString().slice(0, 10) };
  await jsonSchreiben("lern:kennzahlen", k);
  // Verlauf der Kennzahlen: so sieht man, ob es besser wird
  const hist = await jsonLesen("lern:verlauf", []);
  hist.push(k);
  await jsonSchreiben("lern:verlauf", hist.slice(-12));

  // Bericht an die Technik (Julian). Ohne TECHNIK_NUMMERN an Dirk.
  const vor = hist.length > 1 ? hist[hist.length - 2] : null;
  const quote = x => x && x.gespraeche ? Math.round(100 * (x.mit_abschluss || 0) / x.gespraeche) + " %" : "?";
  const bericht =
    "Lernrunde: " + frisch.length + " Gespräche ausgewertet\n" +
    "Mit Abschluss: " + quote(k) + (vor ? " (davor " + quote(vor) + ")" : "") +
    " · abgesprungen: " + (k.abbrueche ?? "?") + " · zurückgeholt: " + (k.zurueckgeholt ?? "?") + "\n" +
    (ergebnis.ausstieg ? "Häufigster Ausstieg: " + String(ergebnis.ausstieg).slice(0, 200) + "\n" : "") +
    (Array.isArray(ergebnis.gut) && ergebnis.gut.length ? "Läuft gut: " + ergebnis.gut.slice(0, 2).join("; ").slice(0, 240) + "\n" : "") +
    (neue.length ? neue.length + " Vorschlag/Vorschläge folgen. Nichts gilt ohne Freigabe." : "Keine neuen Vorschläge.");
  await meldenOderAufheben(bericht, { kurz: "Auswertung der letzten Gespräche liegt vor", art: "technik" });
  for (const v of neue) await vorschlagFragen(v);
  return { frisch: frisch.length, neue: neue.length };
}

// Ein Vorschlag als eigene Nachricht mit zwei Knoepfen. Ein Tipp genuegt.
async function vorschlagFragen(v) {
  const text = "💡 Lernvorschlag " + v.nr + " (" + (v.art === "fachlich" ? "fachlich" : "Stil") + ")\n" +
    v.regel + "\nWarum: " + v.grund + (v.beispiel ? "\nKlingt dann so: „" + v.beispiel + "“" : "");
  return meldenOderAufheben(text, {
    kurz: "Lernvorschlag " + v.nr, art: "technik",
    knoepfe: [{ id: "l:ok:" + v.nr, titel: "Übernehmen" }, { id: "l:nein:" + v.nr, titel: "Ablehnen" }]
  });
}

// Vom Wecker: Lernrunde, wenn genug Neues da ist. Sie laeuft nicht mehr
// mitten im Kundengespraech (dort scheiterte sie am Zeitlimit und lief
// deshalb seit Ende September nicht mehr).
export async function lernPflege() {
  if (istRuhezeit()) return null;
  // Aeltere Vorschlaege, die noch nie mit Knoepfen gefragt wurden: einmal nachholen
  const offen = await jsonLesen("lern:vorschlaege", []);
  // (Nur wenn Lernmeldungen an eine eigene Nummer gehen. Dirk soll nicht
  // auf einen Schlag fuenf alte Vorschlaege bekommen.)
  const ungefragt = (process.env.TECHNIK_NUMMERN || "").trim() ? offen.filter(v => !v.gefragt) : [];
  if (ungefragt.length) {
    for (const v of ungefragt) v.gefragt = true;
    await jsonSchreiben("lern:vorschlaege", offen);
    for (const v of ungefragt.slice(-5)) await vorschlagFragen(v);
    return { nachgefragt: ungefragt.length };
  }
  const z = Number(await redis("GET", "lern:zaehler")) || 0;
  const letzte = Number(await redis("GET", "lern:letzte")) || 0;
  const faellig = z >= LERN_INTERVALL || (z >= LERN_WOCHE_MIN && Date.now() - letzte > 7 * 86400000);
  if (!faellig) return null;
  // Hoechstens ein Versuch am Tag
  const tag = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  if ((await redis("SET", "einmal:lernrunde:" + tag, "1", "NX", "EX", 2 * 86400)) !== "OK") return null;
  return lernrunde();
}

// ---- Freigabe-Befehle (aus whatsapp.js aufgerufen) -----------------
// Gibt einen Antworttext zurueck oder null, wenn der Text kein Lernbefehl war.
export async function lernBefehl(t) {
  const s = String(t || "").trim();

  if (/^lernen$/i.test(s)) {
    const offen = await jsonLesen("lern:vorschlaege", []);
    const z = Number(await redis("GET", "lern:zaehler")) || 0;
    return (offen.length
      ? "Offene Lernvorschläge:\n" + offen.map(v => v.nr + ". [" + v.art + "] " + v.regel).join("\n")
      : "Keine offenen Vorschläge.") +
      "\n\nNächste Lernrunde nach " + Math.max(0, LERN_INTERVALL - z) + " weiteren Gesprächen." +
      "\nFreigeben: \"Lernen 3 ok\" · Verwerfen: \"Lernen 3 nein\" · Aktive: \"Gelernt\"";
  }

  let m = s.match(/^lernen\s+(\d+)\s+(ok|ja|passt|nein|nicht|weg)$/i);
  if (m) {
    const nr = Number(m[1]);
    const ja = /^(ok|ja|passt)$/i.test(m[2]);
    const offen = await jsonLesen("lern:vorschlaege", []);
    const i = offen.findIndex(v => v.nr === nr);
    if (i < 0) return "Vorschlag " + nr + " kenne ich nicht. \"Lernen\" zeigt die offenen.";
    const v = offen.splice(i, 1)[0];
    await jsonSchreiben("lern:vorschlaege", offen);
    if (!ja) {
      // Abgelehntes merken, damit es nicht wieder vorgeschlagen wird
      const weg = await jsonLesen("lern:abgelehnt", []);
      weg.push({ regel: v.regel, d: new Date().toISOString().slice(0, 10) });
      await jsonSchreiben("lern:abgelehnt", weg.slice(-30));
      return "Verworfen: " + v.regel;
    }
    const aktiv = await jsonLesen("lern:aktiv", []);
    if (aktiv.length >= MAX_GELERNT) {
      return "Es sind schon " + MAX_GELERNT + " Regeln aktiv. Erst eine entfernen (\"Vergiss gelernt N\") oder Julian bitten, sie in die Wissensbasis zu übernehmen.";
    }
    aktiv.push({ regel: v.regel, art: v.art, d: new Date().toISOString().slice(0, 10) });
    await jsonSchreiben("lern:aktiv", aktiv);
    return "Freigegeben, gilt ab sofort (Nr. " + aktiv.length + "): " + v.regel;
  }

  if (/^gelernt$/i.test(s)) {
    const aktiv = await jsonLesen("lern:aktiv", []);
    return aktiv.length
      ? "Aktive gelernte Regeln:\n" + aktiv.map((a, i) => (i + 1) + ". " + a.regel + " (" + a.d + ")").join("\n") +
        "\n\nEntfernen: \"Vergiss gelernt 2\""
      : "Noch keine gelernten Regeln aktiv.";
  }

  m = s.match(/^vergiss gelernt\s+(\d+)$/i);
  if (m) {
    const aktiv = await jsonLesen("lern:aktiv", []);
    const i = Number(m[1]) - 1;
    if (!aktiv[i]) return "Regel " + m[1] + " gibt es nicht.";
    const weg = aktiv.splice(i, 1)[0];
    await jsonSchreiben("lern:aktiv", aktiv);
    return "Entfernt: " + weg.regel;
  }

  if (/^lernexport$/i.test(s)) {
    const aktiv = await jsonLesen("lern:aktiv", []);
    const k = await jsonLesen("lern:kennzahlen", null);
    return "Lernexport für die Wissensbasis\n────────\n" +
      (aktiv.length ? aktiv.map(a => "- " + a.regel + "  [" + a.art + ", " + a.d + "]").join("\n") : "(keine aktiven Regeln)") +
      (k ? "\n\nLetzte Kennzahlen (" + k.d + "): " + JSON.stringify(k) : "");
  }

  if (/^(lernrunde|lernen jetzt)$/i.test(s)) {
    const r = await lernrunde();
    return r ? "Lernrunde gelaufen: " + r.frisch + " Gespräche, " + r.neue + " Vorschläge. Bericht kommt gleich."
             : "Keine Lernrunde: zu wenig neue Gespräche seit der letzten (mindestens 3), oder die Auswertung ist gescheitert. \"Status\" zeigt den Grund.";
  }

  return null;
}

// ---- Prompt-Block der freigegebenen Regeln --------------------------
export async function gelerntBlock() {
  try {
    const aktiv = await jsonLesen("lern:aktiv", []);
    if (!aktiv.length) return "";
    return "\n\nAus früheren Gesprächen gelernt und vom Inhaber freigegeben " +
      "(gelten zusätzlich; bei Widerspruch haben die Hinweise des Inhabers Vorrang):\n" +
      aktiv.slice(0, MAX_GELERNT).map(a => "- " + a.regel).join("\n");
  } catch { return ""; }
}
