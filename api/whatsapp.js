// api/whatsapp.js – Alex auf WhatsApp (Meta WhatsApp Cloud API)
//
// VORBEREITET, aber erst aktiv, wenn eingerichtet (siehe README, Teil B):
//   WHATSAPP_TOKEN         Zugriffstoken der Meta-App
//   WHATSAPP_PHONE_ID      Phone Number ID der WhatsApp-Business-Nummer
//   WHATSAPP_VERIFY_TOKEN  Frei wählbares Geheimwort für die Webhook-Verifizierung
// Optional (Gesprächsgedächtnis über Nachrichten hinweg, sehr empfohlen):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (kostenloses Upstash-Redis)
//
// Webhook-URL in der Meta-App: https://<eure-domain>/api/whatsapp

import { SYSTEM, KNOWLEDGE } from "./_bundle.mjs";
import { logGapIfNeeded } from "./chat.js";

export const config = { maxDuration: 60 };

const GRAPH = "https://graph.facebook.com/v20.0";
const MAX_TURNS = 16;

export default async function handler(req, res) {
  // ---- Webhook-Verifizierung (einmalig von Meta aufgerufen) ----
  if (req.method === "GET") {
    const q = req.query || {};
    if (q["hub.mode"] === "subscribe" &&
        q["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(q["hub.challenge"]);
    } else {
      res.status(403).end();
    }
    return;
  }
  if (req.method !== "POST") { res.status(405).end(); return; }

  // Meta erwartet schnell ein 200 – Antwort senden wir asynchron danach.
  res.status(200).json({ ok: true });

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return;                          // Status-Events ignorieren
    const from = msg.from;                     // Handynummer des Kunden

    // ---- Eingehende Nachricht lesen (Text oder Bild) ------------
    let text = "";
    const images = [];
    if (msg.type === "text") {
      text = (msg.text?.body || "").slice(0, 4000);
    } else if (msg.type === "image") {
      text = (msg.image?.caption || "(Foto vom Schaden)").slice(0, 4000);
      const img = await fetchWhatsAppMedia(msg.image?.id);
      if (img) images.push(img);
    } else {
      await sendWhatsApp(from,
        "Das Format kann ich hier leider nicht öffnen. Schicken Sie mir " +
        "gern Text oder Fotos vom Schaden – oder rufen Sie uns an: " +
        "030 607 97 930.");
      return;
    }

    // ---- Lern-Modus: nur Inhaber-Nummern dürfen Anweisungen geben --
    if (isOwner(from)) {
      const handled = await handleOwnerCommand(from, text);
      if (handled) return;
    }

    // ---- Gesprächsverlauf laden (optional, via Upstash) ----------
    const history = await memGet(from);
    const messages = [...history, { role: "user", content: text }]
      .slice(-MAX_TURNS);

    // Bilder an die letzte Nachricht hängen
    if (images.length) {
      const last = messages[messages.length - 1];
      last.content = [
        ...images.map(b64 => ({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: b64 }
        })),
        { type: "text", text }
      ];
    }

    const notesBlock = await ownerNotesBlock();

    // ---- Alex antworten lassen ------------------------------------
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-fable-5",
        max_tokens: 500,
        system: [{
          type: "text",
          text: SYSTEM + "\n\n<wissensbasis>\n" + KNOWLEDGE + "\n</wissensbasis>",
          cache_control: { type: "ephemeral" }
        }, {
          type: "text",
          text: "Heute ist " + new Date().toLocaleDateString("de-DE",
            { weekday: "long", year: "numeric", month: "long",
              day: "numeric", timeZone: "Europe/Berlin" }) +
            ". Kanal: WhatsApp – antworte besonders kurz." + notesBlock
        }],
        messages
      })
    });

    if (!r.ok) {
      console.error("Anthropic", r.status, await r.text().catch(() => ""));
      await sendWhatsApp(from,
        "Entschuldigung, ich bin gerade nicht erreichbar. Rufen Sie uns " +
        "gern direkt an: 030 607 97 930 (Mo–Do 8–17, Fr 8–15 Uhr).");
      return;
    }

    const data = await r.json();
    let reply = (data.content || [])
      .filter(b => b.type === "text").map(b => b.text).join("\n").trim();

    // Termin-Marker: auf WhatsApp gibt es keinen Kalender-Button –
    // Marker entfernen (der Termin steht ja im Text bestätigt).
    reply = reply.replace(/\n?\[\[TERMIN\|[^\]]*\]\]\s*$/, "").trim();
    if (!reply) reply = "Können Sie das noch einmal anders formulieren?";

    await sendWhatsApp(from, reply);
    await logGapIfNeeded(text, reply);   // Wissenslücke still protokollieren

    // ---- Verlauf speichern ---------------------------------------
    await memSet(from, [...messages.map(m => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : text
    })), { role: "assistant", content: reply }].slice(-MAX_TURNS));

  } catch (e) {
    console.error("whatsapp handler", e);
  }
}

// ---- WhatsApp senden ---------------------------------------------
async function sendWhatsApp(to, body) {
  const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: body.slice(0, 4000) }
    })
  });
  if (!r.ok) console.error("send", r.status, await r.text().catch(() => ""));
}

// ---- Bild von WhatsApp herunterladen (Media-API, 2 Schritte) -----
async function fetchWhatsAppMedia(mediaId) {
  if (!mediaId) return null;
  try {
    const auth = { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
    const meta = await (await fetch(`${GRAPH}/${mediaId}`, { headers: auth })).json();
    if (!meta.url) return null;
    const bin = await (await fetch(meta.url, { headers: auth })).arrayBuffer();
    if (bin.byteLength > 3_500_000) return null;   // zu groß fürs MVP
    return Buffer.from(bin).toString("base64");
  } catch (e) {
    console.error("media", e);
    return null;
  }
}

// ---- Mini-Gedächtnis über Upstash Redis (optional) ----------------
async function memGet(key) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return [];
  try {
    const r = await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/get/wa:${key}`,
      { headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : [];
  } catch { return []; }
}
async function memSet(key, value) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/set/wa:${key}?EX=86400`,
      { method: "POST",
        headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
        body: JSON.stringify(value) });
  } catch { /* Gedächtnis ist optional */ }
}

// ---- Lern-Modus: Inhaber kann dem Assistenten per WhatsApp Wissen geben --
function isOwner(num) {
  return (process.env.OWNER_NUMBERS || "").split(",")
    .map(s => s.replace(/\D/g, "")).filter(Boolean)
    .includes(String(num).replace(/\D/g, ""));
}

async function handleOwnerCommand(from, text) {
  const t = (text || "").trim();
  let m;
  if ((m = t.match(/^(merk dir|update|korrektur)[:,\s]+([\s\S]+)/i))) {
    const notes = await notesGet();
    notes.push({ d: new Date().toISOString().slice(0, 10), t: m[2].trim() });
    await notesSet(notes);
    await sendWhatsApp(from, "Gemerkt (Nr. " + notes.length + "): " +
      m[2].trim() + "\nGilt ab sofort in allen Kundengesprächen.");
    return true;
  }
  if (/^zeig(e)?( mir)?( die)? l(ü|ue)cken/i.test(t) || /^offene fragen/i.test(t)) {
    const gaps = await gapsGet();
    await sendWhatsApp(from, gaps.length
      ? "Fragen, die ich zuletzt nicht beantworten konnte:\n" +
        gaps.slice(0, 10).map((g, i) =>
          (i + 1) + ". " + g.q + "  (" + g.n + "x, zuletzt " + g.last + ")").join("\n") +
        "\n\nAntwort einfach mit \"Merk dir: …\" – dann weiß ich es ab sofort."
      : "Aktuell keine offenen Fragen. Läuft.");
    return true;
  }
  if (/^l(ü|ue)cken leeren/i.test(t)) {
    await gapsSet([]);
    await sendWhatsApp(from, "Liste geleert.");
    return true;
  }
  if (/^was hast du dir gemerkt/i.test(t) || /^zeig(e)?( deine)? notizen/i.test(t)) {
    const notes = await notesGet();
    await sendWhatsApp(from, notes.length
      ? "Meine Notizen vom Inhaber:\n" +
        notes.map((n, i) => (i + 1) + ". " + n.t).join("\n")
      : "Noch keine Notizen. Schicken Sie mir z. B.:\nMerk dir: Scheibentausch übernimmt immer die Teilkasko.");
    return true;
  }
  if (/^(hilfe|befehle|was kannst du)$/i.test(t)) {
    await sendWhatsApp(from,
      "Ihre Befehle:\n" +
      "• Merk dir: … – neues Wissen, gilt sofort\n" +
      "• Zeig Notizen – alles Gemerkte\n" +
      "• Vergiss 2 – Notiz 2 löschen\n" +
      "• Zeig Lücken – Fragen, die ich nicht beantworten konnte\n" +
      "• Lücken leeren – Liste zurücksetzen");
    return true;
  }
  if ((m = t.match(/^vergiss (nummer |notiz )?(\d+)/i))) {
    const notes = await notesGet();
    const i = parseInt(m[2], 10) - 1;
    if (notes[i]) {
      const gone = notes.splice(i, 1)[0];
      await notesSet(notes);
      await sendWhatsApp(from, "Gelöscht: " + gone.t);
    } else {
      await sendWhatsApp(from, "Diese Nummer gibt es nicht. \"Zeig Notizen\" listet alles auf.");
    }
    return true;
  }
  return false;   // Inhaber stellt normale Frage -> normal antworten
}

async function ownerNotesBlock() {
  const notes = await notesGet();
  if (!notes.length) return "";
  return "\n\nAktuelle Hinweise vom Inhaber (verbindlich; überschreiben " +
    "bei Widerspruch die Wissensbasis):\n" +
    notes.map(n => "- " + n.t).join("\n");
}

async function gapsGet() {
  if (!process.env.UPSTASH_REDIS_REST_URL) return [];
  try {
    const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/gaps`,
      { headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : [];
  } catch { return []; }
}
async function gapsSet(v) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/gaps`,
      { method: "POST",
        headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
        body: JSON.stringify(v) });
  } catch { /* optional */ }
}

async function notesGet() {
  if (!process.env.UPSTASH_REDIS_REST_URL) return [];
  try {
    const r = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/notes`,
      { headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : [];
  } catch { return []; }
}
async function notesSet(v) {
  if (!process.env.UPSTASH_REDIS_REST_URL) return;
  try {
    await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/set/notes`,
      { method: "POST",
        headers: { authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
        body: JSON.stringify(v) });
  } catch { /* optional */ }
}
