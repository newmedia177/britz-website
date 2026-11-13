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

import { jsonLesen, jsonSchreiben, redis, inhaberNummern, sendWA, zustellenAnInhaber,
         istRuhezeit, fetchMitZeit, RE_KONTAKT } from "./_termin.mjs";

export const LERN_INTERVALL = 10;   // Gespraeche bis zur naechsten Runde
export const LERN_TAGE = 14;        // Aufbewahrung anonymisierter Gespraeche
export const MAX_GELERNT = 15;      // Obergrenze aktiver Regeln im Prompt
const MAX_GESPRAECHE = 60;          // Sicherheitsdeckel im Speicher

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
    kanal,
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
const RUBRIK = `Du bewertest Gespraeche eines KI-Serviceberaters ("Alex") einer Autolackiererei. Die Gespraeche sind anonymisiert. Pruefe jedes Gespraech auf diese Punkte:
1. Abbruch: Kunde liefert Daten, danach kommt kein Abschluss (was liegt vor, was passiert, wann Rueckmeldung, nichts weiter noetig).
2. Schleifen: dieselbe Frage zweimal gestellt, oder Zeitraeume statt konkreter Uhrzeiten.
3. Ungeduld: Kunde schreibt "Hallo?", "und jetzt?", "???".
4. Anrede: "Herr/Frau" mit Vornamen, Duzen des Kunden.
5. Preisfrage nur abgewehrt, ohne Einordnung (Smart Repair vs. Bauteil, Selbstzahler vs. Versicherung).
6. Versicherung falsch erklaert (Haftpflicht zahlt eigenen Schaden o.ae.).
7. Zu viele Huerden vor einer Gegenleistung (drei und mehr Nachforderungen).
8. Fragen, auf die Alex keine gute Antwort hatte (Wissensluecken), besonders wenn sie mehrfach vorkommen.
9. Alles, was gut lief und beibehalten werden sollte (kurz).

Antworte NUR mit JSON, ohne Erklaerung davor oder danach:
{
 "kennzahlen": {"gespraeche": 0, "mit_abschluss": 0, "abbrueche": 0, "schleifen": 0, "ungeduld": 0, "fragen_pro_lead": 0.0},
 "gut": ["..."],
 "vorschlaege": [
   {"regel": "Eine konkrete, kurze Anweisung an Alex (max 200 Zeichen), so formuliert, dass sie direkt in einen Prompt passt.",
    "grund": "Was in welchem Gespraech schiefging (1 Satz)",
    "art": "stil" oder "fachlich"}
 ]
}
Regeln: Maximal 5 Vorschlaege, nur wenn ein echtes Muster erkennbar ist (nicht aus einem Einzelfall). Keine Preise, keine Versicherungsberatung, keine Zusagen erfinden. Bei "fachlich" nur Vorschlaege, die eine Werkstatt bestaetigen kann. Nichts vorschlagen, was schon offensichtlich Regel ist und nur einmal verletzt wurde.`;

export async function lernrunde() {
  const gespraeche = await gespraecheLaden();
  if (gespraeche.length < 3) return null;
  const seit = Number(await redis("GET", "lern:letzte")) || 0;
  const frisch = gespraeche.filter(g => g.ts > seit);
  if (frisch.length < 3) return null;

  const text = frisch.map((g, i) =>
    "### Gespraech " + (i + 1) + " (" + g.kanal + ")\n" +
    g.zuege.map(z => z.wer + ": " + z.text).join("\n")).join("\n\n");

  let ergebnis = null;
  try {
    const r = await fetchMitZeit("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 1500,
        system: RUBRIK,
        messages: [{ role: "user", content: text.slice(0, 60000) }]
      })
    }, 45000);
    if (!r.ok) { console.error("lernrunde", r.status); return null; }
    const j = await r.json();
    const roh = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    ergebnis = JSON.parse(roh.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("lernrunde", e && e.message);
    return null;
  }
  if (!ergebnis || !Array.isArray(ergebnis.vorschlaege)) return null;

  // Vorschlaege durchnummerieren und ablegen (offen, bis Freigabe)
  const offen = await jsonLesen("lern:vorschlaege", []);
  let nr = offen.length ? Math.max(...offen.map(v => v.nr)) : 0;
  const neue = ergebnis.vorschlaege.slice(0, 5).map(v => ({
    nr: ++nr,
    regel: String(v.regel || "").slice(0, 220),
    grund: String(v.grund || "").slice(0, 200),
    art: v.art === "fachlich" ? "fachlich" : "stil",
    d: new Date().toISOString().slice(0, 10)
  })).filter(v => v.regel);
  await jsonSchreiben("lern:vorschlaege", [...offen, ...neue].slice(-30));
  await redis("SET", "lern:letzte", String(Date.now()));
  await redis("SET", "lern:zaehler", "0");
  await jsonSchreiben("lern:kennzahlen", {
    ...(ergebnis.kennzahlen || {}), d: new Date().toISOString().slice(0, 10)
  });

  // Bericht an Dirk + Julian (nachts ueber die Warteschlange)
  const k = ergebnis.kennzahlen || {};
  const bericht =
    "Lernrunde: " + frisch.length + " Gespräche ausgewertet\n" +
    "────────\n" +
    "Mit Abschluss: " + (k.mit_abschluss ?? "?") + " · Abbrüche: " + (k.abbrueche ?? "?") +
    " · Schleifen: " + (k.schleifen ?? "?") + " · Ungeduld: " + (k.ungeduld ?? "?") + "\n" +
    (Array.isArray(ergebnis.gut) && ergebnis.gut.length
      ? "Gut gelaufen: " + ergebnis.gut.slice(0, 3).join("; ") + "\n" : "") +
    (neue.length
      ? "\nVorschläge (nichts ist aktiv, bis du freigibst):\n" +
        neue.map(v => v.nr + ". [" + v.art + "] " + v.regel + "\n    Grund: " + v.grund).join("\n") +
        "\n\nFreigeben: \"Lernen " + neue[0].nr + " ok\" · Verwerfen: \"Lernen " + neue[0].nr + " nein\""
      : "\nKeine neuen Vorschläge, läuft rund.");
  await anInhaber(bericht);
  return { frisch: frisch.length, neue: neue.length };
}

async function anInhaber(text) {
  if (istRuhezeit()) {
    const liste = await jsonLesen("wartend", []);
    liste.push({ text, bilder: [], ts: Date.now() });
    await jsonSchreiben("wartend", liste.slice(-30));
    return;
  }
  await zustellenAnInhaber(text, { kurz: "Auswertung der letzten Gespräche liegt vor" });
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
    if (!ja) return "Verworfen: " + v.regel;
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
             : "Zu wenig neue Gespräche seit der letzten Runde (mindestens 3).";
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
