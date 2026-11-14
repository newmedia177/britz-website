// api/_denken.mjs
// Die "rechte Hand" von Dirk: liest ein Kundengespraech und beurteilt die
// Lage, statt nach der Uhr feste Texte zu verschicken.
//
// Wird nur an Entscheidungspunkten gefragt (nie bei jeder Nachricht):
//   - "karte":      Gespraech ruht oder ist uebergeben -> Zusammenfassung
//                   und Empfehlung fuer Dirk
//   - "nachhaken1": Kunde ist mitten im Ablauf verstummt -> haengt das
//                   Gespraech wirklich, und wenn ja: was schreibt ein
//                   aufmerksamer Mitarbeiter jetzt?
//   - "nachhaken2": WhatsApp schliesst bald, noch kein Angebot -> ehrlicher
//                   Zwischenstand, passend zu Wartezeit und Stimmung
//
// Harte Grenzen stehen im Code, nicht im Prompt: keine Preise, Laenge,
// Uhrzeiten, Hoechstzahl der Nachrichten. Faellt die KI aus, gibt es eine
// schlichte Karte ohne Empfehlung und keine Nachricht an den Kunden.

import { fetchMitZeit } from "./_termin.mjs";

const MODELL = () => process.env.CLAUDE_MODEL_DENKEN || process.env.CLAUDE_MODEL || "claude-sonnet-5";

const GRUND = `Du bist die rechte Hand des Chefs einer Autolackiererei in Berlin-Britz (Unfallinstandsetzung, Lackierung, Smart Repair). Der KI-Assistent "Alex" hat mit einem Kunden geschrieben. Du liest das Gespräch und bereitest es für den Chef (Dirk) auf. Dirk liest auf dem Handy zwischen zwei Autos und will in fünf Sekunden wissen, worum es geht und was er tun soll.

Antworte NUR mit einem JSON-Objekt, ohne Text davor oder danach:
{"kurz":"","liegt_vor":"","fehlt":"","will":"","stimmung":"","haengt":false,"empfehlung":"","nachricht":""}

kurz: Ein bis zwei Sätze, höchstens 200 Zeichen. Fahrzeug, betroffenes Bauteil, Art des Schadens, Hergang oder Versicherungslage. Nur was im Gespräch steht, nichts raten. Fachlich wie ein Meister ("Stoßfänger vorn links verkratzt, Parkrempler, Selbstzahler"). Keine Floskeln, kein "Der Kunde".
liegt_vor: Stichworte, was da ist (z. B. "3 Fotos, Fahrzeugschein, Hergang").
fehlt: Stichworte, was für eine Kalkulation noch fehlt, oder "nichts".
will: Was der Kunde eigentlich möchte, in wenigen Worten ("Preis", "Termin zur Begutachtung", "Rückruf", "schnell fertig bis Freitag").
stimmung: genau eines von "ruhig", "unsicher", "eilig", "verärgert".
haengt: true, wenn der Kunde mitten im Ablauf verstummt ist (Alex hat etwas gefragt oder erbeten, und es kam nichts mehr). false, wenn das Gespräch sauber steht: Der Kunde hat alles geliefert und wartet auf die Werkstatt, oder er hat sich bedankt oder verabschiedet, oder seine letzte Nachricht war nur eine Bestätigung ("ok", "alles klar", "danke").
empfehlung: EIN kurzer Satz an Dirk, höchstens 100 Zeichen, was jetzt am meisten bringt. Beispiele: "Vom Foto kalkulierbar, Angebot schicken." / "Schaden unklar, lieber zur Begutachtung einladen." / "Heute persönlich anrufen, Kunde ist verärgert." / "Nichts zu tun, Kunde wollte nur die Öffnungszeiten."
nachricht: siehe Auftrag unten. Wenn dort nichts verlangt ist, leer lassen.`;

const NACHRICHT_REGELN = `
Regeln für "nachricht" (sie geht als WhatsApp von Alex an den Kunden):
- Per Sie. Höchstens drei kurze Sätze. Kein Ausrufezeichen, keine Gedankenstriche, keine Aufzählung, keine Emojis.
- Schreib wie ein aufmerksamer Mitarbeiter am Empfang, nicht wie ein System. Knüpf an das an, was der Kunde zuletzt wollte oder woran es hing. Wiederhole Alex' letzte Frage nicht im Wortlaut.
- Mach den nächsten Schritt leichter als vorher. Fehlt etwas, biete die einfachere Alternative an (Foto reicht erst mal, Kennzeichen statt Fahrzeugschein, vorbeikommen statt Unterlagen suchen) oder biete an, die Anfrage mit dem Vorhandenen weiterzugeben.
- Schreib nie "Sind Sie noch da", kein Vorwurf, kein Drängen.
- Keine Preise, keine Beträge, keine Spannen. Keine festen Zeitzusagen ("heute", "morgen", "bis Freitag"). Nichts versprechen, was die Werkstatt tun muss, außer dass sich das Team meldet.
- Sprich den Kunden nur mit "Herr/Frau Nachname" an, wenn er seinen Nachnamen selbst genannt hat. Sonst ohne Namen.
- Ende mit genau EINER einfachen Frage, auf die der Kunde mit einem Wort antworten kann.`;

function auftrag(anlass, fakten) {
  if (anlass === "nachhaken1") {
    return `AUFTRAG: Der Kunde hat seit ${fakten.stillMin} Minuten nicht mehr geantwortet. Entscheide zuerst "haengt". Ist haengt=true, schreib in "nachricht" eine kurze Nachricht, die ihn freundlich zurückholt. Ist haengt=false, bleibt "nachricht" leer.` + NACHRICHT_REGELN;
  }
  if (anlass === "nachhaken2") {
    return `AUFTRAG: Der Kunde hat zuletzt vor ${fakten.stillStd} Stunden geschrieben. In wenigen Stunden kann Alex ihm auf WhatsApp nicht mehr schreiben. ${fakten.uebergeben
      ? "Die Anfrage liegt bei der Werkstatt, ein Kostenvoranschlag ist noch NICHT raus."
      : "Die Anfrage ist noch unvollständig und nicht an die Werkstatt übergeben."}
Schreib in "nachricht" einen ehrlichen kurzen Zwischenstand. Beginne mit "Guten Tag, hier ist noch einmal Alex von der Autolackiererei in Britz." Sag offen, wie der Stand ist, ohne zu beschönigen. Biete als schnelleren Weg die kostenlose Begutachtung vor Ort an (etwa 15 bis 30 Minuten, Haarlemer Straße 48-54).${fakten.frei ? " Freie Zeiten, die du nennen darfst: " + fakten.frei + "." : ""} Frag am Ende, ob Alex einen Termin eintragen soll oder ob der Kunde lieber auf den Kostenvoranschlag wartet.` + NACHRICHT_REGELN;
  }
  return `AUFTRAG: Nur die Aufbereitung für Dirk. "nachricht" bleibt leer.`;
}

// Gespraech als Text (aelteste zuerst). w: K = Kunde, A = Alex, D = Werkstatt persoenlich
export function gespraechText(zuege, max = 30) {
  return (zuege || []).slice(-max).map(z =>
    (z.w === "K" ? "Kunde: " : z.w === "D" ? "Werkstatt persönlich: " : "Alex: ") +
    String(z.t || "").replace(/\[\[[A-Z_]+\|[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 500)
  ).filter(s => s.length > 8).join("\n");
}

function jsonAus(roh) {
  const s = String(roh || "");
  const a = s.indexOf("{"), e = s.lastIndexOf("}");
  if (a < 0 || e <= a) return null;
  try { return JSON.parse(s.slice(a, e + 1)); } catch (_) { return null; }
}

// Kundennachricht aus der KI pruefen. Rueckgabe: bereinigter Text oder "".
export function nachrichtPruefen(text) {
  let t = String(text || "").replace(/\[\[[A-Z_]+\|[^\]]*\]\]/g, "").trim();
  if (!t) return "";
  // Keine Betraege (harte Regel von Dirk)
  if (/\d+\s*(€|euro|eur\b)/i.test(t) || /(€|euro)\s*\d/i.test(t)) return "";
  t = t.replace(/\s[–—]\s/g, ", ").replace(/!+/g, ".").replace(/\s+/g, " ").replace(/\.\./g, ".").trim();
  if (t.length < 25 || t.length > 520) return "";
  return t;
}

// Kleine, guenstige KI-Anfrage ohne die grosse Wissensbasis.
export async function kiKurz(system, nutzer, maxTokens = 500, zeitMs = 20000) {
  if (!process.env.ANTHROPIC_API_KEY) return "";
  try {
    const r = await fetchMitZeit("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODELL(), max_tokens: maxTokens, system, messages: [{ role: "user", content: String(nutzer).slice(0, 24000) }] })
    }, zeitMs);
    if (!r.ok) { console.error("denken", r.status); return ""; }
    const j = await r.json();
    return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  } catch (e) { console.error("denken", e && e.message); return ""; }
}

// Lage einer Anfrage beurteilen. Rueckgabe: Objekt oder null (KI nicht
// erreichbar oder Antwort unbrauchbar).
export async function lageBeurteilen({ akte, zuege, anlass = "karte", fakten = {} }) {
  const text = gespraechText(zuege);
  if (!text) return null;
  const wartetTage = Math.floor((Date.now() - (akte.ts || Date.now())) / 86400000);
  const kopf =
    "Anfrage Nr. " + akte.nr + " über " + (akte.kanal === "web" ? "den Website-Chat" : "WhatsApp") + "\n" +
    "Fotos bisher: " + (akte.fotos || 0) + "\n" +
    (akte.fahrzeug ? "Fahrzeug laut Alex: " + akte.fahrzeug + "\n" : "") +
    (akte.schaden ? "Schadensart laut Alex: " + akte.schaden + "\n" : "") +
    "Stand: " + (akte.status === "neu" ? (fakten.uebergeben ? "an die Werkstatt übergeben, noch kein Angebot" : "noch nicht übergeben")
                : akte.status === "angebot" ? "Angebot ist raus" : akte.status === "termin" ? "Termin gebucht" : "nur Gespräch") +
    (wartetTage >= 1 ? ", Anfrage ist " + wartetTage + " Tag(e) alt" : "") + "\n\n" +
    "GESPRÄCH:\n" + text + "\n\n" + auftrag(anlass, fakten);
  const roh = await kiKurz(GRUND, kopf, 600);
  const j = jsonAus(roh);
  if (!j || typeof j !== "object") return null;
  const s = (v, n) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, n);
  const stimmung = ["ruhig", "unsicher", "eilig", "verärgert"].includes(j.stimmung) ? j.stimmung : "ruhig";
  return {
    kurz: s(j.kurz, 220), liegtVor: s(j.liegt_vor, 120), fehlt: s(j.fehlt, 120), will: s(j.will, 80),
    stimmung, haengt: j.haengt === true, empfehlung: s(j.empfehlung, 120),
    nachricht: anlass === "karte" ? "" : nachrichtPruefen(j.nachricht),
    ts: Date.now()
  };
}
