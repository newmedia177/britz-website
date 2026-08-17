// api/whatsapp.js – Alex auf WhatsApp (Meta WhatsApp Cloud API)
//
// Benötigte Umgebungsvariablen:
//   WHATSAPP_TOKEN         Zugriffstoken der Meta-App
//   WHATSAPP_PHONE_ID      Phone Number ID der WhatsApp-Business-Nummer
//   WHATSAPP_VERIFY_TOKEN  Frei wählbares Geheimwort für die Webhook-Verifizierung
// Optional (Gesprächsgedächtnis + Lern-Modus, sehr empfohlen):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   oder KV_REST_API_URL / KV_REST_API_TOKEN (neuere Vercel-Integration)
//   OWNER_NUMBERS          Kommagetrennt, international ohne + (z. B. 491722769741)
//   GRAPH_VERSION          Optional, Standard v25.0
//
// Webhook-URL in der Meta-App: https://<eure-domain>/api/whatsapp

import { SYSTEM, KNOWLEDGE } from "./_bundle.mjs";
import { logGapIfNeeded, saeubern, zeitKontext } from "./chat.js";
import { meldeTermin, inhaberAntwort, terminListe, markerRaus,
         RE_TERMIN_OK, icsAdresse,
         jsonLesen, jsonSchreiben, redis, datumLesbar,
         terminLoeschen, tagesBriefing,
         speicherUrl, speicherToken } from "./_termin.mjs";

export const config = { maxDuration: 60 };

// WICHTIG: Graph-Version aktuell halten. Meta stellt alte Versionen nach
// rund zwei Jahren ab; v20.0 ist am Auslaufen. Über Env überschreibbar.
const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v25.0"}`;
const MAX_TURNS = 16;

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

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

  // WICHTIG (Vercel): Die Funktion wird eingefroren, sobald die Antwort
  // gesendet ist. Deshalb erst ARBEITEN, dann 200 schicken. Meta wiederholt
  // den Aufruf bei Verzögerung – dagegen schützt die Dedupe-Prüfung unten.
  try {
    await verarbeite(req);
  } catch (e) {
    console.error("whatsapp handler", e);
  }
  res.status(200).json({ ok: true });   // Meta immer mit 200 bestätigen
}

async function verarbeite(req) {
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];

  if (!msg) {
    // Status-Events (zugestellt/gelesen) ignorieren – aber sichtbar machen,
    // damit man in den Logs sieht, was tatsächlich hereinkommt.
    console.log("whatsapp: kein messages-Event",
      JSON.stringify(Object.keys(value || {})));
    return;
  }

  const from = msg.from;                     // Handynummer des Kunden
  // WhatsApp liefert den Profilnamen mit. Damit muss Alex nicht danach
  // fragen und kann ihn fuer die Terminmeldung verwenden.
  const profilName = (value?.contacts?.[0]?.profile?.name || "").trim();

  // ---- Doppelte Zustellungen abfangen --------------------------
  // Meta wiederholt Webhooks, wenn die Antwort zu lange dauert. Ohne
  // diese Sperre würde Alex dieselbe Nachricht mehrfach beantworten.
  if (await schonVerarbeitet(msg.id)) {
    console.log("whatsapp: Wiederholung ignoriert", msg.id);
    return;
  }

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

  // ---- Inhaber: einmal am Tag kurz begrüßen und Stand melden -----
  if (isOwner(from)) {
    const briefing = await tagesBriefing(from);
    if (briefing) await sendWhatsApp(from, briefing);

    // ---- Lern-Modus: nur Inhaber dürfen Anweisungen geben --------
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

  // Verlauf sofort sichern. Faellt weiter unten etwas aus, ist die
  // Kundennachricht trotzdem im Gedaechtnis.
  await memSet(from, messages.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : text
  })));

  const notesBlock = await ownerNotesBlock();

  // Schreibt der Inhaber, arbeitet Alex als sein Assistent statt als
  // Kundenberater. Dafuer bekommt er den Stand der offenen Anfragen mit.
  const chef = isOwner(from);
  let chefBlock = "";
  if (chef) {
    const offen = await jsonLesen("termine", []);
    const frisch = offen.filter(e => Date.now() - (e.ts || 0) < 7 * 86400000);
    chefBlock =
      "\n\n=== DU SPRICHST MIT DEM INHABER ===\n" +
      "Das ist nicht ein Kunde, sondern der Chef der Werkstatt. Du bist " +
      "sein Assistent. Sprich ihn mit Sie an, sei knapp und sachlich, " +
      "keine Verkaufsfloskeln, keine Begrüßungsformeln in jeder Nachricht.\n" +
      "Er hat eben schon eine kurze Tagesübersicht von mir bekommen, " +
      "falls heute etwas offen war. Wiederhole sie nicht von selbst " +
      "und begrüße ihn nicht noch einmal.\n" +
      "Er kann dich nach dem Stand fragen, Termine ändern, dir Wissen " +
      "beibringen oder Rückmeldungen an Kunden geben.\n\n" +
      "Das kannst du für ihn tun:\n" +
      "• Offene Terminanfragen zeigen (er sagt \"Termine\")\n" +
      "• Eine Rückmeldung an einen WhatsApp-Kunden weiterleiten " +
      "(\"Termin 3 passt\" oder \"Termin 3 lieber Donnerstag 10 Uhr\")\n" +
      "• Wissen lernen (\"Merk dir: …\"), Notizen zeigen, Lücken zeigen\n" +
      "• Eine erledigte Anfrage löschen (\"Lösche Termin 3\") oder alle " +
      "(\"Lösche alle Termine\")\n\n" +
      "Wichtig zur Erreichbarkeit der Kunden:\n" +
      "• Kam die Anfrage über WhatsApp, kannst du dem Kunden direkt " +
      "antworten. Biete das aktiv an.\n" +
      "• Kam sie über den Website-Chat, kannst du dort NICHT antworten. " +
      "Sag das klar und nenne die Rufnummer zum Anrufen.\n" +
      "• Ist eine WhatsApp-Anfrage älter als 24 Stunden, lässt WhatsApp " +
      "kein Anschreiben mehr zu. Auch dann: Rufnummer nennen.\n\n" +
      (frisch.length
        ? "Aktuell offene Terminanfragen:\n" + frisch.map(e =>
            "Nr. " + e.nr + ": " + e.name +
            ", " + datumLesbar(e.wann) +
            " (" + (e.kanal === "whatsapp" ? "WhatsApp, erreichbar" : "Website, bitte anrufen") + ")" +
            (e.tel ? ", " + e.tel : "")
          ).join("\n")
        : "Aktuell keine offenen Terminanfragen.") +
      "\n\nWenn er etwas will, das du nicht selbst erledigen kannst, sag " +
      "kurz warum und was er stattdessen tun kann. Rate nie.\n" +
      "Erfinde niemals Funktionen. Kannst du etwas nicht, sage das klar " +
      "und nenne den passenden Befehl aus der Liste oben, falls es einen gibt. " +
      "Will er eine Anfrage loswerden, nenne ihm den Befehl \"Lösche Termin N\". " +
      "Setze im Gespräch mit dem Inhaber NIEMALS die Termin-Marker. " +
      "Die gelten nur für Kundengespräche.";
  }

  // ---- Alex antworten lassen ------------------------------------
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 500,
      system: [{
        type: "text",
        text: SYSTEM + "\n\n<wissensbasis>\n" + KNOWLEDGE + "\n</wissensbasis>",
        cache_control: { type: "ephemeral" }
      }, {
        type: "text",
        // Derselbe Zeit- und Terminkontext wie im Web-Chat. Ohne ihn
        // kennt Alex weder das heutige Datum noch die buchbaren Fenster
        // und versteht Angaben wie "morgen 11 Uhr" nicht.
        text: zeitKontext() + chefBlock +
          (chef ? "" :
          "\n\nDieser Kunde schreibt über WhatsApp von der Nummer +" + from +
          ". Frag deshalb NICHT nach der Telefonnummer, du hast sie bereits. " +
          "Bestätige sie höchstens kurz (\"Ich nehme die Nummer, von der Sie " +
          "schreiben\").\n" +
          "Nach dem Namen fragst du dagegen ganz normal, sobald du ihn für " +
          "einen Termin brauchst. Sprich den Kunden NIE mit einem Namen an, " +
          "den er dir nicht selbst genannt hat.") +
          "\n\nKanal: WhatsApp. Schreibe wie eine echte Person im Chat: " +
          "höchstens zwei bis drei kurze Sätze, keine Aufzählungen, " +
          "keine Zwischenüberschriften, kein Fließtext-Block." +
          // Kennzeichnung nach EU AI Act, Art. 50: Auf WhatsApp gibt es
          // keine Kopfzeile, deshalb einmalig im ersten Satz - nicht als
          // Warnhinweis, sondern als das, was es ist: schnelle Vorarbeit,
          // entschieden wird in der Werkstatt.
          (chef || messages.length > 2 ? "" :
          "\n\nDies ist die ERSTE Nachricht dieses Kunden. Ordne dich " +
          "deshalb einmal kurz und beiläufig ein — in EINEM Halbsatz, " +
          "mitten im Gespräch, nie als Hinweisblock und nie entschuldigend. " +
          "Der Gedanke: Du bist der KI-Assistent des Betriebs, machst die " +
          "Vorarbeit rund um die Uhr, und Einschätzung wie Termin gehen " +
          "anschließend an die Werkstatt, die entscheidet. Beispiel: " +
          "\"Hier ist Alex, der KI-Assistent der Autolackiererei in Britz — " +
          "ich mache die Vorarbeit, entschieden wird dann in der Werkstatt. " +
          "Schicken Sie mir gern ein Foto vom Schaden.\" Formuliere es " +
          "selbst, nicht wörtlich abschreiben. Danach normal weiter und " +
          "nie wiederholen.") + notesBlock
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
  // Terminanfrage an den Inhaber melden, bevor die Marker entfernt werden
  // Nur bei Kunden eine Terminanfrage anlegen. Spricht der Inhaber ueber
  // Termine, waere das eine Geisteranfrage an ihn selbst.
  if (!chef) {
    await meldeTermin({ antwort: reply, kanal: "whatsapp", kundeNr: from,
                        thema: text, ersatzName: profilName });
  }

  // Bestaetigter Termin: Auf WhatsApp gibt es keine Karte mit Knoepfen.
  // Statt den Marker nur zu entfernen, haengen wir eine antippbare
  // Kalender-Adresse an. Nur beim BESTAETIGTEN Termin - beim blossen
  // Wunschtermin bewusst nicht, damit niemand einen Eintrag anlegt,
  // den die Werkstatt vielleicht noch absagt.
  const mOk = String(reply).match(RE_TERMIN_OK);
  let kalenderZeile = "";
  if (mOk && !chef) {
    kalenderZeile = "\n\nIn den Kalender eintragen:\n" +
      icsAdresse(mOk[1].trim(), mOk[2].trim(), mOk[3].trim());
  }

  reply = markerRaus(reply);

  // Gedankenstriche und Ausrufezeichen entfernen (wirken maschinell)
  reply = saeubern(reply, true).trim();
  if (!reply) reply = "Können Sie das noch einmal anders formulieren?";
  if (kalenderZeile) reply += kalenderZeile;

  await sendeMenschlich(from, reply);
  await logGapIfNeeded(text, reply);   // Wissenslücke still protokollieren

  // ---- Verlauf speichern ---------------------------------------
  await memSet(from, [...messages.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : text
  })), { role: "assistant", content: reply }].slice(-MAX_TURNS));
}

// ---- Menschlich wirkendes Senden ----------------------------------
// Statt eines Textblocks kommen bis zu drei kurze Nachrichten nacheinander,
// wie ein Mensch sie tippen würde. Bewusst eng gedeckelt: die Pausen sind
// zusammen nie länger als PAUSE_BUDGET_MS, damit der Kunde nicht
// dazwischenschreibt und ein Durcheinander entsteht.
const NICHT_TEILEN_UNTER = 160;   // kurze Antworten bleiben eine Nachricht
const MAX_TEILE = 3;
const PAUSE_MAX_MS = 1500;        // pro Pause
const PAUSE_BUDGET_MS = 3000;     // für die gesamte Antwort

async function sendeMenschlich(to, text) {
  const teile = teileAntwort(text);
  let budget = PAUSE_BUDGET_MS;

  for (let i = 0; i < teile.length; i++) {
    if (i > 0 && budget > 0) {
      // Pause richtet sich nach der Länge des kommenden Teils,
      // bleibt aber immer innerhalb des Restbudgets.
      const pause = Math.min(400 + teile[i].length * 12, PAUSE_MAX_MS, budget);
      budget -= pause;
      await new Promise(r => setTimeout(r, pause));
    }
    await sendWhatsApp(to, teile[i]);
  }
}

function teileAntwort(text) {
  const t = (text || "").trim();
  if (t.length <= NICHT_TEILEN_UNTER) return [t];

  // Zuerst an Absätzen trennen – die hat das Modell bewusst gesetzt.
  let teile = t.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

  // Sonst an Satzenden trennen, ohne Sätze zu zerreißen.
  if (teile.length === 1) {
    const saetze = t.match(/[^.!?]+[.!?]*\s*/g) || [t];
    if (saetze.length < 2) return [t];
    const mitte = Math.ceil(saetze.length / 2);
    teile = [
      saetze.slice(0, mitte).join("").trim(),
      saetze.slice(mitte).join("").trim()
    ].filter(Boolean);
  }

  // Nie mehr als MAX_TEILE – der Rest hängt an der letzten Nachricht.
  if (teile.length > MAX_TEILE) {
    teile = [
      ...teile.slice(0, MAX_TEILE - 1),
      teile.slice(MAX_TEILE - 1).join("\n\n")
    ];
  }
  return teile;
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
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: body.slice(0, 4000) }
    })
  });
  if (!r.ok) console.error("send", r.status, await r.text().catch(() => ""));
  else console.log("send ok an", to);
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

// ---- Dedupe: schon verarbeitete Nachrichten-IDs merken ------------
async function schonVerarbeitet(id) {
  if (!id) return false;
  // NX = nur setzen, wenn noch nicht vorhanden; EX = eine Stunde halten.
  const r = await redis("SET", "wamsg:" + id, "1", "NX", "EX", 3600);
  if (r === undefined) return false;   // Speicher nicht erreichbar -> lieber antworten
  return r === null;                   // null = Schlüssel gab es schon
}

// ---- Mini-Gedächtnis über Upstash Redis (optional) ----------------
async function memGet(key) {
  return jsonLesen("wa:" + key, []);
}
async function memSet(key, value) {
  await jsonSchreiben("wa:" + key, value, 86400);
}

// ---- Lern-Modus: Inhaber kann Alex per WhatsApp Wissen geben --
function isOwner(num) {
  return (process.env.OWNER_NUMBERS || "").split(",")
    .map(s => s.replace(/\D/g, "")).filter(Boolean)
    .includes(String(num).replace(/\D/g, ""));
}

async function handleOwnerCommand(from, text) {
  const t = (text || "").trim();
  let m;

  // "3 passt" -> Rueckmeldung zu Terminanfrage Nr. 3
  if (await inhaberAntwort(from, t)) return true;

  // "Lösche Termin 3", "Termin 3 löschen", "Lösche alle Termine"
  m = t.match(/^(?:l(?:ö|oe)sche?|entferne)\s+(?:termin\s*)?(\d{1,3}|alle)(?:\s+termine?)?$/i)
      || t.match(/^termin\s*(\d{1,3})\s+l(?:ö|oe)schen$/i);
  if (m) {
    await sendWhatsApp(from, await terminLoeschen(m[1]));
    return true;
  }

  if (/^(status|diagnose|test)$/i.test(t)) {
    const marke = "diag:" + Date.now();
    const schreiben = await redis("SET", marke, "ok", "EX", 60);
    const lesen = await redis("GET", marke);
    const verlauf = await memGet(from);
    const notizen = await notesGet();
    const u = speicherUrl();
    const tk = speicherToken();
    await sendWhatsApp(from,
      "Selbsttest\n――――――――――――\n" +
      "Speicher konfiguriert: " + (u ? "ja" : "NEIN") + "\n" +
      "Adresse beginnt mit: " + (u.split("://")[0] || "?") + "://\n" +
      "Adresse endet auf upstash.io: " +
        (/upstash\.io\/?$/.test(u) ? "ja" : "NEIN") + "\n" +
      "Schlüssel-Länge: " + tk.length + "\n" +
      "Schreiben: " + (schreiben === "OK" ? "ok" :
        (schreiben === undefined ? "FEHLER" : String(schreiben))) + "\n" +
      "Lesen: " + (lesen === "ok" ? "ok" :
        (lesen === undefined ? "FEHLER" : String(lesen))) + "\n" +
      "Gespeicherte Gesprächsschritte: " + verlauf.length + "\n" +
      "Notizen: " + notizen.length);
    return true;
  }

  if (/^(zeig )?termine$/i.test(t) || /^offene termine/i.test(t)) {
    await sendWhatsApp(from, await terminListe());
    return true;
  }
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
      : "Noch keine Notizen. Schicken Sie mir z. B.:\nMerk dir: Für Leasingrückgaben brauchen wir das Rückgabeprotokoll.");
    return true;
  }
  if (/^(hilfe|befehle|was kannst du)$/i.test(t)) {
    await sendWhatsApp(from,
      "Ihre Befehle:\n" +
      "• Merk dir: … – neues Wissen, gilt sofort\n" +
      "• Zeig Notizen – alles Gemerkte\n" +
      "• Vergiss 2 – Notiz 2 löschen\n" +
      "• Zeig Lücken – Fragen, die ich nicht beantworten konnte\n" +
      "• Lücken leeren – Liste zurücksetzen\n" +
      "• Termine – offene Terminanfragen\n" +
      "• Termin 3 passt – Rückmeldung zu Anfrage Nr. 3\n" +
      "• Lösche Termin 3 – Anfrage aus der Liste nehmen");
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

async function gapsGet() { return jsonLesen("gaps", []); }
async function gapsSet(v) { await jsonSchreiben("gaps", v); }
async function notesGet() { return jsonLesen("notes", []); }
async function notesSet(v) { await jsonSchreiben("notes", v); }
