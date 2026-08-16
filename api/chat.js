// api/chat.js – Alex, der KI-Assistent der Autolackiererei in Britz
// Vercel Serverless Function (Node 18+). Streamt die Antwort als SSE
// im Format `data: <JSON-String>` – exakt das Protokoll des Widgets.
//
// Benötigte Umgebungsvariable (Vercel → Settings → Environment
// Variables):  ANTHROPIC_API_KEY
// Optional:    CLAUDE_MODEL (Standard: claude-sonnet-5)

import { SYSTEM, KNOWLEDGE } from "./_bundle.mjs";
import { meldeTermin, jsonLesen, jsonSchreiben, speicherUrl } from "./_termin.mjs";

export const config = { maxDuration: 60 };

const MAX_TURNS = 20;        // Verlaufslänge begrenzen
const MAX_CHARS = 4000;      // pro Nachricht
const MAX_IMAGES = 3;

export default async function handler(req, res) {
  // CORS: Anfragen von jeder Webseite erlauben (Widget läuft auf Kundendomain)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    sseError(res, "Konfigurationsfehler: API-Key fehlt.");
    return;
  }

  // ---- Eingabe validieren -------------------------------------
  const body = req.body || {};
  const raw = Array.isArray(body.messages) ? body.messages : [];
  const images = (Array.isArray(body.images) ? body.images : [])
    .slice(0, MAX_IMAGES)
    .filter(s => typeof s === "string" && s.length < 2_500_000);

  const messages = raw.slice(-MAX_TURNS).map(m => ({
    role: m && m.role === "assistant" ? "assistant" : "user",
    content: String((m && m.content) || "").slice(0, MAX_CHARS)
  })).filter(m => m.content);

  if (!messages.length && !images.length) {
    res.status(400).json({ error: "empty" });
    return;
  }
  if (!messages.length) messages.push({ role: "user", content: "(Foto vom Schaden)" });

  // Bilder an die letzte User-Nachricht hängen (Vision)
  if (images.length) {
    const last = messages[messages.length - 1];
    last.content = [
      ...images.map(b64 => ({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: b64 }
      })),
      { type: "text", text: typeof last.content === "string" ? last.content : "(Foto vom Schaden)" }
    ];
  }

  // ---- Anthropic API (Streaming) ------------------------------
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive"
  });

  const notesBlock = await ownerNotesBlock();

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
        max_tokens: 700,
        // System-Prompt + komplette Wissensbasis, mit Prompt-Caching:
        // der große Block wird gecacht und kostet ab der 2. Anfrage
        // nur noch einen Bruchteil.
        system: [{
          type: "text",
          text: SYSTEM + "\n\n<wissensbasis>\n" + KNOWLEDGE + "\n</wissensbasis>",
          cache_control: { type: "ephemeral" }
        }, {
          type: "text",
          text: zeitKontext() + notesBlock
        }],
        messages,
        stream: true
      })
    });
  } catch (e) {
    sseWrite(res, "Entschuldigung, ich bin gerade nicht erreichbar. " +
      "Rufen Sie uns gern direkt an: 030 607 97 930 (Mo–Do 8–17, Fr 8–15 Uhr).");
    res.write("data: [DONE]\n\n"); res.end(); return;
  }

  if (!upstream.ok) {
    console.error("Anthropic API", upstream.status, await upstream.text().catch(() => ""));
    sseWrite(res, "Entschuldigung, ich bin gerade nicht erreichbar. " +
      "Rufen Sie uns gern direkt an: 030 607 97 930 (Mo–Do 8–17, Fr 8–15 Uhr).");
    res.write("data: [DONE]\n\n"); res.end(); return;
  }

  // Anthropic-SSE parsen und nur die Text-Deltas ans Widget reichen
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = "", answer = "", zurueck = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        try {
          const ev = JSON.parse(payload);
          if (ev.type === "content_block_delta" &&
              ev.delta && ev.delta.type === "text_delta" && ev.delta.text) {
            const teil = streamTeilen(zurueck + ev.delta.text);
            zurueck = teil.zurueck;
            if (teil.fertig) {
              const sauber = saeubern(teil.fertig, answer.length === 0);
              answer += sauber;
              sseWrite(res, sauber);
            }
          }
        } catch (_) { /* halbe Events ignorieren */ }
      }
    }
  } catch (e) {
    console.error("stream error", e);
  }
  // Zurückgehaltenen Rest noch ausgeben
  if (zurueck) {
    const sauber = saeubern(zurueck, answer.length === 0).replace(/\s+$/, "");
    if (sauber) { answer += sauber; sseWrite(res, sauber); }
  }
  res.write("data: [DONE]\n\n");
  res.end();

  // Wissenslücke still protokollieren (blockiert die Antwort nicht)
  const lastUser = [...messages].reverse().find(m => m.role === "user");
  const frage = typeof (lastUser && lastUser.content) === "string"
    ? lastUser.content : "";
  await logGapIfNeeded(frage, answer);

  // Terminanfrage an den Inhaber melden
  await meldeTermin({ antwort: answer, kanal: "web", thema: frage });
}

// ---- Selbstlernende Schleife: erkennt, was der Assistent NICHT wusste --
// Erkennt Ausweich-Antworten und legt die Kundenfrage in Upstash ab.
// Der Inhaber sieht sie per WhatsApp mit "Zeig Lücken".
const GAP_MARKERS = [
  "muss ich passen", "kann ich nicht sagen", "weiß ich nicht",
  "klärt das team", "klärt am besten das team", "dazu kann ich nichts",
  "da bin ich überfragt", "kann ich leider nicht"
];

export async function logGapIfNeeded(question, answer) {
  try {
    if (!question || !answer || !speicherUrl()) return;
    const a = answer.toLowerCase();
    if (!GAP_MARKERS.some(m => a.includes(m))) return;
    const gaps = await jsonLesen("gaps", []);
    const q = question.slice(0, 300);
    const hit = gaps.find(g => g.q.toLowerCase() === q.toLowerCase());
    if (hit) { hit.n = (hit.n || 1) + 1; hit.last = new Date().toISOString().slice(0, 10); }
    else gaps.push({ q, n: 1, last: new Date().toISOString().slice(0, 10) });
    gaps.sort((x, y) => y.n - x.n);
    await jsonSchreiben("gaps", gaps.slice(0, 100));
  } catch (_) { /* Logging darf nie den Chat stören */ }
}

function sseWrite(res, text) {
  // JSON-String macht das Protokoll newline-sicher
  res.write("data: " + JSON.stringify(text) + "\n\n");
}

// ---- Stilfilter: entfernt typische KI-Zeichen ---------------------
// Gedankenstriche als Satzverbinder und Ausrufezeichen wirken maschinell.
// Der System-Prompt verbietet sie bereits; hier wird es zusätzlich
// erzwungen, damit nichts durchrutscht.
// Bindestriche ohne Leerzeichen (Mo–Do, 8–17 Uhr, Berlin-Britz)
// bleiben unangetastet.
export function saeubern(text, amAnfang) {
  let s = String(text || "");

  // "Wort – Wort"  ->  "Wort, Wort"   (nur mit Leerzeichen daneben)
  s = s.replace(/[ \t]*[\u2013\u2014][ \t]*/g, (treffer) =>
    /[ \t]/.test(treffer) ? ", " : treffer);

  // Ausrufezeichen -> Punkt
  s = s.replace(/!+/g, ".");

  // Aufräumen, falls durch die Ersetzung Doppeltes entsteht
  s = s.replace(/,\s*,/g, ",")
       .replace(/[ \t]+,/g, ",")
       .replace(/,\s*([.?])/g, "$1")
       .replace(/([.?])\s*,\s*/g, "$1 ");

  // Am Satzanfang kein führendes Komma
  if (amAnfang) s = s.replace(/^\s*,\s*/, "");

  return s;
}

// Teilt einen Stream-Abschnitt so, dass Ersetzungen nie an einer
// Chunk-Grenze zerrissen werden: alles, was auf Leerzeichen oder einen
// Gedankenstrich endet, wird bis zum nächsten Abschnitt zurückgehalten.
function streamTeilen(rohtext) {
  const rest = (rohtext.match(/[\s\u2013\u2014]+$/) || [""])[0];
  return {
    fertig: rest ? rohtext.slice(0, rohtext.length - rest.length) : rohtext,
    zurueck: rest
  };
}
function sseError(res, msg) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  sseWrite(res, msg);
  res.write("data: [DONE]\n\n");
  res.end();
}

// ---- Vom Inhaber per WhatsApp gemerkte Hinweise (Lern-Modus) ------
async function ownerNotesBlock() {
  try {
    const notes = await jsonLesen("notes", []);
    if (!notes.length) return "";
    return "\n\nAktuelle Hinweise vom Inhaber (verbindlich; überschreiben " +
      "bei Widerspruch die Wissensbasis):\n" +
      notes.map(n => "- " + n.t).join("\n");
  } catch { return ""; }
}

// ---- Datum, Uhrzeit, Öffnung und buchbare Termine ----------------
// Öffnungszeiten: Mo-Do 8-17, Fr 8-15, Sa/So geschlossen.
// Terminregeln: Montagvormittag frei halten, nicht direkt zur Öffnung,
// und mit Puffer vor Schließung (letzter Termin 90 Min vor Feierabend).
const OEFFNUNG = { 1: [8, 17], 2: [8, 17], 3: [8, 17], 4: [8, 17], 5: [8, 15] };
const TERMIN_FRUEHESTENS = 9;      // nicht direkt zur Öffnung
const TERMIN_PUFFER_MIN = 90;      // Abstand zum Feierabend
const MONTAG_AB = 12;              // Montagvormittag keine Termine

function berlinTeile(d) {
  const f = new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
    weekday: "long", hour12: false
  }).formatToParts(d);
  const g = t => (f.find(x => x.type === t) || {}).value;
  const wdMap = { Sonntag: 0, Montag: 1, Dienstag: 2, Mittwoch: 3,
                  Donnerstag: 4, Freitag: 5, Samstag: 6 };
  return {
    jahr: +g("year"), monat: +g("month"), tag: +g("day"),
    stunde: +g("hour"), minute: +g("minute"),
    wochentagName: g("weekday"), wochentag: wdMap[g("weekday")]
  };
}

// Gesetzliche Feiertage in Berlin (inkl. beweglicher Ostertermine)
function feiertageBerlin(jahr) {
  const p = (m, t) => `${jahr}-${String(m).padStart(2, "0")}-${String(t).padStart(2, "0")}`;
  // Ostersonntag nach Gauß
  const a = jahr % 19, b = Math.floor(jahr / 100), c = jahr % 100;
  const dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), hh = (19 * a + b - dd - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - hh - k) % 7;
  const m = Math.floor((a + 11 * hh + 22 * l) / 451);
  const monat = Math.floor((hh + l - 7 * m + 114) / 31);
  const tag = ((hh + l - 7 * m + 114) % 31) + 1;
  const ostern = new Date(Date.UTC(jahr, monat - 1, tag));
  const rel = n => {
    const x = new Date(ostern.getTime() + n * 86400000);
    return p(x.getUTCMonth() + 1, x.getUTCDate());
  };
  const feste = {
    [p(1, 1)]: "Neujahr", [p(3, 8)]: "Internationaler Frauentag",
    [p(5, 1)]: "Tag der Arbeit", [p(10, 3)]: "Tag der Deutschen Einheit",
    [p(12, 25)]: "1. Weihnachtstag", [p(12, 26)]: "2. Weihnachtstag"
  };
  feste[rel(-2)] = "Karfreitag";
  feste[rel(1)] = "Ostermontag";
  feste[rel(39)] = "Christi Himmelfahrt";
  feste[rel(50)] = "Pfingstmontag";
  return feste;
}

function iso(t) {
  return `${t.jahr}-${String(t.monat).padStart(2, "0")}-${String(t.tag).padStart(2, "0")}`;
}

function istFeiertag(t) {
  return feiertageBerlin(t.jahr)[iso(t)] || null;
}

function terminFenster(t) {
  if (t.wochentag === 0 || t.wochentag === 6) return null;
  if (istFeiertag(t)) return null;
  const oh = OEFFNUNG[t.wochentag];
  if (!oh) return null;
  let von = TERMIN_FRUEHESTENS;
  if (t.wochentag === 1) von = MONTAG_AB;          // Montag erst ab mittags
  const bisMin = oh[1] * 60 - TERMIN_PUFFER_MIN;   // Puffer vor Feierabend
  const bis = Math.floor(bisMin / 60) + (bisMin % 60 >= 30 ? 0.5 : 0);
  if (von >= bis) return null;
  const fmt = x => (Number.isInteger(x) ? `${x}:00` : `${Math.floor(x)}:30`);
  return `${fmt(von)}–${fmt(bis)} Uhr`;
}

// Kleine Helfer für die Lagebeschreibung
function feiertagVor(t) { return istFeiertag(t); }

// Nächster Tag, an dem tatsächlich geöffnet ist — berücksichtigt Wochenende
// und Feiertage. Rät nicht "morgen", sondern rechnet nach.
function naechsteOeffnung(jetzt, abMorgen) {
  for (let i = abMorgen ? 1 : 0; i < 14; i++) {
    const tt = berlinTeile(new Date(jetzt.getTime() + i * 86400000));
    if (!OEFFNUNG[tt.wochentag] || istFeiertag(tt)) continue;
    const label = i === 0 ? "heute" : (i === 1 ? "morgen" : "am " + tt.wochentagName);
    return `${label} ab ${OEFFNUNG[tt.wochentag][0]} Uhr`;
  }
  return "in den nächsten Tagen";
}
function offenJetzt(t, feiertag) {
  const oh = OEFFNUNG[t.wochentag];
  if (!oh || feiertag) return false;
  const h = t.stunde + t.minute / 60;
  return h >= oh[0] && h < oh[1];
}
// Ist heute noch Öffnungszeit übrig?
function offenSpaeter(t) {
  const oh = OEFFNUNG[t.wochentag];
  if (!oh) return false;
  return (t.stunde + t.minute / 60) < oh[1];
}

export function zeitKontext() {
  const jetzt = new Date();
  const t = berlinTeile(jetzt);
  const uhrzeit = `${String(t.stunde).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;

  // Begrüßung nach Tageszeit UND Jahreszeit. Gängige Konvention im Deutschen:
  // Abend ab 18 Uhr (Sommerzeit) bzw. ab 17 Uhr (Winterzeit) — im Sommer ist
  // es länger hell, "Guten Abend" um 17 Uhr wirkt dort verfrüht.
  const sommerzeit = t.monat >= 4 && t.monat <= 9;
  const abendAb = sommerzeit ? 18 : 17;
  let gruss;
  if (t.stunde < 5) gruss = "Guten Abend";           // tiefe Nacht
  else if (t.stunde < 11) gruss = "Guten Morgen";
  else if (t.stunde < abendAb) gruss = "Guten Tag";
  else gruss = "Guten Abend";

  // Passender Abschied — richtet sich nach Wochentag und Uhrzeit.
  // "Gute Nacht" ist im Deutschen KEIN Gruß, nur ein Abschied.
  const wt = t.wochentag;
  let abschied;
  if (t.stunde >= 22 || t.stunde < 5) abschied = "noch eine gute Nacht";
  else if (wt === 0) abschied = "noch einen schönen Sonntag";
  else if (wt === 6) abschied = "noch ein schönes Wochenende";
  else if (wt === 5 && t.stunde >= 12) abschied = "ein schönes Wochenende";
  else if (t.stunde >= abendAb) abschied = "noch einen schönen Abend";
  else if (t.stunde < 11) abschied = "noch einen guten Start in den Tag";
  else abschied = "noch einen schönen Tag";

  // Wochenend- und Feierabend-Lage, damit Alex die Situation richtig einordnet.
  const istOffen = offenJetzt(t, feiertagVor(t));
  const naechste = naechsteOeffnung(jetzt, !offenSpaeter(t) || !!feiertagVor(t));
  let lage;
  if (istOffen) {
    lage = "Das Team ist gerade in der Werkstatt erreichbar.";
  } else if (feiertagVor(t)) {
    lage = `Feiertag — geschlossen. Wieder geöffnet ${naechste}.`;
  } else if (wt === 0) {
    lage = `Es ist Sonntag, die Werkstatt ist zu. Wieder geöffnet ${naechste}.`;
  } else if (wt === 6) {
    lage = `Es ist Samstag, Wochenende. Wieder geöffnet ${naechste}.`;
  } else if (wt === 5) {
    lage = `Freitagnachmittag, für diese Woche ist Feierabend. Wieder geöffnet ${naechste}.`;
  } else if (t.stunde < 8) {
    lage = `Noch vor Öffnung — das Team ist ${naechste} da.`;
  } else {
    lage = `Feierabend — das Team ist ${naechste} wieder da.`;
  }

  const feiertagHeute = istFeiertag(t);
  const oh = OEFFNUNG[t.wochentag];
  const offen = !!oh && !feiertagHeute &&
    (t.stunde + t.minute / 60) >= oh[0] && (t.stunde + t.minute / 60) < oh[1];

  // Nächste buchbare Tage ermitteln (max. 10 Tage vorausschauen)
  const tage = [];
  for (let i = 0; i < 12 && tage.length < 5; i++) {
    const d = new Date(jetzt.getTime() + i * 86400000);
    const tt = berlinTeile(d);
    const fenster = terminFenster(tt);
    if (!fenster) continue;
    // Für heute nur, wenn das Zeitfenster noch nicht vorbei ist
    if (i === 0) {
      const bisH = parseInt(fenster.split("–")[1], 10);
      if (t.stunde >= bisH) continue;
    }
    const label = i === 0 ? "heute" : (i === 1 ? "morgen" : tt.wochentagName);
    tage.push(`${label} (${tt.tag}.${tt.monat}.): ${fenster}`);
  }

  const feiertagsHinweis = feiertagHeute ? `Heute ist ${feiertagHeute}. ` : "";

  return "Heute ist " + t.wochentagName + ", " + t.tag + "." + t.monat + "." +
    t.jahr + ", aktuell " + uhrzeit + " Uhr (Berlin). " + feiertagsHinweis +
    lage + "\n\n" +
    "TON UND ZEITGEFÜHL:\n" +
    "- Passende Begrüßung wäre \"" + gruss + "\". Spiegle eine unpassende " +
    "Begrüßung des Kunden nicht, grüße selbst passend zurück. Begrüße nur " +
    "zu Beginn eines Gesprächs, nicht in jeder Nachricht.\n" +
    "- Wenn ein Gespräch zu Ende geht, verabschiede dich passend, z. B. " +
    "\"" + abschied + "\". Nicht erzwingen, nur wenn es natürlich wirkt.\n" +
    "- Am Wochenende oder nach Feierabend: sag ruhig, dass das Team gerade " +
    "nicht da ist, aber bleib hilfsbereit — du kannst den Schaden trotzdem " +
    "einschätzen, Fragen beantworten und einen Termin vormerken. Formuliere " +
    "das als Angebot, nicht als Absage.\n" +
    "- Schreib wie ein Mensch am Tresen: kurze Sätze, natürliche Sprache, " +
    "kein Behördendeutsch, keine Textbausteine, keine Aufzählungen ohne Not. " +
    "Wiederhole nicht bei jeder Antwort Öffnungszeiten oder Standardsätze.\n\n" +
    "TERMINE – verbindliche Regeln:\n" +
    "- Samstag und Sonntag ist IMMER geschlossen, ebenso an Berliner " +
    "Feiertagen. Schlage solche Tage niemals vor.\n" +
    "- Montagvormittag werden keine Termine vergeben (Werkstattplanung).\n" +
    "- Nicht direkt zur Öffnung und nicht kurz vor Feierabend – es muss " +
    "genug Zeit für die Begutachtung bleiben.\n" +
    "- Diese Zeitfenster sind aktuell möglich (nur diese vorschlagen):\n" +
    (tage.length ? tage.map(x => "  · " + x).join("\n")
                 : "  · zurzeit keine – Team meldet sich zur Abstimmung") +
    "\n- Rechne Wochentage nie selbst aus, nutze ausschließlich diese Liste. " +
    "Sage nie einen Slot verbindlich zu; das Team bestätigt den Termin.";
}
