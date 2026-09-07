// api/voice.js – Alex am Telefon (dritter Kanal neben Web und WhatsApp)
//
// Derselbe Alex, dasselbe Wissen, dieselben Marker wie api/chat.js und
// api/whatsapp.js. Unterschied ist nur der Kanal: der Kunde hoert, er
// liest nicht. Deshalb liegt ueber dem normalen System-Prompt ein
// Sprech-Overlay (prompts/system-alex-voice.md).
//
// Am Telefon bewusst NICHT: Kostenvoranschlag, Fotobewertung,
// Fahrzeugschein. Das laeuft ueber WhatsApp weiter - siehe Uebergabe
// weiter unten.
//
// Erwartet JSON von einem Sprachdienst (Retell, Vapi o. ae.) und
// antwortet mit { text, actions }. Der Text ist reiner Sprechtext,
// alle Marker sind entfernt.
//
// Benoetigte Umgebungsvariablen: ANTHROPIC_API_KEY
// Optional: CLAUDE_MODEL, WHATSAPP_* (fuer die Uebergabe), Upstash

import { readFileSync } from "node:fs";
import { SYSTEM, KNOWLEDGE } from "./_bundle.mjs";
import { zeitKontext } from "./chat.js";
import { meldeTermin, belegteZeiten, warteschlangeZustellen,
         markerRaus, jsonLesen, jsonSchreiben, speicherUrl,
         fetchMitZeit, sendWA, sendWATemplate,
         RE_TERMIN, RE_KONTAKT } from "./_termin.mjs";

export const config = { maxDuration: 30 };

const MODELL_ZEITLIMIT_MS = 20000;   // Telefon vertraegt keine lange Stille
const MAX_TURNS = 20;
const MAX_CHARS = 2000;
const VORGANG_TTL_S = 86400;         // ein Tag, wie das WhatsApp-Fenster

const NICHT_ERREICHBAR =
  "Entschuldigung, da komme ich gerade nicht weiter. " +
  "Bitte melden Sie sich kurz direkt beim Team, unter 030 607 97 930.";

const LEER_NOTSATZ = "Ich bin dran. Worum geht es?";

// ---- Sprech-Overlay zur Laufzeit lesen ----------------------------
// Bewusst kein zweites Bundle: prompts/system-alex-voice.md wird beim
// ersten Aufruf gelesen und dann im Speicher gehalten. Der Pfad geht
// ueber import.meta.url, damit Vercel die Datei beim Deploy mitnimmt.
let voiceCache = null;
function voiceOverlay() {
  if (voiceCache !== null) return voiceCache;
  try {
    voiceCache = readFileSync(
      new URL("../prompts/system-alex-voice.md", import.meta.url), "utf8").trim();
  } catch (e) {
    console.error("voice: Overlay nicht lesbar", e && e.message);
    // Notfallregeln, damit der Kanal nie ohne Leitplanken laeuft.
    // Der ausfuehrliche Text steht in prompts/system-alex-voice.md.
    voiceCache =
      "# Kanal: Telefon\n" +
      "Erster Satz des Gespraechs: \"Guten Tag, Britz, Alex am Apparat – " +
      "digitaler Assistent. Womit kann ich helfen?\" (Gruss passend zur " +
      "Uhrzeit). Diese Kennzeichnung faellt genau einmal.\n" +
      "Kurze Saetze, eine Frage pro Redebeitrag, keine Aufzaehlungen, " +
      "Marker nie aussprechen.\n" +
      "Am Telefon KEIN Kostenvoranschlag, KEINE Fotobewertung, KEIN " +
      "Fahrzeugschein. Das laeuft ueber WhatsApp.\n" +
      "Nie behaupten, ein Mensch oder Dirk zu sein.";
  }
  return voiceCache;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("voice: ANTHROPIC_API_KEY fehlt");
    res.status(200).json({ text: NICHT_ERREICHBAR, actions: [] });
    return;
  }

  const body = req.body || {};
  const anrufer = anruferNummer(body);
  const messages = verlaufLesen(body);

  // Jeder Request wird protokolliert. Die Rufnummer NUR maskiert - in
  // den Vercel-Logs hat eine vollstaendige Kundennummer nichts zu suchen.
  console.log(JSON.stringify({
    channel: "phone",
    anrufer: maskieren(anrufer),
    turns: messages.length
  }));

  if (!messages.length) {
    res.status(200).json({ text: LEER_NOTSATZ, actions: [] });
    return;
  }

  // ---- Vorgang laden: koppelt den Anruf an die Rufnummer ----------
  const vorgangKey = anrufer ? "vorgang:tel:+" + anrufer : "";
  let vorgang = vorgangKey && speicherUrl()
    ? await jsonLesen(vorgangKey, null).catch(() => null)
    : null;
  if (!vorgang) vorgang = { kanal: "phone", seit: Date.now(), wa_handoff: false };

  // ---- Alex antworten lassen -------------------------------------
  let antwort = "";
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
        // Am Telefon kurz halten: lange Antworten sind gesprochen zaeh.
        max_tokens: 400,
        system: [{
          type: "text",
          text: SYSTEM + "\n\n<wissensbasis>\n" + KNOWLEDGE + "\n</wissensbasis>",
          cache_control: { type: "ephemeral" }
        }, {
          type: "text",
          text: zeitKontext(await belegteZeiten().catch(() => [])) +
            "\n\n" + voiceOverlay() +
            (anrufer
              ? "\n\nDer Kunde ruft von der Nummer +" + anrufer + " an. Frag " +
                "deshalb NICHT nach seiner Telefonnummer. Fuer die Uebergabe " +
                "auf WhatsApp lass dir nur kurz bestaetigen, dass diese Nummer " +
                "passt."
              : "\n\nDie Rufnummer des Anrufers ist nicht bekannt. Fuer die " +
                "Uebergabe auf WhatsApp musst du sie einmal erfragen.") +
            (await notizenBlock())
        }],
        messages
      })
    }, MODELL_ZEITLIMIT_MS);

    if (!r.ok) {
      console.error("voice: Anthropic", r.status, await r.text().catch(() => ""));
      res.status(200).json({ text: NICHT_ERREICHBAR, actions: [] });
      return;
    }
    const data = await r.json();
    antwort = (data.content || [])
      .filter(c => c && c.type === "text").map(c => c.text).join("").trim();
  } catch (e) {
    console.error("voice: Anthropic fetch", e && e.name, e && e.message);
    res.status(200).json({ text: NICHT_ERREICHBAR, actions: [] });
    return;
  }

  // ---- Sprechtext: Marker raus -----------------------------------
  let text = markerRaus(antwort).replace(/\s+/g, " ").trim();
  const actions = [];

  // ---- Uebergabe an WhatsApp -------------------------------------
  // Sobald Alex WhatsApp anbietet, schicken wir die erste Nachricht an
  // die Anrufernummer. Ab dort uebernimmt api/whatsapp.js: Fotos,
  // Fahrzeugschein, Kostenvoranschlag, Abstimmung mit Dirk.
  // Reihenfolge: erst die Vorlage (geht auch ausserhalb der 24 Stunden),
  // dann freier Text (greift, wenn der Kunde uns kuerzlich geschrieben
  // hat), zuletzt der gesprochene Notweg.
  const willUebergeben = /whats\s?app/i.test(antwort);
  let weg = "";
  if (willUebergeben && anrufer && !vorgang.wa_handoff) {
    if (await sendWATemplate(anrufer, null, [HANDOFF_VORNAME]).catch(() => false)) {
      weg = "template";
    } else if (await sendWA(anrufer, HANDOFF_TEXT).catch(() => false)) {
      weg = "freitext";
    } else {
      weg = "fallback";
    }

    if (weg === "fallback") {
      // Ohne freigegebene Vorlage in Meta bleibt es dabei: Wer von sich
      // aus anruft, hat uns meist noch nie geschrieben, also blockt Meta
      // den freien Text. Der Anrufer bekommt den Weg dann gesagt.
      console.log(JSON.stringify({
        channel: "phone", handoff: "fehlgeschlagen", weg,
        anrufer: maskieren(anrufer)
      }));
      text += " " + HANDOFF_FALLBACK;
      actions.push("whatsapp_handoff_fehlgeschlagen");
    } else {
      console.log(JSON.stringify({
        channel: "phone", handoff: "ok", weg, anrufer: maskieren(anrufer)
      }));
      vorgang.wa_handoff = true;
      actions.push("whatsapp_handoff");
    }
  }

  if (!text) text = LEER_NOTSATZ;

  res.status(200).json(weg ? { text, actions, weg } : { text, actions });

  // ---- Marker ausfuehren (nach der Antwort, blockiert nicht) ------
  // Ein Termin am Telefon laeuft ueber dieselbe Meldung wie im Web-Chat.
  // Die Rufnummer haengen wir als KONTAKT-Marker an, falls Alex sie nicht
  // selbst gesetzt hat - sonst stuende beim Inhaber kein Rueckruf.
  let fuerMarker = antwort;
  if (anrufer && RE_TERMIN.test(antwort) && !RE_KONTAKT.test(antwort)) {
    fuerMarker += "\n[[KONTAKT||+" + anrufer + "]]";
  }
  const letzteFrage = [...messages].reverse()
    .find(m => m.role === "user" && typeof m.content === "string");
  try {
    const gemeldet = await meldeTermin({
      antwort: fuerMarker,
      kanal: "phone",
      thema: "Telefon-Anruf" + (anrufer ? " von +" + anrufer : "") + ": " +
             String((letzteFrage && letzteFrage.content) || "").slice(0, 140)
    });
    if (gemeldet) actions.push("termin_gemeldet");
  } catch (e) { console.error("voice: meldeTermin", e && e.message); }

  // Vorgang fortschreiben, damit ein zweiter Anruf denselben Stand sieht
  if (vorgangKey && speicherUrl()) {
    vorgang.letzte = Date.now();
    vorgang.turns = messages.length;
    await jsonSchreiben(vorgangKey, vorgang, VORGANG_TTL_S).catch(() => {});
  }

  await warteschlangeZustellen().catch(() => {});
}

// ---- Erste WhatsApp-Nachricht nach dem Anruf ----------------------
// Platzhalter {{1}} der Vorlage. Namen kennen wir am Telefon nicht
// zuverlaessig, deshalb die neutrale Anrede.
const HANDOFF_VORNAME = "Guten Tag";

const HANDOFF_TEXT =
  "Hier ist Alex von der Autolackiererei in Britz. Wir hatten gerade " +
  "telefoniert. Schicken Sie mir hier gern zwei Fotos vom Schaden und " +
  "ein Bild vom Fahrzeugschein, dann gebe ich alles an Dirk weiter.";

const HANDOFF_FALLBACK =
  "Schreiben Sie mir dafür bitte einmal kurz auf WhatsApp, unter " +
  "030 607 97 930. Dann läuft der Rest dort.";

// ---- Anrufernummer robust aus dem Webhook holen -------------------
// Die Sprachdienste benennen das Feld unterschiedlich, deshalb suchen
// wir der Reihe nach die gaengigen Stellen ab. Zurueck kommen nur
// Ziffern (ohne +), so wie WhatsApp sie erwartet.
function anruferNummer(body) {
  const call = body.call || body.message || {};
  const kandidaten = [
    body.from, body.caller, body.customer_number, body.from_number,
    body.telefon, body.phone,
    call.from, call.from_number, call.caller,
    call.customer && call.customer.number,
    body.customer && body.customer.number,
    body.call_inbound && body.call_inbound.from_number,
    body.metadata && body.metadata.from
  ];
  for (const k of kandidaten) {
    const n = String(k || "").replace(/[^\d]/g, "");
    if (n.length >= 9 && n.length <= 15) return n;
  }
  return "";
}

// Nur die letzten vier Ziffern gehoeren ins Log.
function maskieren(nr) {
  const n = String(nr || "");
  return n ? "…" + n.slice(-4) : "(unbekannt)";
}

// ---- Verlauf robust aus dem Webhook holen -------------------------
// Entweder ein einzelner Text (text/message/transcript/user_input) oder
// eine Liste von Turns (messages/transcript/conversation). Rollen der
// Sprachdienste ("agent", "bot", "ai") werden auf assistant abgebildet.
function verlaufLesen(body) {
  const liste = [body.messages, body.transcript, body.conversation,
                 body.message && body.message.messages]
    .find(x => Array.isArray(x) && x.length);

  if (liste) {
    return liste.map(m => {
      const rolle = String((m && (m.role || m.speaker)) || "").toLowerCase();
      const inhalt = String((m && (m.content || m.message || m.text)) || "")
        .slice(0, MAX_CHARS).trim();
      return {
        role: ["assistant", "agent", "bot", "ai"].includes(rolle) ? "assistant" : "user",
        content: inhalt
      };
    }).filter(m => m.content).slice(-MAX_TURNS);
  }

  const str = v => (typeof v === "string" ? v : "");
  const einzeln = (str(body.text) || str(body.message) || str(body.transcript) ||
                   str(body.user_input) || str(body.query))
    .slice(0, MAX_CHARS).trim();
  return einzeln ? [{ role: "user", content: einzeln }] : [];
}

// ---- Verbindliche Hinweise vom Inhaber ----------------------------
// Dieselben Notizen, die Web-Chat und WhatsApp benutzen ("Merk dir: …").
async function notizenBlock() {
  try {
    const notes = await jsonLesen("notes", []);
    if (!notes.length) return "";
    return "\n\nAktuelle Hinweise vom Inhaber (verbindlich; überschreiben " +
      "bei Widerspruch die Wissensbasis):\n" +
      notes.map(n => "- " + n.t).join("\n");
  } catch { return ""; }
}
