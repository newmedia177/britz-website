// api/_termin.mjs – Terminanfragen an den Inhaber melden
//
// Alex haengt an eine bestaetigte Terminabsprache zwei Marker:
//   [[TERMIN|JJJJ-MM-TTTHH:MM|Titel|Adresse]]   (Kalender-Karte im Widget)
//   [[KONTAKT|Name|Telefon]]                     (nur fuer das Team)
// Beide sieht der Kunde nie.

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION || "v25.0"}`;
const FENSTER_MS = 24 * 60 * 60 * 1000;   // WhatsApp-Antwortfenster
const MAX_OFFEN = 30;

export const RE_TERMIN = /\[\[TERMIN\|([^|]+)\|([^|]+)\|([^\]]+)\]\]/;
// Bestaetigter Termin. Wird erst gesetzt, wenn die Werkstatt zugesagt hat -
// vorher bekommt der Kunde bewusst KEINEN Kalendereintrag, sonst muesste er
// ihn bei einer Absage selbst wieder korrigieren.
export const RE_TERMIN_OK = /\[\[TERMIN_OK\|([^|]+)\|([^|]+)\|([^\]]+)\]\]/;
export const RE_KONTAKT = /\[\[KONTAKT\|([^|]*)\|([^\]]*)\]\]/;
// Kalkulationsdaten fuer den Inhaber: Schadensart | Fahrzeug | Fotos
export const RE_KVA = /\[\[KVA\|([^|]*)\|([^|]*)\|([^\]]*)\]\]/;

// Adresse der Termindatei. Eigener Endpunkt statt "data:"-Adresse, weil
// Letztere auf iPhone und iPad nicht zuverlaessig funktioniert.
export function icsAdresse(wann, titel, ort) {
  const basis = (process.env.SITE_URL || "https://www.autolackiererei-britz.de")
    .replace(/\/+$/, "");
  return basis + "/api/ics?t=" + encodeURIComponent(wann) +
         "&s=" + encodeURIComponent(titel) +
         "&l=" + encodeURIComponent(ort);
}

export function markerRaus(text) {
  return String(text || "")
    .replace(/\[\[[A-Z_]+\|[^\]]*\]\]/g, "")
    .replace(RE_TERMIN, "")
    .replace(RE_TERMIN_OK, "")
    .replace(RE_KONTAKT, "")
    .replace(RE_KVA, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- Upstash: offizielles Kommandoformat -------------------------
// Ein Befehl geht als JSON-Array an die Basis-URL, z. B.
// ["SET","schluessel","wert","EX",86400]. Das ist der dokumentierte Weg
// und arbeitet zuverlaessiger als Befehle im Pfad.
// Vercel benennt die Upstash-Zugaenge je nach Alter der Integration
// entweder UPSTASH_REDIS_REST_* oder KV_REST_API_*. Beide gelten.
export function speicherUrl() {
  return process.env.UPSTASH_REDIS_REST_URL ||
         process.env.KV_REST_API_URL || "";
}
export function speicherToken() {
  return process.env.UPSTASH_REDIS_REST_TOKEN ||
         process.env.KV_REST_API_TOKEN || "";
}

// Zeitlimit fuer alle Netzaufrufe. Ohne Limit kann ein haengender
// Dienst die ganze Antwort blockieren; das Widget sieht dann nur
// "Antwortet" und am Ende eine leere Blase.
export async function fetchMitZeit(url, optionen, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...(optionen || {}), signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
const SPEICHER_ZEITLIMIT_MS = 4000;
const NETZ_ZEITLIMIT_MS = 10000;   // WhatsApp, Resend

export async function redis(...befehl) {
  const url = speicherUrl();
  const tok = speicherToken();
  if (!url || !tok) return undefined;
  try {
    const r = await fetchMitZeit(url, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify(befehl.map(String))
    }, SPEICHER_ZEITLIMIT_MS);
    if (!r.ok) {
      console.error("upstash", r.status, await r.text().catch(() => ""));
      return undefined;
    }
    const j = await r.json();
    return j && Object.prototype.hasOwnProperty.call(j, "result") ? j.result : null;
  } catch (e) {
    console.error("upstash", e);
    return undefined;   // Fehler, nicht "leer"
  }
}

export async function jsonLesen(schluessel, standard) {
  const w = await redis("GET", schluessel);
  if (!w) return standard;
  try { return JSON.parse(w); } catch { return standard; }
}
export async function jsonSchreiben(schluessel, wert, sekunden) {
  const b = ["SET", schluessel, JSON.stringify(wert)];
  if (sekunden) b.push("EX", sekunden);
  return redis(...b);
}

// ---- WhatsApp senden ---------------------------------------------
// ---- Bild an eine Nummer schicken ---------------------------------
// Bei WhatsApp-Kunden reicht die Medien-Kennung: das Bild bleibt bei
// Meta liegen, wir speichern es nirgends. Fuer Web-Chat-Fotos laden wir
// es einmal hoch (siehe medienHochladen) und verschicken die Kennung.
export async function sendWABild(to, mediaId, unterschrift) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) return false;
  if (!mediaId) return false;
  try {
    const r = await fetchMitZeit(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "image",
        image: { id: String(mediaId), caption: String(unterschrift || "").slice(0, 1000) }
      })
    }, NETZ_ZEITLIMIT_MS);
    if (!r.ok) console.error("sendBild", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) {
    console.error("sendBild", e);
    return false;
  }
}

// Web-Chat-Foto (Base64) einmal bei WhatsApp ablegen, damit es an den
// Inhaber geschickt werden kann. Danach liegt es bei Meta, nicht bei uns.
export async function medienHochladen(base64) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) return null;
  try {
    const bin = Buffer.from(String(base64), "base64");
    if (!bin.length || bin.length > 4_000_000) return null;
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "image/jpeg");
    form.append("file", new Blob([bin], { type: "image/jpeg" }), "schaden.jpg");
    const r = await fetchMitZeit(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: form
    }, NETZ_ZEITLIMIT_MS);
    if (!r.ok) {
      console.error("upload", r.status, await r.text().catch(() => ""));
      return null;
    }
    const j = await r.json();
    return j.id || null;
  } catch (e) {
    console.error("upload", e);
    return null;
  }
}

// ---- Notweg per E-Mail --------------------------------------------
// WhatsApp laesst frei formulierte Nachrichten nur innerhalb von 24
// Stunden nach der letzten Nachricht des Empfaengers zu. Schreibt der
// Inhaber laenger nichts, kaeme eine Terminmeldung sonst STILL nicht an.
// Greift nur, wenn RESEND_API_KEY gesetzt ist - sonst passiert nichts.
// ---- Anfrage an die KI ------------------------------------------------
// Die Modelle der 5er-Reihe "denken" von sich aus vor jeder Antwort, und
// dieses Nachdenken zaehlt in max_tokens mit. Bei knappen Grenzen (700 im
// Web-Chat, 900 auf WhatsApp, 1800 in der Lernrunde) blieb dann fuer den
// eigentlichen Text oft nichts uebrig: leere Antworten (Fehlerliste
// "Bloecke=thinking, stop_reason=max_tokens") und eine Lernrunde, die seit
// September nie lief. Alex braucht dieses Vorab-Nachdenken nicht; er
// antwortet ohne schneller und vollstaendig.
//   Sonnet 5 und Aehnliche:  thinking { type: "disabled" }
//   Sonnet 5.5:              thinking { type: "between_tools" } (disabled = Fehler 400)
// Lehnt ein Modell die Einstellung ab, geht dieselbe Anfrage noch einmal
// ohne raus, dann mit doppeltem Spielraum.
export function ohneVorabDenken(modell) {
  const m = String(modell || "");
  if (/5[-.]5|5[-.][6-9]/.test(m)) return { type: "between_tools" };
  if (/claude-(sonnet|opus|haiku|fable|mythos)-5\b|-5$/.test(m)) return { type: "disabled" };
  return null;          // aeltere Modelle denken ohnehin nicht von selbst
}

export async function kiRufen(body, zeitMs) {
  const kopf = {
    "content-type": "application/json",
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01"
  };
  const denken = ohneVorabDenken(body.model);
  const mit = denken && !body.thinking ? { ...body, thinking: denken } : body;
  let r = await fetchMitZeit("https://api.anthropic.com/v1/messages", { method: "POST", headers: kopf, body: JSON.stringify(mit) }, zeitMs);
  if (r.status === 400 && mit !== body) {
    const t = await r.clone().text().catch(() => "");
    if (/thinking/i.test(t)) {
      console.error("KI lehnt thinking-Einstellung ab, zweiter Versuch ohne", t.slice(0, 160));
      const ohne = { ...body, max_tokens: Math.max(body.max_tokens || 1000, 1000) * 2 };
      r = await fetchMitZeit("https://api.anthropic.com/v1/messages", { method: "POST", headers: kopf, body: JSON.stringify(ohne) }, zeitMs);
    }
  }
  return r;
}

export async function sendMail(betreff, text, empfaenger) {
  const key = process.env.RESEND_API_KEY;
  const an = empfaenger || process.env.NOTFALL_MAIL || "schaden@alb.berlin";
  if (!key) return false;
  try {
    const r = await fetchMitZeit("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`
      },
      body: JSON.stringify({
        from: process.env.MAIL_ABSENDER || "Alex <alex@autolackiererei-britz.de>",
        to: [an],
        subject: String(betreff).slice(0, 150),
        text: String(text).slice(0, 8000)
      })
    }, NETZ_ZEITLIMIT_MS);
    if (!r.ok) console.error("mail", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) {
    console.error("mail", e);
    return false;
  }
}

export async function sendWA(to, body) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) return false;
  try {
    const r = await fetchMitZeit(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
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
        text: { preview_url: false, body: String(body).slice(0, 4000) }
      })
    }, NETZ_ZEITLIMIT_MS);
    if (!r.ok) { console.error("send", r.status, await r.text().catch(() => "")); return false; }
    const id = await kennungAus(r);
    await sendungMerken(id, { to, text: String(body).slice(0, 3900) });
    return id;
  } catch (e) {
    console.error("send", e);
    return false;
  }
}

// WhatsApp antwortet mit der Kennung der verschickten Nachricht. Wir
// geben sie zurueck (immer "wahr"), damit eine spaetere Antwort von Dirk
// auf genau diese Nachricht der richtigen Anfrage zugeordnet werden kann.
async function kennungAus(r) {
  try { const j = await r.json(); return (j && j.messages && j.messages[0] && j.messages[0].id) || true; }
  catch (_) { return true; }
}
// Was an wen ging, drei Tage lang, damit eine spaete Fehlermeldung von
// WhatsApp zugeordnet werden kann.
async function sendungMerken(id, info) {
  if (typeof id !== "string") return;
  await redis("SET", "wa:out:" + id, JSON.stringify({ ...info, ts: Date.now() }), "EX", 3 * 86400);
}

// ---- Nachricht mit bis zu drei Antwort-Knoepfen ----------------------
// Geht wie Freitext nur im 24-Stunden-Fenster. Grenzen von WhatsApp:
// Text hoechstens 1024 Zeichen, Knopf hoechstens 20 Zeichen.
export async function sendWAKnoepfe(to, text, knoepfe) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID) return false;
  const k = (knoepfe || []).filter(x => x && x.id && x.titel).slice(0, 3);
  if (!k.length) return sendWA(to, text);
  try {
    const r = await fetchMitZeit(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp", recipient_type: "individual", to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: String(text).slice(0, 1024) },
          action: { buttons: k.map(x => ({ type: "reply", reply: { id: String(x.id).slice(0, 200), title: String(x.titel).slice(0, 20) } })) }
        }
      })
    }, NETZ_ZEITLIMIT_MS);
    if (!r.ok) { console.error("knoepfe", r.status, await r.text().catch(() => "")); return false; }
    const id = await kennungAus(r);
    await sendungMerken(id, { to, text: String(text).slice(0, 1024), knoepfe: k });
    return id;
  } catch (e) { console.error("knoepfe", e && e.message); return false; }
}

// ---- "Gelesen" + "schreibt ..." --------------------------------------
// Der Kunde sieht sofort die blauen Haken und die Tipp-Anzeige (bis zu
// 25 Sekunden oder bis die Antwort kommt). Ohne das wirkt die Pause, in
// der die Antwort entsteht, wie Funkstille.
export async function sendWAGelesen(nachrichtId) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID || !nachrichtId) return false;
  try {
    const r = await fetchMitZeit(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: nachrichtId, typing_indicator: { type: "text" } })
    }, 4000);
    return r.ok;
  } catch (_) { return false; }
}

function nummernAus(s) {
  return String(s || "").split(",").map(x => x.replace(/\D/g, "")).filter(Boolean);
}
// ---- Das 24-Stunden-Fenster der Inhaber ---------------------------------
// Jede Nachricht von Dirk (auch ein Knopf-Tipp) oeffnet es fuer 24 Std.
// Wir merken uns den Zeitpunkt. Ist das Fenster sicher zu, versucht Alex
// es gar nicht erst frei, sondern hebt auf und stupst per Vorlage oder
// E-Mail an. Nur wenn wir es nicht wissen (vor der ersten Nachricht nach
// diesem Update), wird frei versucht; scheitert das, meldet WhatsApp es
// spaeter und zustellungGescheitert() holt es nach.
export async function inhaberHatGeschrieben(n) {
  await redis("SET", "inhaber:fenster:" + n, String(Date.now()), "EX", 60 * 86400);
}
async function inhaberFenster(n) {
  const w = await redis("GET", "inhaber:fenster:" + n);
  if (w === undefined || w === null) return "unbekannt";
  return Date.now() - Number(w) < 23.5 * 3600000 ? "offen" : "zu";
}

// Wer Kundenmeldungen bekommt (Dirk).
export function inhaberNummern() {
  return nummernAus(process.env.OWNER_NUMBERS);
}
// Wer Technik- und Lernmeldungen bekommt. Ohne eigene Einstellung
// dieselben wie oben. Mit TECHNIK_NUMMERN bleibt Dirk davon verschont.
export function technikNummern() {
  const t = nummernAus(process.env.TECHNIK_NUMMERN);
  return t.length ? t : inhaberNummern();
}
// Wer Befehle geben darf.
export function berechtigteNummern() {
  return [...new Set([...inhaberNummern(), ...nummernAus(process.env.TECHNIK_NUMMERN)])];
}

// ---- Zustellung an den Inhaber, dreistufig -------------------------
// Warum: WhatsApp erlaubt freie Nachrichten nur bis 24 Stunden nach der
// letzten Nachricht des Empfaengers. Schreibt Dirk einen Tag lang nicht,
// blockt Meta jede Meldung an ihn. Frueher kam sie dann erst an, wenn
// Dirk selbst schrieb - fuer ihn sah es aus, als melde sich Alex nie.
//
//   Stufe 1: frei senden (klappt, wenn Dirk in den letzten 24 h schrieb)
//   Stufe 2: Meldung aufheben und Dirk mit einer genehmigten Vorlage
//            anstupsen ("Neue Meldung von Alex: ..."). Tippt er auf
//            "Alles anzeigen", oeffnet das das Fenster und Alex liefert
//            alles Aufgehobene nach (inhaberNachliefern).
//   Stufe 3: keine Vorlage oder Vorlage abgelehnt -> E-Mail.
// Pro Nummer hoechstens ein Anstupser alle 3 Stunden; alles dazwischen
// sammelt sich und kommt mit dem einen Tipp.
const ANSTUPSER_PAUSE_MS = 3 * 3600000;

// Meta erlaubt in Vorlagen-Feldern keine Zeilenumbrueche, Tabs und keine
// langen Leerzeichenketten.
export function vorlagenFeld(s, max = 200) {
  return String(s || "").replace(/[\r\n\t]+/g, " · ").replace(/\s{2,}/g, " ")
    .replace(/^[\s·]+|[\s·]+$/g, "").slice(0, max) || "neue Meldung";
}

export async function sendWAVorlage(to, name, params) {
  if (!process.env.WHATSAPP_TOKEN || !process.env.WHATSAPP_PHONE_ID || !name) return false;
  try {
    const r = await fetchMitZeit(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: { name, language: { code: "de" },
          components: [{ type: "body", parameters: (params || []).map(t => ({ type: "text", text: vorlagenFeld(t, 900) })) }] }
      })
    }, NETZ_ZEITLIMIT_MS);
    if (!r.ok) console.error("vorlage", name, r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("vorlage", e && e.message); return false; }
}

// Aussetzer mit Uhrzeit und Grund merken (fuer "Status").
export async function fehlerLog(art, grund) {
  try {
    const l = await jsonLesen("fehlerlog", []);
    l.push({ ts: Date.now(), art, grund: String(grund || "").slice(0, 160) });
    await jsonSchreiben("fehlerlog", l.slice(-30));
  } catch (_) {}
}

// Eine Meldung frei verschicken: mit Knoepfen, wenn welche dabei sind.
// Ist der Text fuer eine Knopf-Nachricht zu lang, kommt erst der Text und
// dann eine kurze Zeile mit den Knoepfen.
async function freiSenden(n, text, knoepfe) {
  const t = String(text).slice(0, 3900);
  if (!knoepfe || !knoepfe.length) return sendWA(n, t);
  if (t.length <= 1024) {
    const mitKnopf = await sendWAKnoepfe(n, t, knoepfe);
    if (mitKnopf) return mitKnopf;
    // Lehnt WhatsApp die Knopf-Nachricht ab, obwohl das Fenster offen ist,
    // kommt der Text eben ohne Knoepfe. Lieber so als gar nicht.
    const ohne = await sendWA(n, t);
    if (ohne) await fehlerLog("knoepfe", "Karte ging nur ohne Knöpfe raus");
    return ohne;
  }
  const id = await sendWA(n, t);
  if (!id) return false;
  await sendWAKnoepfe(n, t.split("\n")[0].slice(0, 200), knoepfe);
  return id;
}
// Kennung einer Karte merken: Antwortet Dirk direkt auf diese Nachricht,
// weiss Alex, um welche Anfrage es geht.
async function karteMerken(id, akteNr) {
  if (akteNr && typeof id === "string") await redis("SET", "karte:" + id, String(akteNr), "EX", 21 * 86400);
}

export async function zustellenAnInhaber(text, { kurz, art = "meldung", bilder = [], knoepfe = null, akteNr = 0 } = {}) {
  const nummern = art === "technik" ? technikNummern() : inhaberNummern();
  if (!nummern.length) return false;
  let irgendwo = false;

  for (const n of nummern) {
    const eintrag = { text: String(text).slice(0, 3900), bilder: bilder || [], knoepfe: knoepfe || null, akteNr: akteNr || 0, kurz: kurz || "", art };
    // Stufe 1: frei, wenn das Fenster offen ist oder wir es nicht wissen
    if ((await inhaberFenster(n)) !== "zu") {
      const id = await freiSenden(n, text, knoepfe);
      if (id) {
        await karteMerken(id, akteNr);
        // Fuer den Fall, dass WhatsApp spaeter "nicht zugestellt" meldet
        await sendungMerken(id, { to: n, inhaber: true, eintrag });
        for (const b of (bilder || [])) await sendWABild(n, b, vorlagenFeld(kurz || String(text).split("\n")[0], 120));
        irgendwo = true;
        continue;
      }
    }
    if (await aufhebenUndAnstupsen(n, eintrag)) irgendwo = true;
  }
  return irgendwo;
}

// Stufe 2 und 3: aufheben, per Vorlage anstupsen, sonst E-Mail.
async function aufhebenUndAnstupsen(n, eintrag) {
  const art = eintrag.art || "meldung";
  const titel = vorlagenFeld(eintrag.kurz || String(eintrag.text).split("\n")[0], 120);
  const liste = await jsonLesen("unzugestellt:" + n, []);
  // Eine Karte je Anfrage: die neuere ersetzt die aeltere (Fotos bleiben)
  let rest = liste;
  let fotos = eintrag.bilder || [];
  if (eintrag.akteNr) {
    const alt = liste.filter(e => e.akteNr === eintrag.akteNr);
    fotos = [...new Set([...alt.flatMap(e => e.bilder || []), ...fotos])];
    rest = liste.filter(e => e.akteNr !== eintrag.akteNr);
  }
  rest.push({ text: eintrag.text, bilder: fotos, knoepfe: eintrag.knoepfe || null, akteNr: eintrag.akteNr || 0, ts: Date.now() });
  await jsonSchreiben("unzugestellt:" + n, rest.slice(-40), 14 * 86400);

  const vorlage = art === "tagesstart"
    ? (process.env.WA_VORLAGE_TAGESSTART || process.env.WA_VORLAGE_INHABER)
    : process.env.WA_VORLAGE_INHABER;
  if (vorlage) {
    const zuletzt = Number(await redis("GET", "anstupser:" + n)) || 0;
    if (Date.now() - zuletzt < ANSTUPSER_PAUSE_MS) return true;   // kommt mit dem naechsten Tipp
    if (await sendWAVorlage(n, vorlage, [titel])) {
      await redis("SET", "anstupser:" + n, String(Date.now()), "EX", 86400);
      return true;
    }
    await fehlerLog("vorlage", "Vorlage " + vorlage + " von WhatsApp abgelehnt");
  }

  // Stufe 3: E-Mail. Mehrere Meldungen kurz hintereinander kommen als eine
  // Mail, nicht als zehn: hoechstens eine je Empfaenger und Stunde, der
  // Rest steht beim naechsten Mal mit drin.
  const mailSperre = await redis("SET", "mailsperre:" + n, "1", "NX", "EX", 3600);
  if (mailSperre === null) return true;
  const offen = await jsonLesen("unzugestellt:" + n, []);
  const ok = await sendMail("Alex: " + (offen.length > 1 ? offen.length + " Meldungen für dich" : titel.slice(0, 80)),
    offen.map(e => e.text).join("\n\n────────\n\n") +
    "\n\n────────\nDiese Meldung kam per E-Mail, weil WhatsApp sie gerade " +
    "nicht zustellen konnte (WhatsApp lässt Alex nur schreiben, wenn du ihm in den letzten 24 Stunden geschrieben hast). " +
    "Sobald du Alex kurz schreibst, kommt alles auch dort an, mit Fotos und Knöpfen.",
    art === "technik" ? (process.env.TECHNIK_MAIL || process.env.NOTFALL_MAIL) : undefined);
  if (!ok) {
    await redis("DEL", "mailsperre:" + n);
    await fehlerLog("zustellung", "Meldung an Inhaber weder per WhatsApp noch per E-Mail zugestellt: " + titel);
  }
  return ok;
}

// WhatsApp meldet per Webhook, dass eine Nachricht NICHT zugestellt wurde.
// Rueckgabe: null, oder { kunde, text } wenn es eine Kundennachricht war
// (die behandelt api/_anfragen.mjs).
export async function zustellungGescheitert(id, code, grund) {
  const roh = await redis("GETDEL", "wa:out:" + id);
  if (!roh) return null;
  let info = null;
  try { info = JSON.parse(roh); } catch (_) { return null; }
  if (!info || !info.to) return null;
  const istInhaber = berechtigteNummern().includes(String(info.to));
  if (istInhaber) {
    // Fenster ist offensichtlich zu: ab jetzt gleich den sicheren Weg
    await redis("SET", "inhaber:fenster:" + info.to, "0", "EX", 60 * 86400);
    const eintrag = info.eintrag || { text: info.text || "", bilder: [], knoepfe: info.knoepfe || null, akteNr: 0, kurz: "", art: "meldung" };
    await aufhebenUndAnstupsen(String(info.to), eintrag);
    return null;
  }
  await fehlerLog("kunde-nicht-zugestellt", "WhatsApp an Kunde …" + String(info.to).slice(-4) + " nicht zugestellt (" + code + (grund ? ", " + String(grund).slice(0, 60) : "") + ")");
  return { kunde: String(info.to), text: info.text || "", code };
}

// Alles Aufgehobene ausliefern, sobald der Inhaber schreibt (dann ist das
// 24-Stunden-Fenster offen). Rueckgabe: Anzahl ausgelieferter Meldungen.
export async function inhaberNachliefern(n) {
  const liste = await jsonLesen("unzugestellt:" + n, []);
  if (!liste.length) return 0;
  let geliefert = 0;
  for (const e of liste) {
    const kopf = liste.length > 1 ? "📬 Liegengeblieben (" + (geliefert + 1) + "/" + liste.length + ")\n" : "📬 Liegengeblieben\n";
    const id = await freiSenden(n, kopf + e.text, e.knoepfe);
    if (!id) break;
    await karteMerken(id, e.akteNr);
    for (const b of (e.bilder || [])) await sendWABild(n, b, vorlagenFeld(e.text.split("\n")[0], 120));
    geliefert++;
  }
  await jsonSchreiben("unzugestellt:" + n, liste.slice(geliefert), 14 * 86400);
  if (geliefert) await redis("DEL", "anstupser:" + n);
  return geliefert;
}

// ---- Datum lesbar machen ------------------------------------------
// Die Markerzeit ist bereits Berliner Ortszeit und darf NICHT ueber die
// Zeitzone umgerechnet werden. Sonst verschiebt sie sich auf Servern,
// die in UTC laufen (aus 11:00 wurde so 13:00).
const WOCHENTAGE = ["Sonntag","Montag","Dienstag","Mittwoch","Donnerstag","Freitag","Samstag"];
const MONATE = ["Januar","Februar","März","April","Mai","Juni","Juli",
                "August","September","Oktober","November","Dezember"];

// ---- Kundenfotos an den Inhaber weiterleiten -----------------------
// Dirk sieht die Werkstatt-Nummer nicht in seinem eigenen WhatsApp - die
// Nachrichten laufen ueber die Schnittstelle zu Alex. Ohne diese
// Weiterleitung bekaeme er Schadensfotos und Fahrzeugschein nie zu
// Gesicht, obwohl er genau die fuer den Kostenvoranschlag braucht.
//
// Wichtig: Es wird nichts bei uns gespeichert. Bei WhatsApp-Kunden wird
// nur die Medien-Kennung weitergereicht, bei Web-Chat-Fotos das Bild
// einmal an WhatsApp uebergeben. Das Archiv bleibt bewusst aussen vor.
// Rufnummer auf Plausibilitaet pruefen. Deutsche Nummern haben nach
// dem Normalisieren (ohne fuehrende 0 bzw. +49) etwa 9 bis 12 Ziffern;
// Mobilfunk 15x/16x/17x. Wir blockieren NIE, wir warnen nur.
export function rufnummerPruefen(roh) {
  const nurZiffern = String(roh || "").replace(/[^\d+]/g, "");
  if (!nurZiffern) return { ok: false, hinweis: "" };
  let n = nurZiffern.replace(/^\+/, "");
  if (n.startsWith("0049")) n = n.slice(4);
  else if (n.startsWith("49") && n.length > 11) n = n.slice(2);
  else if (n.startsWith("0")) n = n.slice(1);
  if (n.length < 9)  return { ok: false, hinweis: "Nummer wirkt zu kurz" };
  if (n.length > 12) return { ok: false, hinweis: "Nummer wirkt zu lang, bitte prüfen" };
  return { ok: true, hinweis: "" };
}

// Die vier Kalkulationsangaben als kurze Notiz, damit sie auch bei
// reinen Kostenvoranschlag-Anfragen (ohne Termin) beim Inhaber landen.
export function kvaNotiz(antwort) {
  const m = String(antwort || "").match(RE_KVA);
  if (!m) return "";
  return [
    (m[1] || "").trim() ? "Schadensart: " + m[1].trim().slice(0, 60) : "",
    (m[2] || "").trim() ? "Fahrzeug: " + m[2].trim().slice(0, 120) : "",
    (m[3] || "").trim() ? "Fotos: " + m[3].trim().slice(0, 60) : ""
  ].filter(Boolean).join("\n");
}

export async function leiteBilderWeiter({ kanal, mediaIds, base64Bilder, name, tel, hinweis }) {
  const nummern = inhaberNummern();
  if (!nummern.length) return false;

  const wer = [
    kanal === "whatsapp" ? "WhatsApp" : "Website-Chat",
    name && name !== "Name nicht genannt" ? name : null,
    tel ? tel + (rufnummerPruefen(tel).hinweis ? " (" + rufnummerPruefen(tel).hinweis + ")" : "") : null
  ].filter(Boolean).join(" · ");
  const unterschrift = wer + (hinweis ? "\n" + String(hinweis).slice(0, 300) : "");

  // Bei WhatsApp reicht die vorhandene Kennung, bei Web muss das Bild
  // einmal hochgeladen werden.
  let ids = Array.isArray(mediaIds) ? mediaIds.filter(Boolean) : [];
  if (!ids.length && Array.isArray(base64Bilder)) {
    for (const b of base64Bilder.slice(0, 4)) {
      const id = await medienHochladen(b);
      if (id) ids.push(id);
    }
  }
  if (!ids.length) return false;

  // Ruhezeit: Bilder nicht mitten in der Nacht schicken. Wir merken den
  // Vorgang vor; die Bilder selbst holt sich der Inhaber über die
  // Terminanfrage oder der Kunde schickt sie erneut. Gespeichert wird
  // weiterhin nichts.
  if (istRuhezeit()) {
    await warteschlangeAnhaengen(
      "Fotos eingegangen\n" + wer +
      (hinweis ? "\n" + String(hinweis).slice(0, 200) : "") +
      "\n(" + ids.length + " Bild(er), kommen gleich)", ids);
    return true;
  }

  // Fotos zuerst frei senden; klappt das nicht, uebernimmt die
  // dreistufige Zustellung (Bilder werden mit aufgehoben).
  let zugestellt = false;
  for (const n of nummern) {
    for (let i = 0; i < ids.length; i++) {
      const bu = ids.length > 1
        ? unterschrift + "\n(Bild " + (i + 1) + " von " + ids.length + ")"
        : unterschrift;
      if (await sendWABild(n, ids[i], bu)) zugestellt = true;
    }
  }
  if (!zugestellt) {
    zugestellt = await zustellenAnInhaber("📷 Kunde hat Fotos geschickt\n" + unterschrift,
      { kurz: "Fotos von " + (name && name !== "Name nicht genannt" ? name : "einem Kunden"), bilder: ids });
  }
  return zugestellt;
}

// ---- Belegte Zeiten -------------------------------------------------
// Fuer eine kurze Besichtigung rechnen wir 30 Minuten. Ein neuer Termin
// darf sich damit nicht ueberschneiden - sonst stehen zwei Kunden
// gleichzeitig auf dem Hof.
export const TERMIN_DAUER_MIN = 30;

export async function belegteZeiten() {
  const liste = await jsonLesen("termine", []);
  const jetzt = Date.now();
  return liste
    .filter(e => e.wann && !e.abgesagt)
    // Vergangene Termine blockieren nichts mehr
    .filter(e => {
      const d = new Date(e.wann);
      return !isNaN(d.getTime()) && d.getTime() > jetzt - 86400000;
    })
    .map(e => e.wann);
}

// Liegt der Wunsch zu dicht an einem schon vergebenen Termin?
export function kollidiert(wunsch, belegt) {
  const a = new Date(wunsch).getTime();
  if (isNaN(a)) return false;
  return belegt.some(w => {
    const b = new Date(w).getTime();
    return !isNaN(b) && Math.abs(a - b) < TERMIN_DAUER_MIN * 60000;
  });
}

// ---- Ruhezeiten für den Inhaber -------------------------------------
// Nachts keine Meldungen. Am Wochenende dagegen schon – Dirk schaut
// dann durchaus rein, nur mitten in der Nacht soll es still bleiben.
//
// Wichtig zur Ehrlichkeit: Ein Server verschickt nichts von selbst um
// 8 Uhr. Die gesammelten Meldungen gehen raus, sobald morgens die erste
// Aktivität stattfindet (Dirk schreibt oder ein Kunde meldet sich).
export const RUHE_VON = 17;   // ab 17 Uhr keine Meldungen mehr
export const RUHE_BIS = 8;    // erst ab 8 Uhr wieder

export function istRuhezeit(d = new Date()) {
  const std = Number(new Intl.DateTimeFormat("de-DE", {
    hour: "numeric", hourCycle: "h23", timeZone: "Europe/Berlin"
  }).formatToParts(d).find(p => p.type === "hour").value);
  return std < RUHE_BIS || std >= RUHE_VON;
}

// ---- Kleine Wochenzaehler (fuer Wochenbericht und Lernrunde) ----------
// Schluessel je Kalenderwoche (Montag), neun Wochen haltbar.
function wochenSchluessel(vorWochen = 0) {
  const d = new Date(new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7 * vorWochen);
  return d.toISOString().slice(0, 10);
}
export async function statPlus(name, n = 1) {
  const k = "stat:" + wochenSchluessel() + ":" + name;
  for (let i = 0; i < n; i++) await redis("INCR", k);
  await redis("EXPIRE", k, 63 * 86400);
}
export async function statLesen(name, vorWochen = 0) {
  return Number(await redis("GET", "stat:" + wochenSchluessel(vorWochen) + ":" + name)) || 0;
}

// Zurückgehaltene Meldungen ablegen. Eine Karte zu einer Anfrage ist eine
// Momentaufnahme: Kommt nachts eine neuere zur selben Anfrage, ersetzt
// sie die aeltere (Fotos bleiben erhalten). So liegt morgens pro Kunde
// genau eine Meldung da.
async function warteschlangeAnhaengen(text, bilder, extra = {}) {
  let liste = await jsonLesen("wartend", []);
  let fotos = Array.isArray(bilder) ? bilder.slice() : [];
  if (extra.akteNr) {
    const alt = liste.filter(e => e.akteNr === extra.akteNr);
    fotos = [...new Set([...alt.flatMap(e => e.bilder || []), ...fotos])];
    extra.prio = Math.max(extra.prio || 0, ...alt.map(e => e.prio || 0));
    liste = liste.filter(e => e.akteNr !== extra.akteNr);
  }
  liste.push({ text, bilder: fotos, ts: Date.now(), ...extra });
  await jsonSchreiben("wartend", liste.slice(-30));
}

// Meldung an den Inhaber: tagsueber sofort, in der Ruhezeit in die
// Morgen-Sammlung. Optionen wie zustellenAnInhaber, dazu prio (2 = dringend).
export async function meldenOderAufheben(text, opts = {}) {
  if (istRuhezeit()) {
    await warteschlangeAnhaengen(text, opts.bilder, {
      knoepfe: opts.knoepfe || null, akteNr: opts.akteNr || 0, kurz: opts.kurz || "",
      prio: opts.prio || 0, art: opts.art || "meldung"
    });
    return true;
  }
  return zustellenAnInhaber(text, opts);
}

// Beim nächsten Kontakt in der Bürozeit alles Zurückgehaltene zustellen.
// Wird vom Wecker und bei jeder eingehenden Nachricht aufgerufen.
export async function warteschlangeZustellen() {
  if (istRuhezeit()) return false;
  if (!inhaberNummern().length) return false;
  // Lesen und Leeren in einem Schritt, damit zwei gleichzeitige Aufrufe
  // (Wecker und Kundennachricht) nicht doppelt zustellen.
  let roh = await redis("GETDEL", "wartend");
  if (roh === undefined) {                  // Befehl nicht verfuegbar: der alte Weg
    roh = await redis("GET", "wartend");
    if (roh === undefined) return false;
    await redis("DEL", "wartend");
  }
  let liste = [];
  try { liste = JSON.parse(roh || "[]") || []; } catch (_) {}
  if (!liste.length) return false;

  const karten = liste.filter(e => e.akteNr || e.knoepfe || e.art === "technik");
  const einfach = liste.filter(e => !karten.includes(e));
  let ok = false;

  // Karten einzeln, Dringendes zuerst: je Kunde eine Nachricht mit Knoepfen
  karten.sort((a, b) => (b.prio || 0) - (a.prio || 0) || a.ts - b.ts);
  for (const e of karten) {
    ok = (await zustellenAnInhaber("🌙 " + e.text, {
      kurz: e.kurz || undefined, bilder: e.bilder || [], knoepfe: e.knoepfe || null,
      akteNr: e.akteNr || 0, art: e.art || "meldung"
    })) || ok;
  }

  if (einfach.length) {
    const kopf = einfach.length === 1
      ? "🌙 Kam heute Nacht rein:\n────────\n"
      : "🌙 Kam heute Nacht rein (" + einfach.length + " Meldungen):\n" +
        "────────\n";
    const text = kopf + einfach.map(e => e.text).join("\n\n────────\n");
    ok = (await zustellenAnInhaber(text, {
      kurz: einfach.length === 1 ? String(einfach[0].text || "").split("\n")[0] : einfach.length + " Meldungen aus der Nacht",
      bilder: einfach.flatMap(e => e.bilder || [])
    })) || ok;
  }
  return ok;
}

// ---- Angefangene, nicht beendete Gespraeche -------------------------
// Frueher bekam Dirk dafuer eine eigene Meldung ("Angefangen, nicht zu
// Ende gefuehrt"), losgeloest von der Anfrage und oft ohne Namen. Jetzt
// gilt:
//   - WhatsApp: Jede Unterhaltung hat eine Akte. Ob sie haengt und was
//     dann passiert, entscheidet die Fallpflege (api/_anfragen.mjs), und
//     Dirk bekommt EINE Karte pro Kunde.
//   - Website mit Rueckweg (Nummer, E-Mail) oder Fotos: ebenfalls Akte.
//   - Website ohne Rueckweg: Niemand kann etwas tun. Das wird nur noch
//     gezaehlt (Wochenbericht, Lernrunde), nicht mehr gemeldet.
const OFFEN_REIF_MIN = 25;    // so lange Stille, dann gilt es als liegengeblieben
const OFFEN_TTL_TAGE = 3;

export async function gespraechMerken({ sitzung, kanal, name, tel, thema, fotos, abgeschlossen }) {
  if (!sitzung || kanal !== "web") return;
  const schluessel = "offen:" + sitzung;
  if (abgeschlossen) {
    // Termin gemeldet oder Kontakt weitergegeben: nichts mehr offen.
    await redis("DEL", schluessel);
    const idx = (await jsonLesen("offen:index", [])).filter(s => s !== sitzung);
    await jsonSchreiben("offen:index", idx);
    return;
  }
  let alt = {};
  try { alt = JSON.parse(await redis("GET", schluessel)) || {}; } catch (_) {}
  const eintrag = {
    kanal,
    name: (name || alt.name || "").slice(0, 60),
    tel: (tel || alt.tel || "").slice(0, 40),
    thema: (thema || alt.thema || "").slice(0, 160),
    fotos: (alt.fotos || 0) + (fotos || 0),
    zuege: (alt.zuege || 0) + 1,
    beginn: alt.beginn || Date.now(),
    ts: Date.now()
  };
  await redis("SET", schluessel, JSON.stringify(eintrag), "EX", OFFEN_TTL_TAGE * 86400);
  const idx = await jsonLesen("offen:index", []);
  if (!idx.includes(sitzung)) {
    idx.push(sitzung);
    await jsonSchreiben("offen:index", idx.slice(-80));
  }
}

// Wird vom Wecker (api/cron.js) aufgerufen. Zaehlt Website-Besucher, die
// ohne Rueckweg gegangen sind. Rueckgabe: Anzahl.
export async function offeneGespraecheMelden() {
  const idx = await jsonLesen("offen:index", []);
  if (!idx.length) return 0;
  const jetzt = Date.now();
  const bleibt = [];
  let gegangen = 0;

  for (const s of idx) {
    let e = null;
    try { e = JSON.parse(await redis("GET", "offen:" + s)); } catch (_) {}
    if (!e) continue;                                  // abgelaufen oder abgeschlossen
    if (jetzt - e.ts < OFFEN_REIF_MIN * 60000) { bleibt.push(s); continue; }
    if (e.zuege >= 2 && !e.fotos && !e.tel) gegangen++;   // echtes Anliegen, kein Rueckweg
    await redis("DEL", "offen:" + s);
  }
  if (gegangen) await statPlus("abbruchWeb", gegangen);
  await jsonSchreiben("offen:index", bleibt);
  return gegangen;
}

export function datumLesbar(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(iso || "");
  const j = +m[1], mo = +m[2], t = +m[3], st = +m[4], mi = +m[5];
  const wt = WOCHENTAGE[new Date(Date.UTC(j, mo - 1, t)).getUTCDay()];
  return wt + ", " + t + ". " + MONATE[mo - 1] + ", " +
    String(st).padStart(2, "0") + ":" + String(mi).padStart(2, "0") + " Uhr";
}

// ---- Terminanfrage an den Inhaber melden --------------------------
export async function meldeTermin({ antwort, kanal, kundeNr, thema, ersatzName }) {
  const mT = String(antwort || "").match(RE_TERMIN);
  if (!mT) return false;

  const mK = String(antwort || "").match(RE_KONTAKT);
  // Der vom Kunden genannte Name zaehlt. Der WhatsApp-Profilname ist oft
  // nur ein Kuerzel ("JW") und wird deshalb nur als Notbehelf verwendet,
  // klar als solcher gekennzeichnet.
  const echterName = ((mK && mK[1]) || "").trim();
  const profil = String(ersatzName || "").trim();
  const name = echterName ||
    (profil ? profil + " (nur WhatsApp-Profilname)" : "");
  const mV = String(antwort || "").match(RE_KVA);
  const kvaArt  = ((mV && mV[1]) || "").trim();
  const kvaFzg  = ((mV && mV[2]) || "").trim();
  const kvaFoto = ((mV && mV[3]) || "").trim();
  let tel = ((mK && mK[2]) || "").trim();
  if (!tel && kanal === "whatsapp" && kundeNr) tel = "+" + String(kundeNr);

  const nummern = inhaberNummern();
  if (!nummern.length) return false;

  const liste = await jsonLesen("termine", []);
  const wann = mT[1].trim();

  // Gibt es zu diesem Kunden schon eine frische Anfrage?
  const gleicherKunde = e =>
    kanal === "whatsapp"
      ? e.kundeNr === String(kundeNr || "")
      : (e.tel && e.tel === tel);
  const vorhanden = liste.filter(g =>
    gleicherKunde(g) && Date.now() - (g.ts || 0) < FENSTER_MS).pop();

  if (vorhanden) {
    // Gleiche Zeit -> nur eine Wiederholung, nichts tun.
    if (vorhanden.wann === wann) {
      console.log("termin: Dublette zu Nr." + vorhanden.nr + " ignoriert");
      return false;
    }
    // Andere Zeit -> Aenderung. Kein neuer Vorgang, sondern eine
    // Aktualisierung, damit der Inhaber nicht mehrere Zettel zum
    // selben Termin bekommt.
    const alteZeit = vorhanden.wann;
    vorhanden.wann = wann;
    vorhanden.ts = Date.now();
    if (name) vorhanden.name = name;
    await jsonSchreiben("termine", liste.slice(-MAX_OFFEN));
    const text =
      "Änderung zur Terminanfrage Nr. " + vorhanden.nr + "\n" +
      "────────\n" +
      "Kunde: " + vorhanden.name + "\n" +
      (vorhanden.tel ? "Telefon: " + vorhanden.tel + "\n" : "") +
      "Bisher: " + datumLesbar(alteZeit) + "\n" +
      "Neu: " + datumLesbar(wann) + "\n\n" +
      (vorhanden.kanal === "whatsapp"
        ? "Antworten Sie mit \"Termin " + vorhanden.nr + " passt\"."
        : "Kam über die Website, bitte selbst melden.");
    await zustellenAnInhaber(text, { kurz: "Terminänderung Nr. " + vorhanden.nr });
    return true;
  }

  const nr = (liste.length ? (liste[liste.length - 1].nr || 0) : 0) + 1;
  const eintrag = {
    nr,
    name: name || "Name nicht genannt",
    tel, kanal,
    kundeNr: kanal === "whatsapp" ? String(kundeNr || "") : "",
    wann,
    // Fuer den Kalendereintrag nach der Bestaetigung
    titel: (mT[2] || "").trim() || "Termin, Autolackiererei in Britz",
    ort: (mT[3] || "").trim() || "Haarlemer Straße 48-54, 12359 Berlin",
    ts: Date.now()
  };
  liste.push(eintrag);
  await jsonSchreiben("termine", liste.slice(-MAX_OFFEN));

  const kopf =
    "Neue Terminanfrage Nr. " + nr + "\n" +
    "────────\n" +
    "Kunde: " + eintrag.name + "\n" +
    (tel ? "Telefon: " + tel +
       (rufnummerPruefen(tel).hinweis ? " (" + rufnummerPruefen(tel).hinweis + ")" : "") +
       "\n" : "") +
    "Wunschtermin: " + datumLesbar(eintrag.wann) + "\n" +
    (thema ? "Anliegen: " + String(thema).slice(0, 140) + "\n" : "") +
    (kvaArt  ? "Schadensart: " + kvaArt.slice(0, 60) + "\n" : "") +
    (kvaFzg  ? "Fahrzeug: " + kvaFzg.slice(0, 120) + "\n" : "") +
    (kvaFoto ? "Fotos: " + kvaFoto.slice(0, 60) + "\n" : "");

  const fuss = kanal === "whatsapp"
    ? "\nKam über: WhatsApp\n" +
      "Bitte bestätigen, dann bekommt der Kunde die Zusage und einen\n" +
      "Kalendereintrag zum Antippen. Schreib mir dazu:\n" +
      "• \"Termin " + nr + " passt\"\n" +
      "• \"Termin " + nr + " lieber Donnerstag 10 Uhr\"\n" +
      "Ohne Rückmeldung bekommt der Kunde keine Bestätigung."
    : "\nKam über: Website-Chat\n" +
      "Den Kunden erreiche ich hier nicht mehr.\n" +
      "Bitte selbst zur Bestätigung melden" +
      (tel ? ", Nummer siehe oben." : " (keine Nummer hinterlegt).");

  const meldung = kopf + fuss;

  // Ruhezeit: nichts verschicken, sondern sammeln. Der Inhaber bekommt
  // alles beim nächsten Kontakt am Morgen.
  if (istRuhezeit()) {
    await warteschlangeAnhaengen(meldung);
    return true;
  }

  const zugestellt = await zustellenAnInhaber(meldung, { kurz: "Neue Terminanfrage Nr. " + nr });
  return true;
}

// ---- Antwort des Inhabers weiterleiten -----------------------------
// Nur eindeutige Formulierungen gelten als Terminantwort:
//   "Termin 3 passt"  ·  "Antwort 3: ..."  ·  "#3 passt"
// Eine blosse Zahl am Anfang reicht bewusst NICHT, sonst wuerde eine
// normale Nachricht wie "11 Uhr" faelschlich als Antwort gelesen.
export async function inhaberAntwort(vonInhaber, text) {
  const t = String(text || "").trim();
  const m = t.match(/^(?:termin|antwort|nr\.?|#)\s*(\d{1,3})\s*[:.,-]?\s+([\s\S]+)/i);
  if (!m) return false;

  const nr = parseInt(m[1], 10);
  const nachricht = m[2].trim();
  const liste = await jsonLesen("termine", []);
  const eintrag = liste.find(e => e.nr === nr);

  if (!eintrag) {
    await sendWA(vonInhaber,
      "Zu Nummer " + nr + " finde ich keine Anfrage. " +
      "Mit \"Termine\" zeige ich dir die offenen an.");
    return true;
  }

  if (eintrag.kanal !== "whatsapp" || !eintrag.kundeNr) {
    await sendWA(vonInhaber,
      "Anfrage " + nr + " kam über die Website. Dort kann ich nicht antworten.\n" +
      "Bitte ruf " + eintrag.name +
      (eintrag.tel ? " unter " + eintrag.tel : "") + " an.");
    return true;
  }

  if (Date.now() - (eintrag.ts || 0) > FENSTER_MS) {
    await sendWA(vonInhaber,
      "Anfrage " + nr + " ist älter als 24 Stunden. WhatsApp lässt mich dann " +
      "nicht mehr von sich aus schreiben.\n" +
      "Bitte meld dich direkt bei " + eintrag.name +
      (eintrag.tel ? " unter " + eintrag.tel : "") + ".");
    return true;
  }

  // Nur bei einer klaren Zusage bekommt der Kunde den Kalendereintrag.
  // Schlaegt der Inhaber eine andere Zeit vor oder sagt ab, waere ein
  // Eintrag falsch - dann bleibt es bei der reinen Textnachricht.
  const zusage = /\b(passt|geht klar|in ordnung|bestätigt|bestaetigt|ok|okay|klar|machen wir|passt so)\b/i.test(nachricht);
  const gegenvorschlag = /\b(lieber|statt|besser|geht nicht|leider|verschieb|anderer|andere zeit|absag|früher|später|frueher|spaeter)\b/i.test(nachricht)
    || /\d{1,2}[:.]\d{2}|\d{1,2}\s*uhr/i.test(nachricht);

  let kalender = "";
  if (zusage && !gegenvorschlag && eintrag.wann) {
    const basis = (process.env.SITE_URL || "https://www.autolackiererei-britz.de")
      .replace(/\/+$/, "");
    kalender = "\n\n📅 In den Kalender übernehmen:\n" + basis + "/api/ics?n=" + eintrag.nr;
  }

  // Eine nackte Zustage wie "passt" wirkt beim Kunden abgehackt. Kurze,
  // klare Bestaetigung daraus machen - der Inhaber soll schnell tippen
  // koennen, der Kunde trotzdem etwas Ordentliches lesen.
  const knapp = /^(passt|passt so|ok|okay|klar|geht klar|in ordnung|jo|ja)[.!]?$/i
    .test(nachricht.trim());

  let kundenText;
  if (zusage && !gegenvorschlag && eintrag.wann) {
    kundenText = "Ihr Termin ist bestätigt: " + datumLesbar(eintrag.wann) + ".\n" +
      (eintrag.ort ? eintrag.ort + "\n" : "") +
      (knapp ? "" : "\n" + nachricht + "\n") +
      "\nWir freuen uns auf Sie. Falls etwas dazwischenkommt, " +
      "melden Sie sich einfach hier.";
  } else {
    kundenText = "Kurze Rückmeldung aus der Werkstatt zu Ihrem Wunschtermin:\n\n" +
      nachricht;
  }

  const ok = await sendWA(eintrag.kundeNr, kundenText + kalender);

  // Die Rueckmeldung gehoert in den Gespraechsverlauf des Kunden.
  // Sonst weiss Alex beim naechsten Mal nichts davon und widerspricht
  // seiner eigenen Nachricht.
  if (ok) {
    try {
      const schluessel = "wa:" + eintrag.kundeNr;
      const verlauf = await jsonLesen(schluessel, []);
      verlauf.push({
        role: "assistant",
        content: "Rückmeldung aus der Werkstatt zum Termin: " + nachricht +
                 " (Das gilt ab jetzt als vereinbart.)"
      });
      await jsonSchreiben(schluessel, verlauf.slice(-16), 86400);
    } catch (e) { console.error("verlauf", e); }
  }

  await sendWA(vonInhaber, ok
    ? "Erledigt, ich habe es weitergegeben."
    : "Das Weiterleiten hat nicht geklappt. Bitte meld dich direkt bei " +
      eintrag.name + (eintrag.tel ? " unter " + eintrag.tel : "") + ".");
  return true;
}

// ---- Tagesbriefing fuer den Inhaber -------------------------------
// Wird hoechstens einmal pro Kalendertag ausgegeben. Fasst zusammen,
// was ansteht und wo der Inhaber selbst aktiv werden muss.
export async function tagesBriefing(inhaberNr) {
  const heute = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const schluessel = "briefing:" + inhaberNr;
  const zuletzt = await redis("GET", schluessel);
  if (zuletzt === heute) return "";             // heute schon begruesst
  await redis("SET", schluessel, heute, "EX", 172800);

  // ACHTUNG: toLocaleString("de-DE", {hour:"2-digit"}) liefert "12 Uhr",
  // nicht "12". Number() daraus ergibt NaN, wodurch frueher IMMER
  // "Guten Abend" herauskam - auch mittags. Deshalb direkt die Stunde
  // ueber formatToParts holen.
  const teile = new Intl.DateTimeFormat("de-DE", {
    hour: "numeric", hourCycle: "h23", timeZone: "Europe/Berlin"
  }).formatToParts(new Date());
  const stunde = Number((teile.find(p => p.type === "hour") || {}).value || 0);
  const monat = Number(new Intl.DateTimeFormat("de-DE", {
    month: "numeric", timeZone: "Europe/Berlin"
  }).format(new Date()));
  const abendAb = (monat >= 4 && monat <= 9) ? 18 : 17;   // Sommer/Winter
  const gruss = stunde < 11 ? "Guten Morgen"
              : (stunde < abendAb ? "Guten Tag" : "Guten Abend");

  const liste = await jsonLesen("termine", []);
  // Datensparsamkeit: Anfragen, die älter als 14 Tage sind, werden
  // endgültig gelöscht (Name und Rufnummer inklusive). Alex sagt dem
  // Kunden zu, dass die Nummer nur zur Terminabwicklung dient und ohne
  // Auftrag wieder verschwindet - diese Löschung deckt genau das ab.
  const AUFBEWAHRUNG = 14 * 86400000;
  const gesaeubert = liste.filter(e => Date.now() - (e.ts || 0) < AUFBEWAHRUNG);
  if (gesaeubert.length !== liste.length) {
    await jsonSchreiben("termine", gesaeubert);
  }
  const offen = gesaeubert.filter(e => Date.now() - (e.ts || 0) < 7 * 86400000);
  if (!offen.length) {
    return gruss + ". Aktuell liegt nichts Offenes an.";
  }

  // Was der Inhaber selbst tun muss, kommt zuerst
  const anrufen = offen.filter(e =>
    e.kanal !== "whatsapp" || Date.now() - (e.ts || 0) > FENSTER_MS);
  const perWA = offen.filter(e => !anrufen.includes(e));

  const zeilen = [];
  zeilen.push(gruss + ". " + offen.length +
    (offen.length === 1 ? " offene Terminanfrage:" : " offene Terminanfragen:"));

  for (const e of perWA) {
    zeilen.push("\nNr. " + e.nr + " · " + e.name + "\n" +
      datumLesbar(e.wann) + "\n" +
      "Über WhatsApp gekommen, ich kann antworten. " +
      "Sagen Sie \"Termin " + e.nr + " passt\".");
  }
  for (const e of anrufen) {
    const alt24 = e.kanal === "whatsapp";
    zeilen.push("\nNr. " + e.nr + " · " + e.name + "\n" +
      datumLesbar(e.wann) + "\n" +
      (alt24 ? "Älter als 24 Stunden, ich darf nicht mehr schreiben. "
             : "Kam über die Website, dort komme ich nicht mehr an. ") +
      "Bitte anrufen" + (e.tel ? ": " + e.tel : "") + ".");
  }
  return zeilen.join("\n");
}

// Eine Anfrage aus der Liste nehmen. Nummer oder "alle".
export async function terminLoeschen(was) {
  const liste = await jsonLesen("termine", []);
  if (!liste.length) return "Es sind keine Terminanfragen gespeichert.";

  if (/^alle?$/i.test(String(was).trim())) {
    await jsonSchreiben("termine", []);
    return "Erledigt, ich habe alle " + liste.length + " Anfragen gelöscht.";
  }

  const nr = parseInt(String(was).replace(/\D/g, ""), 10);
  const rest = liste.filter(e => e.nr !== nr);
  if (rest.length === liste.length) {
    return "Zu Nummer " + nr + " finde ich keine Anfrage. " +
           "Mit \"Termine\" zeige ich dir die offenen an.";
  }
  const weg = liste.find(e => e.nr === nr);
  await jsonSchreiben("termine", rest);
  return "Anfrage " + nr + " (" + weg.name + ", " +
         datumLesbar(weg.wann) + ") ist gelöscht.";
}

export async function terminListe() {
  const liste = await jsonLesen("termine", []);
  if (!liste.length) return "Aktuell keine offenen Terminanfragen.";
  return "Die letzten Terminanfragen:\n" +
    liste.slice(-10).reverse().map(e =>
      e.nr + ". " + e.name + " – " + datumLesbar(e.wann) +
      " (" + (e.kanal === "whatsapp" ? "WhatsApp" : "Website") + ")"
    ).join("\n") +
    "\n\nAntworten mit: \"Termin 1 passt\"\n" +
    "Löschen mit: \"Lösche Termin 1\" oder \"Lösche alle Termine\"";
}
