// api/whatsapp.js – Alex auf WhatsApp (Meta WhatsApp Cloud API)
//
// Benötigte Umgebungsvariablen:
//   WHATSAPP_TOKEN         Zugriffstoken der Meta-App
//   WHATSAPP_PHONE_ID      Phone Number ID der WhatsApp-Business-Nummer
//   WHATSAPP_VERIFY_TOKEN  Frei wählbares Geheimwort für die Webhook-Verifizierung
// Optional (Gesprächsgedächtnis + Lern-Modus, sehr empfohlen):
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   oder KV_REST_API_URL / KV_REST_API_TOKEN (neuere Vercel-Integration)
//   OWNER_NUMBERS          Kommagetrennt, international ohne + (z. B. 4917xxxxxxxx)
//   GRAPH_VERSION          Optional, Standard v25.0
//
// Webhook-URL in der Meta-App: https://<eure-domain>/api/whatsapp

import crypto from "node:crypto";
import { SYSTEM, KNOWLEDGE } from "./_bundle.mjs";
import { gespraechAblegen, gelerntBlock, lernBefehl, lernKennung } from "./_lernen.mjs";
import { anfrageBefehl, anfrageFortschreiben, akteKontext, fehlerZaehlen, weckerAufgaben, chefUeberblick, nachhakenAktiv,
         chefAkteKontext, nummerImText, karteAktion, antwortAufKarte, entwurfSenden, akteHolenOderAnlegen,
         akteFinden, akteAendern, gespraechAnhaengen, herzschlag, kundenZustellungGescheitert } from "./_anfragen.mjs";
import { buchungBefehl, buchungVerarbeiten, buchungKontext, RE_BUCHUNG } from "./_buchung.mjs";
import { spiegeln, kundeInUebernahme, uebernahmeKunde, uebernahmeBefehl, anUebernehmer } from "./_mitlesen.mjs";
import { logGapIfNeeded, saeubern, zeitKontext, RUECKMELDUNG } from "./chat.js";
import { meldeTermin, inhaberAntwort, terminListe, markerRaus,
         RE_TERMIN_OK, icsAdresse, belegteZeiten,
         warteschlangeZustellen, RE_KONTAKT, RE_KVA, RE_TERMIN,
         sendWA, sendWAKnoepfe, sendWAGelesen, sendWALinkKnopf, terminSeite, offeneGespraecheMelden, inhaberNachliefern,
         inhaberHatGeschrieben, zustellungGescheitert, kiRufen,
         berechtigteNummern, fetchMitZeit, fehlerLog,
         jsonLesen, jsonSchreiben, redis, datumLesbar,
         terminLoeschen,
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

  // ---- Kommt die Nachricht wirklich von Meta? ----------------------------
  // Ohne diese Pruefung koennte jeder, der die Adresse kennt, eine Nachricht
  // "von Dirk" vortaeuschen und z. B. mit "Angebot 7: …" Kunden anschreiben
  // lassen. Meta unterschreibt jeden Aufruf mit dem App-Geheimnis.
  // Aktiv, sobald WHATSAPP_APP_SECRET in Vercel steht.
  const start = Date.now();
  let koerper = null;
  const geheim = process.env.WHATSAPP_APP_SECRET;
  if (geheim) {
    const roh = await rohKoerper(req);
    if (roh && roh.length) {
      const soll = "sha256=" + crypto.createHmac("sha256", geheim).update(roh).digest("hex");
      const ist = String((req.headers && (req.headers["x-hub-signature-256"] || req.headers["X-Hub-Signature-256"])) || "");
      const passt = ist.length === soll.length && crypto.timingSafeEqual(Buffer.from(ist), Buffer.from(soll));
      if (!passt) {
        console.error("whatsapp: Aufruf ohne gültige Meta-Signatur abgewiesen");
        if ((await redis("SET", "einmal:signatur:" + new Date().toISOString().slice(0, 13), "1", "NX", "EX", 7200)) === "OK")
          await fehlerLog("signatur", "WhatsApp-Aufruf ohne gültige Meta-Signatur abgewiesen");
        res.status(401).end();
        return;
      }
      try { koerper = JSON.parse(roh.toString("utf8")); } catch (_) { koerper = null; }
    } else if ((await redis("SET", "einmal:signatur-roh:" + new Date().toISOString().slice(0, 10), "1", "NX", "EX", 2 * 86400)) === "OK") {
      await fehlerLog("signatur", "Meta-Signatur nicht prüfbar (Rohdaten fehlen), Aufruf trotzdem angenommen");
    }
  }

  // WICHTIG (Vercel): Die Funktion wird eingefroren, sobald die Antwort
  // gesendet ist. Deshalb erst ARBEITEN, dann 200 schicken. Meta wiederholt
  // den Aufruf bei Verzögerung – dagegen schützt die Dedupe-Prüfung unten.
  try {
    await verarbeite(koerper || req.body, start);
  } catch (e) {
    console.error("whatsapp handler", e);
  }
  res.status(200).json({ ok: true });   // Meta immer mit 200 bestätigen
}

// ---- Mehrere Nachrichten sammeln -------------------------------------
// Ein Kunde schickt selten EINE Nachricht: meist "Hallo", dann zwei Saetze,
// dann fuenf Fotos. WhatsApp liefert jede einzeln. Frueher hat Alex auf
// jede einzeln geantwortet (bei acht Fotos achtmal). Ein Mensch wartet
// kurz, bis alles da ist, und antwortet dann einmal.
//
// So geht es: Jede Nachricht legt sich in eine Liste und wartet kurz. Kam
// in der Zeit eine neuere, gibt die aeltere auf und die neuere nimmt alles
// mit. Eine Sperre sorgt dafuer, dass nie zwei Antworten gleichzeitig an
// denselben Kunden entstehen.
const sammelnMs = bild => Number(bild
  ? (process.env.WA_SAMMELN_BILD_MS ?? process.env.WA_SAMMELN_MS ?? 4500)
  : (process.env.WA_SAMMELN_MS ?? 2500));
const warte = ms => new Promise(r => setTimeout(r, ms));

async function sammeln(from, eintrag) {
  const kListe = "wa:ein:" + from, kLetzte = "wa:letzte:" + from, kSperre = "wa:sperre:" + from;
  const abgelegt = await redis("RPUSH", kListe, JSON.stringify(eintrag));
  if (abgelegt === undefined) return { liste: [eintrag], sperre: false };   // Speicher weg: lieber sofort antworten
  await redis("EXPIRE", kListe, 300);
  await redis("SET", kLetzte, eintrag.id, "EX", 300);

  const ms = sammelnMs(!!eintrag.mediaId);
  if (ms > 0) await warte(ms);
  if ((await redis("GET", kLetzte)) !== eintrag.id) return null;            // eine neuere Nachricht uebernimmt

  let sperre = false;
  for (let i = 0; i < 20; i++) {
    const s = await redis("SET", kSperre, eintrag.id, "NX", "EX", 55);
    if (s === "OK") { sperre = true; break; }
    if (s === undefined) break;
    await warte(ms > 0 ? 1500 : 5);
    if ((await redis("GET", kLetzte)) !== eintrag.id) return null;
  }

  const roh = await redis("LPOP", kListe, "50");
  const liste = (Array.isArray(roh) ? roh : roh ? [roh] : [])
    .map(x => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean);
  // Die eigene Nachricht muss dabei sein, ausser ein anderer Lauf hat sie
  // schon beantwortet.
  if (!liste.some(e => e.id === eintrag.id) && !(await redis("GET", "wa:erl:" + eintrag.id))) liste.push(eintrag);
  if (!liste.length) { if (sperre) await redis("DEL", kSperre); return null; }
  for (const e of liste) await redis("SET", "wa:erl:" + e.id, "1", "EX", 900);
  return { liste, sperre };
}

const RE_AN_KUNDE = /\[\[AN_KUNDE\|\s*(\d{1,4})\s*\|([^\]]{5,1500})\]\]/;

// Rohdaten des Aufrufs lesen (fuer die Signatur). Gibt null zurueck, wenn
// die Laufzeit den Inhalt schon gelesen hat.
async function rohKoerper(req) {
  if (!req || typeof req.on !== "function" || req.readableEnded || req.complete && !req.readable) return null;
  return new Promise(fertig => {
    const teile = []; let ende = false;
    const schluss = v => { if (!ende) { ende = true; fertig(v); } };
    req.on("data", c => teile.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => schluss(Buffer.concat(teile)));
    req.on("error", () => schluss(null));
    setTimeout(() => schluss(teile.length ? Buffer.concat(teile) : null), 3000);
  });
}

async function verarbeite(body, start) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];

  if (!msg) {
    // Status-Meldungen von WhatsApp. "zugestellt" und "gelesen" brauchen
    // wir nicht. "failed" schon: WhatsApp nimmt eine Nachricht ausserhalb
    // des 24-Stunden-Fensters erst an und meldet das Scheitern erst hier.
    for (const s of (value?.statuses || [])) {
      if (s.status !== "failed") continue;
      const fehler = (s.errors && s.errors[0]) || {};
      try {
        const kunde = await zustellungGescheitert(s.id, fehler.code || "?", fehler.title || fehler.message || "");
        if (kunde) await kundenZustellungGescheitert(kunde);
      } catch (e) { console.error("status failed", e && e.message); }
    }
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
  let mediaId = "";
  let knopf = "";             // Kennung eines angetippten Knopfs
  if (msg.type === "text") {
    text = (msg.text?.body || "").slice(0, 4000);
  } else if (msg.type === "image") {
    text = (msg.image?.caption || "").slice(0, 4000);
    mediaId = msg.image?.id || "";
  } else if (msg.type === "button") {
    // Tipp auf einen Knopf unter einer Vorlage, z. B. "Alles anzeigen"
    text = (msg.button?.text || msg.button?.payload || "").slice(0, 200);
  } else if (msg.type === "interactive") {
    text = (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "").slice(0, 200);
    knopf = String(msg.interactive?.button_reply?.id || "");
  } else {
    await sendWhatsApp(from,
      "Das Format kann ich hier leider nicht öffnen. Schicken Sie mir " +
      "gern Text oder Fotos vom Schaden – oder rufen Sie uns an: " +
      "030 607 97 930.");
    return;
  }

  if (isOwner(from)) return verarbeiteInhaber({ from, text, mediaId, knopf, bezug: msg.context?.id || "", start });
  return verarbeiteKunde({ from, msg, text, mediaId, profilName, start });
}

// ======================================================================
// Dirk (oder Julian) schreibt
// ======================================================================
async function verarbeiteInhaber({ from, text, mediaId, knopf, bezug, start }) {
  // Dirk hat geschrieben: Sein 24-Stunden-Fenster ist offen.
  await inhaberHatGeschrieben(from).catch(() => {});
  // Dirk schreibt oder tippt: Das 24-Stunden-Fenster ist jetzt offen,
  // also kommt alles Liegengebliebene sofort.
  const nachgeliefert = await inhaberNachliefern(from).catch(() => 0);
  const t = String(text || "").trim();
  if (/^(alles anzeigen|anzeigen|zeig alles)$/i.test(t)) {
    if (!nachgeliefert) await sendWhatsApp(from, "Es liegt nichts mehr an, du bist auf dem neuesten Stand.");
    return;
  }

  // ---- Knopf unter einer Karte ---------------------------------------
  let m = knopf.match(/^a:(anruf|vorbei|details|erledigt):(\d+)$/);
  if (m) {
    const antwort = await karteAktion(from, m[1], Number(m[2]));
    if (antwort) await sendWhatsApp(from, antwort);
    return;
  }
  m = knopf.match(/^l:(ok|nein):(\d+)$/);
  if (m) {
    await sendWhatsApp(from, (await lernBefehl("Lernen " + m[2] + " " + m[1])) || "Diesen Vorschlag gibt es nicht mehr.");
    return;
  }

  // ---- Entwurf an einen Kunden bestaetigen oder verwerfen --------------
  const entwurf = await jsonLesen("entwurf:" + from, null);
  if (entwurf) {
    if (knopf === "e:senden" || /^(ja|senden|schick(en)?|passt|ok|raus damit)\.?$/i.test(t)) {
      await redis("DEL", "entwurf:" + from);
      await sendWhatsApp(from, await entwurfSenden(from, entwurf));
      return;
    }
    if (knopf === "e:weg" || /^(nein|verwerfen|weg|abbrechen|stopp?)\.?$/i.test(t)) {
      await redis("DEL", "entwurf:" + from);
      await sendWhatsApp(from, "Verworfen, es ist nichts rausgegangen.");
      return;
    }
    // Alles andere ist eine Aenderung oder ein neues Thema: Entwurf faellt weg.
    await redis("DEL", "entwurf:" + from);
  } else if (knopf === "e:senden" || knopf === "e:weg") {
    await sendWhatsApp(from, "Der Entwurf ist nicht mehr da. Sag mir einfach noch einmal, was der Kunde bekommen soll.");
    return;
  }

  // ---- Antwort direkt auf eine Karte: welche Anfrage ist gemeint? -------
  let bezugNr = 0;
  if (bezug) bezugNr = Number(await redis("GET", "karte:" + bezug)) || 0;
  if (bezugNr && /^(übernehme|uebernehme|übernehmen|uebernehmen)\.?$/i.test(t)) text = "Übernehme " + bezugNr;

  // ---- Uebernahme / Mitlesen ------------------------------------
  const ueb = await uebernahmeBefehl(from, text);
  if (ueb) { await sendWhatsApp(from, ueb); return; }

  if (bezugNr && !(await uebernahmeKunde(from))) {
    const antwort = await antwortAufKarte(from, bezugNr, t);
    if (antwort !== null) { if (antwort) await sendWhatsApp(from, antwort); return; }
  }

  // ---- Befehle ----------------------------------------------------
  const handled = await handleOwnerCommand(from, text);
  if (handled) return;

  // Laeuft eine Uebernahme, geht alles, was kein Befehl war, 1:1 an
  // den Kunden. Im Verlauf des Kunden landet es als Werkstatt-Nachricht,
  // damit Alex nach "Fertig" weiss, was besprochen wurde.
  const kundeUeb = await uebernahmeKunde(from);
  if (kundeUeb && text) {
    const ok = await sendWA(kundeUeb, text);
    const hist = await memGet(kundeUeb);
    await memSet(kundeUeb, anhaengen(hist, { role: "assistant", content: "[Werkstatt persönlich] " + text }));
    const akteU = await akteHolenOderAnlegen({ kanal: "whatsapp", kundeNr: kundeUeb, sitzung: "wa:" + kundeUeb, status: "gespraech" }).catch(() => null);
    if (akteU && ok) await gespraechAnhaengen(akteU.nr, "D", text).catch(() => {});
    if (!ok) await sendWhatsApp(from, "⚠ Nicht zugestellt – der Kunde hat seit über 24 Std. nicht geschrieben.");
    return;
  }

  // ---- Freie Frage oder freier Auftrag: Alex als Assistent ---------------
  const history = await memGet(from);
  const messages = anhaengen(history, { role: "user", content: text || "(Foto)" });
  if (mediaId) {
    const img = await fetchWhatsAppMedia(mediaId);
    if (img) messages[messages.length - 1].content = [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: img } },
      { type: "text", text: text || "(Foto)" }];
  }
  const merk = messages.map(mm => ({ role: mm.role, content: typeof mm.content === "string" ? mm.content : (text || "(Foto)") }));
  await memSet(from, merk);

  const stand = await chefUeberblick().catch(() => "STAND NICHT LESBAR: sag Dirk, er soll \"Anfragen\" schreiben.");
  const gemeint = bezugNr || nummerImText(t);
  const einzel = gemeint ? await chefAkteKontext(gemeint).catch(() => "") : "";
  const chefBlock =
    "\n\n=== DU SPRICHST MIT DIRK, DEM INHABER ===\n" +
    "Das ist kein Kunde, sondern der Chef. Du bist sein Assistent, ihr duzt euch. " +
    "Knapp, sachlich, kollegial, keine Verkaufsfloskeln, keine Begrüßung in jeder Nachricht. " +
    "Dirk hat wenig Zeit und will keine Technik: Antworte in ein bis drei kurzen Sätzen. " +
    "Gegenüber KUNDEN bleibt es immer beim Sie.\n\n" +
    stand + einzel + "\n\n" +
    "REGELN FÜR DEINE ANTWORT:\n" +
    "• Antworte zum Stand NUR aus den Daten oben. Steht dort eine Anfrage, existiert sie. " +
    "Sag nie \"nichts Offenes\", wenn oben Anfragen stehen, und erfinde keine.\n" +
    "• Fragt Dirk etwas zu einem Kunden (was will er, was für ein Auto, was hat er geschrieben), antworte direkt aus den Daten und dem Wortlaut oben, statt ihn auf Befehle zu verweisen.\n" +
    "• Sag nie, dass Julian etwas prüfen muss oder dass du etwas nicht siehst, wenn es oben steht.\n" +
    "• Fotos kannst du hier nicht einfügen. Die schickt \"Fotos 3\" oder \"Anfrage 3\". Fotos von vor dem 13.11. sind nicht mehr abrufbar.\n" +
    "• Denk mit: Weise kurz auf das Dringendste hin (DRINGEND, lange Wartende, WhatsApp-Fenster, das bald schließt).\n\n" +
    "KUNDEN ETWAS SCHREIBEN LASSEN:\n" +
    "Bittet Dirk dich, einem Kunden etwas zu schreiben (ein Angebot, eine Rückfrage, eine Entschuldigung), dann formuliere die Nachricht fertig aus: " +
    "per Sie, freundlich, zwei bis vier kurze Sätze, kein Ausrufezeichen, beginnend mit \"Guten Tag, hier ist Alex von der Autolackiererei in Britz.\" " +
    "Preise und Zusagen NUR, wenn Dirk sie gerade genannt hat, und genau so. Erfinde nichts dazu. " +
    "Schreib dann eine kurze Zeile an Dirk und hänge ans Ende GENAU EINE Zeile an: [[AN_KUNDE|Nummer der Anfrage|fertiger Text an den Kunden]]. " +
    "Die Nachricht geht erst raus, wenn Dirk bestätigt, das macht das System. Ist nicht klar, welcher Kunde gemeint ist, frag nach statt zu raten.\n\n" +
    "BEFEHLE, DIE ES WIRKLICH GIBT (nur nennen, wenn es hilft):\n" +
    "\"Anfragen\" · \"Anfrage 3\" · \"Fotos 3\" · \"Gespräch 3\" (Wortlaut) · \"Alle Details\" · \"Angebot 3: [Preis], [was gemacht wird]\" · " +
    "\"Erledigt 3\" (auch mehrere: \"Erledigt 2 3 4\") · \"Nachfassen 3\" · \"Vorbeikommen 3\" · \"Anruf 3\" · " +
    "\"Übernehme 3\" (selbst mit dem Kunden schreiben) · \"Termine\" · \"Fertig 3\" (Auto fertig) · \"Merk dir: …\" · \"Status\" · \"Hilfe\".\n" +
    "Erfinde keine weiteren Befehle oder Funktionen. Kannst du etwas nicht, sag es klar.\n" +
    "Website-Kunden und WhatsApp-Kunden, die über 24 Stunden nicht geschrieben haben, kannst du nicht anschreiben: Rufnummer nennen.\n" +
    "Setze im Gespräch mit Dirk NIEMALS Kundenmarker wie [[KONTAKT|…]], [[KVA|…]] oder [[BUCHUNG|…]].";

  const r = await kiAnfrage({
    messages, max: 900,
    zusatz: zeitKontext(await belegteZeiten().catch(() => [])) + chefBlock +
      "\n\nKanal: WhatsApp. Kurz wie im Chat, keine Aufzählungen, keine Überschriften." +
      (await ownerNotesBlock())
  });
  if (!r.ok) {
    await fehlerZaehlen("modell", "WhatsApp, Inhaber: KI nicht erreichbar (" + r.grund + ")", "Bin gerade nicht erreichbar …").catch(() => {});
    await sendWhatsApp(from, "Ich bin gerade nicht erreichbar. Die Befehle gehen trotzdem, zum Beispiel \"Anfragen\" oder \"Hilfe\".");
    return;
  }
  const roh = r.text;
  const mE = roh.match(RE_AN_KUNDE);
  let reply = saeubern(markerRaus(roh), true).trim();

  if (mE) {
    const nr = Number(mE[1]);
    const kundenText = saeubern(mE[2].trim(), true).trim();
    const akte = await akteFinden(nr).catch(() => null);
    if (!akte) {
      reply = "Anfrage " + nr + " finde ich nicht. Welche Nummer meinst du? \"Anfragen\" zeigt die offenen.";
    } else {
      await jsonSchreiben("entwurf:" + from, { nr, text: kundenText, ts: Date.now() }, 3600);
      const vorschau = "An Nr. " + nr + " · " + (akte.name || "Kunde") + " geht:\n\n„" + kundenText + "“";
      const ok = await sendWAKnoepfe(from, vorschau.slice(0, 1000), [{ id: "e:senden", titel: "Senden" }, { id: "e:weg", titel: "Verwerfen" }]);
      if (!ok) await sendWhatsApp(from, vorschau + "\n\nSenden? Antworte mit Ja oder Nein.");
      await memSet(from, [...merk, { role: "assistant", content: "Entwurf an Nr. " + nr + ": " + kundenText }].slice(-MAX_TURNS));
      return;
    }
  }
  if (!reply) reply = "Das habe ich gerade nicht hinbekommen. Schreib es mir bitte noch einmal, oder schick \"Hilfe\" für alle Befehle.";
  await sendeMenschlich(from, reply);
  await memSet(from, [...merk, { role: "assistant", content: reply }].slice(-MAX_TURNS));
  await nacharbeit(start);
}

// Eine Anfrage an die KI mit dem grossen Wissensblock (im Zwischenspeicher).
// Rueckgabe: { ok, text, data, grund }
async function kiAnfrage({ messages, zusatz, max = 900 }) {
  let r;
  try {
    r = await kiRufen({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: max,
      system: [{
        type: "text",
        text: SYSTEM + "\n\n<wissensbasis>\n" + KNOWLEDGE + "\n</wissensbasis>",
        cache_control: { type: "ephemeral" }
      }, { type: "text", text: zusatz }],
      messages
    }, 25000);
  } catch (e) {
    return { ok: false, grund: "Zeitlimit 25 s", text: "" };
  }
  if (!r.ok) {
    console.error("Anthropic", r.status, await r.text().catch(() => ""));
    return { ok: false, grund: r.status ? "Fehler " + r.status : "Zeitlimit 25 s", text: "" };
  }
  const data = await r.json();
  let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  // Reisst die Antwort am Laengenlimit ab, endet sie mitten im Satz
  // ("... ein, zwei Fotos vom"). Dann den angefangenen Satz lieber
  // wegschneiden als ihn halb zu verschicken.
  if (data.stop_reason === "max_tokens" && text) {
    const bisSatzende = text.replace(/\s+\S*$/, "");
    const m = bisSatzende.match(/^[\s\S]*[.!?…]/);
    if (m && m[0].trim().length > 20) text = m[0].trim();
  }
  return { ok: true, text, data };
}

// Was nach jeder Antwort mitlaeuft: Aufgehobenes zustellen, Fallpflege,
// Briefing. Kommt NACH der Antwort an den Kunden, damit niemand darauf
// warten muss. Alles ist gegen doppelte Ausfuehrung gesichert.
async function nacharbeit(start) {
  await warteschlangeZustellen().catch(() => {});
  await offeneGespraecheMelden().catch(() => {});
  // Die Funktion darf 60 Sekunden laufen. KI-Anfragen der Fallpflege
  // beginnen nur, wenn seit dem Eingang weniger als 30 Sekunden vergangen sind.
  await weckerAufgaben({ bis: (start || Date.now()) + 30000 }).catch(() => {});
  await herzschlag(false).catch(() => {});
}

// ======================================================================
// Ein Kunde schreibt
// ======================================================================
async function verarbeiteKunde({ from, msg, text, mediaId, profilName, start }) {
  // ---- Kunde in einer Uebernahme: Alex schweigt, Dirk liest direkt ----
  const ueb = await kundeInUebernahme(from);
  if (ueb) {
    await anUebernehmer(ueb, { text, mediaIds: mediaId ? [mediaId] : [] });
    const hist = await memGet(from);
    // WhatsApp-Verlauf muss mit "user" beginnen und abwechseln: wir haengen an
    await memSet(from, anhaengen(hist, { role: "user", content: text || "(Foto)" }));
    await gespraechAnhaengen(ueb.nr, "K", text || "(Foto)").catch(() => {});
    if (mediaId) await akteAendern(ueb.nr, a => { a.medien = [...(a.medien || []), mediaId].slice(-20); a.fotos = (a.fotos || 0) + 1; a.letzterKontakt = Date.now(); }).catch(() => {});
    return;
  }

  // Sofort: blaue Haken und "schreibt ...". Laeuft nebenher.
  const gelesen = sendWAGelesen(msg.id).catch(() => false);

  // ---- Kurz sammeln: mehrere Nachrichten, eine Antwort -------------------
  const gesammelt = await sammeln(from, { id: msg.id, text, mediaId });
  if (!gesammelt) { await gelesen; return; }
  try {
    await beantworteKunde({ from, eintraege: gesammelt.liste, profilName, start });
  } finally {
    if (gesammelt.sperre) await redis("DEL", "wa:sperre:" + from);
    await gelesen;
  }
}

async function beantworteKunde({ from, eintraege, profilName, start }) {
  const mediaIds = eintraege.map(e => e.mediaId).filter(Boolean);
  const texte = eintraege.map(e => String(e.text || "").trim()).filter(Boolean);
  const fotoHinweis = mediaIds.length > 1 ? "(" + mediaIds.length + " Fotos vom Schaden)" : "(Foto vom Schaden)";
  const text = (texte.join("\n") || (mediaIds.length ? fotoHinweis : "")).slice(0, 4000);
  if (!text && !mediaIds.length) return;

  // Bilder laden (fuer die Einschaetzung reichen vier, gezaehlt werden alle)
  const images = (await Promise.all(mediaIds.slice(0, 4).map(id => fetchWhatsAppMedia(id)))).filter(Boolean);

  // Jede WhatsApp-Unterhaltung hat von der ersten Nachricht an eine Akte
  // (reine Unterhaltung = Status "gespraech", zaehlt nicht als Anfrage).
  // So steht das Gespraech vollstaendig drin und Dirk kann uebernehmen.
  await akteHolenOderAnlegen({ kanal: "whatsapp", kundeNr: from, sitzung: "wa:" + from, status: "gespraech" }).catch(() => null);

  // ---- Gesprächsverlauf laden (optional, via Upstash) ----------
  const history = await memGet(from);
  const messages = anhaengen(history, { role: "user", content: text });
  const merk = messages.map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : text }));
  if (images.length) {
    const last = messages[messages.length - 1];
    const bisher = typeof last.content === "string" ? last.content : text;
    last.content = [
      ...images.map(b64 => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } })),
      { type: "text", text: bisher + (mediaIds.length > images.length ? "\n(Insgesamt " + mediaIds.length + " Fotos, du siehst die ersten " + images.length + ".)" : "") }
    ];
  }
  // Verlauf sofort sichern. Faellt weiter unten etwas aus, ist die
  // Kundennachricht trotzdem im Gedaechtnis.
  await memSet(from, merk);

  const zusatz =
    // Derselbe Zeit- und Terminkontext wie im Web-Chat. Ohne ihn kennt
    // Alex weder das heutige Datum noch die buchbaren Fenster.
    zeitKontext(await belegteZeiten().catch(() => [])) + (await buchungKontext()) +
    "\n\nDieser Kunde schreibt über WhatsApp von der Nummer +" + from +
    ". Frag deshalb NICHT nach der Telefonnummer, du hast sie bereits. " +
    "Bestätige sie höchstens kurz (\"Ich nehme die Nummer, von der Sie schreiben\").\n" +
    "Nach dem Namen fragst du dagegen ganz normal, sobald du ihn für " +
    "einen Termin brauchst. Sprich den Kunden NIE mit einem Namen an, " +
    "den er dir nicht selbst genannt hat." +
    "\n\nKanal: WhatsApp. Schreibe wie eine echte Person im Chat: " +
    "höchstens zwei bis drei kurze Sätze, keine Aufzählungen, " +
    "keine Zwischenüberschriften, kein Fließtext-Block." +
    (eintraege.length > 1
      ? "\n\nDer Kunde hat gerade " + eintraege.length + " Nachrichten hintereinander geschickt" +
        (mediaIds.length ? " (darunter " + mediaIds.length + " Foto" + (mediaIds.length > 1 ? "s" : "") + ")" : "") +
        ". Antworte EINMAL auf alles zusammen, nicht auf jede Nachricht einzeln."
      : "") +
    // Kennzeichnung nach EU AI Act, Art. 50: Auf WhatsApp gibt es
    // keine Kopfzeile, deshalb einmalig im ersten Satz - nicht als
    // Warnhinweis, sondern als das, was es ist: schnelle Vorarbeit,
    // entschieden wird in der Werkstatt.
    (messages.length > 2 ? "" :
    "\n\nDies ist die ERSTE Nachricht dieses Kunden. Beginne mit einer kurzen Begrüßung passend zur Tageszeit " +
    "und stell dich in einem Satz vor, zum Beispiel: \"Guten Abend, hier ist Alex, der KI-Assistent der Autolackiererei in Britz 👋\" " +
    "Dann direkt zu seinem Anliegen, ohne weitere Erklärung. Den Hinweis, dass die Werkstatt Preis und Termin " +
    "am Ende entscheidet, bringst du erst, wenn es zum ersten Mal um Preis oder Termin geht, und dann in einem Halbsatz. " +
    "Das Emoji nur in diesem ersten Satz, danach keine mehr.") +
    (await ownerNotesBlock()) + (await gelerntBlock()) + (await akteKontext(from).catch(() => ""));

  const r = await kiAnfrage({ messages, zusatz });
  if (!r.ok) {
    await fehlerZaehlen("modell", "WhatsApp, Kunde: KI nicht erreichbar (" + r.grund + ")",
      "Entschuldigung, ich bin gerade nicht erreichbar. Rufen Sie uns gern direkt an …").catch(() => {});
    await sendWhatsApp(from,
      "Entschuldigung, ich bin gerade nicht erreichbar. Rufen Sie uns " +
      "gern direkt an: 030 607 97 930 (Mo–Do 8–17, Fr 8–15 Uhr).");
    // Die Anfrage darf trotzdem nicht verloren gehen: Akte fortschreiben,
    // damit Dirk Fotos und Text bekommt.
    await anfrageFortschreiben({ sitzung: "wa:" + from, kanal: "whatsapp", kundeNr: from, antwort: "", alexText: "",
      kundentext: text, fotos: mediaIds.length, profilName, mediaIds }).catch(() => {});
    return;
  }
  const data = r.data;
  let reply = r.text;

  // Rohfassung MIT Markern fuer den Verlauf: So sieht der Assistent
  // beim naechsten Zug, dass er die Daten schon weitergegeben hat.
  const rohAntwort = String(reply);
  const hatteDaten = RE_KONTAKT.test(rohAntwort) || RE_KVA.test(rohAntwort) ||
                     RE_TERMIN.test(rohAntwort) || RE_BUCHUNG.test(rohAntwort);

  // Bestaetigter Termin (alter Weg): Auf WhatsApp gibt es keine Karte mit
  // Knoepfen, deshalb eine antippbare Kalender-Adresse.
  const mOk = rohAntwort.match(RE_TERMIN_OK);
  let kalenderSeite = "";
  if (mOk) kalenderSeite = terminSeite(mOk[1].trim(), "", mOk[2].trim(), mOk[3].trim());

  reply = markerRaus(reply);
  // Gedankenstriche und Ausrufezeichen entfernen (wirken maschinell)
  reply = saeubern(reply, true).trim();
  // Leere Antwort: Hat das Modell nur Marker geschickt, ist das ein
  // Abschluss ohne Worte. Dann sagen wir dem Kunden, was jetzt passiert,
  // und fragen NICHT "anders formulieren" (das waere nach gelieferten
  // Daten ein Schlag ins Gesicht).
  if (!reply) {
    const bloecke = (data.content || []).map(b => b.type).join(",") || "keine";
    const marker = (rohAntwort.match(/\[\[([A-Z_]+)\|/g) || []).map(m => m.slice(2, -1)).join(",") || "keine";
    const wer = "Kunde …" + String(from).slice(-4);
    const technik = "stop_reason=" + (data.stop_reason || "?") + ", Blöcke=" + bloecke + ", Marker=" + marker;

    // Zweiter Versuch: nur den sichtbaren Satz nachfordern. Die Marker
    // aus dem ersten Versuch bleiben gueltig (Buchung, Kontakt).
    const r2 = await kiAnfrage({ messages, zusatz: zusatz +
      "\n\nWICHTIG: Deine letzte Antwort enthielt keinen Text für den Kunden. Antworte jetzt mit ein bis zwei kurzen, sichtbaren Sätzen. " +
      "Keine technischen Marker in dieser Antwort." });
    const zweiter = r2.ok ? saeubern(markerRaus(r2.text), true).trim() : "";

    if (zweiter) {
      reply = zweiter;
      await fehlerLog("leer-behoben", "WhatsApp, " + wer + ": erste KI-Antwort ohne Text, zweiter Versuch erfolgreich (" + technik + ")");
    } else {
      const mB = rohAntwort.match(RE_BUCHUNG);
      reply = mB
          ? "Danke, Ihr Termin ist eingetragen. Die Einzelheiten und den Kalendereintrag schicke ich Ihnen gleich hier."
          : hatteDaten
            ? "Danke, das habe ich alles notiert und an unser Team weitergegeben. " +
              RUECKMELDUNG + " Die Antwort kommt hier. Sie müssen nichts weiter tun."
            : "Entschuldigung, da ist bei mir gerade etwas hängen geblieben. Schreiben Sie mir Ihre Nachricht bitte noch einmal, " +
              "oder rufen Sie uns an: 030 607 97 930.";
      await fehlerZaehlen("leer", "WhatsApp, " + wer + ": KI-Antwort zweimal ohne Text (" + technik + ")", reply).catch(() => {});
    }
  }
  // Verbindliche Buchung pruefen (harte Regeln im Code). Passt sie,
  // bekommt der Kunde den Kalenderlink; passt sie nicht, die Korrektur
  // mit freien Alternativen in derselben Nachricht.
  const mKB = rohAntwort.match(RE_KONTAKT);
  const bu = await buchungVerarbeiten({
    antwort: rohAntwort, kanal: "whatsapp", sitzung: "wa:" + from, kundeNr: from,
    name: ((mKB && mKB[1]) || "").trim(), tel: ((mKB && mKB[2]) || "").trim() || from,
    thema: text, fotos: mediaIds.length
  }).catch(e => { console.error("buchung", e && e.message); return null; });
  if (bu && bu.ok) kalenderSeite = bu.seite;
  else if (bu && bu.korrektur) reply += "\n\n" + bu.korrektur;

  // ---- ERST antworten, dann alles Weitere -------------------------------
  // Termin bestaetigt: Text mit Knopf "📅 In den Kalender" statt einer
  // langen Adresse. Klappt der Knopf nicht, kommt der Link als Text.
  if (kalenderSeite) {
    const mitKnopf = reply.length <= 1000 && await sendWALinkKnopf(from, reply, "📅 In den Kalender", kalenderSeite);
    if (!mitKnopf) {
      await sendeMenschlich(from, reply);
      if (!(await sendWALinkKnopf(from, "Damit Sie den Termin nicht vergessen:", "📅 In den Kalender", kalenderSeite)))
        await sendWhatsApp(from, "In den Kalender eintragen:\n" + kalenderSeite);
    }
  } else {
    await sendeMenschlich(from, reply);
  }

  // ---- Verlauf speichern ---------------------------------------
  await memSet(from, [...merk, { role: "assistant", content: hatteDaten ? rohAntwort : reply }].slice(-MAX_TURNS));
  await logGapIfNeeded(text, reply);   // Wissenslücke still protokollieren

  // Terminanfrage nach altem Muster an den Inhaber melden
  await meldeTermin({ antwort: rohAntwort, kanal: "whatsapp", kundeNr: from, thema: text, ersatzName: profilName }).catch(() => {});

  // Akte fortschreiben: Angaben, Fotos, Gespraech, Dringlichkeit. Hier
  // entscheidet sich auch, ob Dirk sofort eine Karte bekommt.
  const akte = await anfrageFortschreiben({
    sitzung: "wa:" + from, kanal: "whatsapp", kundeNr: from,
    antwort: rohAntwort, alexText: reply, kundentext: text, fotos: mediaIds.length,
    profilName, mediaIds
  }).catch(e => { console.error("akte", e && e.message); return null; });
  await spiegeln({ kanal: "whatsapp", akte, kundeText: text, alexText: reply, fotos: mediaIds.length });

  // Lernen: Gespraech anonymisiert ablegen (Kennung = gehashte Nummer,
  // nie die Nummer selbst). Die Auswertung macht der Wecker.
  try {
    await gespraechAblegen({
      kennung: lernKennung(from), kanal: "whatsapp",
      verlauf: [...merk, { role: "assistant", content: rohAntwort }]
    });
  } catch (e) { console.error("lernen", e && e.message); }

  await nacharbeit(start);
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
// Zwei Nachrichten derselben Rolle hintereinander (z. B. waehrend einer
// Uebernahme) zusammenfuehren: Die KI erwartet abwechselnde Rollen.
function anhaengen(hist, msg) {
  const l = Array.isArray(hist) ? hist.slice() : [];
  const letzte = l[l.length - 1];
  if (letzte && letzte.role === msg.role && typeof letzte.content === "string" && typeof msg.content === "string") {
    l[l.length - 1] = { role: msg.role, content: letzte.content + "\n" + msg.content };
  } else l.push(msg);
  return l.slice(-MAX_TURNS);
}

async function memGet(key) {
  return jsonLesen("wa:" + key, []);
}
async function memSet(key, value) {
  await jsonSchreiben("wa:" + key, value, 86400);
}

// ---- Lern-Modus: Inhaber kann Alex per WhatsApp Wissen geben --
// Wann schrieb diese Inhaber-Nummer zuletzt? (Das WhatsApp-Fenster)
async function letzterKontaktText(n) {
  const w = Number(await redis("GET", "inhaber:fenster:" + n)) || 0;
  if (!w) return "unbekannt";
  const std = Math.round((Date.now() - w) / 3600000);
  return std < 1 ? "gerade eben" : "vor " + std + " Std." + (std >= 24 ? " (WhatsApp zu, Meldungen warten oder kommen per E-Mail)" : "");
}

function isOwner(num) {
  return berechtigteNummern().includes(String(num).replace(/\D/g, ""));
}

async function handleOwnerCommand(from, text) {
  const t = (text || "").trim();
  let m;

  // "3 passt" -> Rueckmeldung zu Terminanfrage Nr. 3
  if (await inhaberAntwort(from, t)) return true;

  // Lernrunde: "Lernen", "Lernen 3 ok/nein", "Gelernt", "Vergiss gelernt 2",
  // "Lernexport", "Lernrunde"
  // Termine: "Termine", "Voll/Frei Donnerstag", "Urlaub 1.10. bis 5.10.",
  // "Absagen 7", "Verschieben 7 Freitag 8-10", "Eintragen ...", "Fertig 7",
  // "Abholnachricht selbst/Alex"
  const bu = await buchungBefehl(t);
  if (bu) { await sendWhatsApp(from, bu); return true; }

  const lern = await lernBefehl(t);
  if (lern) { await sendWhatsApp(from, lern); return true; }

  // Anfragen-Akten: "Anfragen", "Anfrage 3", "Angebot 3: ...", "Erledigt 3",
  // "Nachfassen 3", "Protokoll", "Protokoll gestern"
  const akte = await anfrageBefehl(t, from);
  if (akte) { await sendWhatsApp(from, akte); return true; }

  // "Lösche Termin 3", "Termin 3 löschen", "Lösche alle Termine",
  // "Termin löschen" (ohne Nummer -> wenn nur einer offen ist)
  m = t.match(/^(?:l(?:ö|oe)sche?|entferne)\s+(?:termin\s*)?(\d{1,3}|alle)(?:\s+termine?)?$/i)
      || t.match(/^termin\s*(\d{1,3})\s+l(?:ö|oe)schen$/i);
  if (m) {
    await sendWhatsApp(from, await terminLoeschen(m[1]));
    return true;
  }
  // Ohne Nummer: nur eindeutig, wenn genau eine Anfrage offen ist.
  if (/^(?:termin\s+)?l(?:ö|oe)schen$/i.test(t)) {
    const liste = await jsonLesen("termine", []);
    const offen = liste.filter(e => Date.now() - (e.ts || 0) < 7 * 86400000);
    if (offen.length === 1) {
      await sendWhatsApp(from, await terminLoeschen(String(offen[0].nr)));
    } else if (!offen.length) {
      await sendWhatsApp(from, "Es ist gerade nichts offen.");
    } else {
      await sendWhatsApp(from,
        "Es sind " + offen.length + " Anfragen offen. Welche soll weg? " +
        "Zum Beispiel \"Lösche Termin " + offen[0].nr + "\". " +
        "Mit \"Termine\" zeige ich sie an.");
    }
    return true;
  }

  // Verschieben in Kurzform:
  //   "Termin auf 14 Uhr"          -> selber Tag wie bisher vorgemerkt
  //   "Termin auf 19.08. 14 Uhr"   -> neues Datum
  //   "Termin 2 auf 14:30"         -> mit Nummer
  m = t.match(/^termin\s*(\d{1,3})?\s*(?:auf|um)\s+(?:(\d{1,2})\.(\d{1,2})\.?\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(?:uhr)?$/i);
  if (m) {
    const liste = await jsonLesen("termine", []);
    const offen = liste.filter(e => Date.now() - (e.ts || 0) < 7 * 86400000);
    const eintrag = m[1]
      ? offen.find(e => String(e.nr) === m[1])
      : (offen.length === 1 ? offen[0] : null);

    if (!eintrag) {
      await sendWhatsApp(from, offen.length
        ? "Welchen Termin meinst du? Zum Beispiel \"Termin " + offen[0].nr +
          " auf 14 Uhr\". Mit \"Termine\" zeige ich die offenen an."
        : "Es ist gerade nichts offen.");
      return true;
    }

    // Datum: entweder angegeben oder der bisher vorgemerkte Tag
    const alt = new Date(eintrag.wann);
    const tag = m[2] ? Number(m[2]) : alt.getDate();
    const monat = m[3] ? Number(m[3]) : alt.getMonth() + 1;
    const jahr = alt.getFullYear();
    const std = Number(m[4]);
    const min = m[5] ? Number(m[5]) : 0;
    const neu = `${jahr}-${String(monat).padStart(2, "0")}-` +
                `${String(tag).padStart(2, "0")}T${String(std).padStart(2, "0")}:` +
                `${String(min).padStart(2, "0")}`;

    await sendWhatsApp(from,
      "Alles klar. Ich gebe " + datumLesbar(neu) + " an " + eintrag.name +
      " weiter." +
      (eintrag.kanal === "whatsapp" ? "" :
       "\nAchtung: kam über die Website, dort erreiche ich den Kunden nicht. " +
       (eintrag.tel ? "Bitte selbst anrufen: " + eintrag.tel : "")));

    if (eintrag.kanal === "whatsapp") {
      await inhaberAntwort(from,
        "Termin " + eintrag.nr + " neuer Termin " + datumLesbar(neu) +
        ", passt das?");
    }
    return true;
  }

  // Schalter: Darf Alex Kunden von sich aus anschreiben, wenn sie still werden?
  if ((m = t.match(/^nachhaken\s+(an|aus|ein)$/i))) {
    const an = !/aus/i.test(m[1]);
    await redis("SET", "einstellung:nachhaken", an ? "an" : "aus");
    await sendWhatsApp(from, an
      ? "Nachhaken ist an. Wird ein Kunde mittendrin still, melde ich mich einmal bei ihm, und einmal bevor WhatsApp nach 24 Std. schließt."
      : "Nachhaken ist aus. Ich schreibe keinem Kunden mehr von mir aus. Die Karten an dich kommen weiter.");
    return true;
  }

  if (/^(status|diagnose|test)$/i.test(t)) {
    const marke = "diag:" + Date.now();
    const schreiben = await redis("SET", marke, "ok", "EX", 60);
    const lesen = await redis("GET", marke);
    const verlauf = await memGet(from);
    const notizen = await notesGet();
    const fehler = await jsonLesen("fehlerlog", []);
    const u = speicherUrl();
    const tk = speicherToken();
    const herz = Number(await redis("GET", "herz:wecker")) || 0;
    const weckerText = !herz ? "NIE gelaufen (cron-job.org einrichten)"
      : Date.now() - herz < 40 * 60000 ? "läuft, zuletzt vor " + Math.round((Date.now() - herz) / 60000) + " Min."
      : "STEHT seit " + Math.round((Date.now() - herz) / 60000) + " Min.";
    const lernStand = await jsonLesen("lern:kennzahlen", null);
    const lernOffen = (await jsonLesen("lern:vorschlaege", [])).length;
    await sendWhatsApp(from,
      "Selbsttest\n────────\n" +
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
      "Notizen: " + notizen.length + "\n\n" +
      "Zustellung an dich\n────────\n" +
      "Vorlage für Meldungen: " + (process.env.WA_VORLAGE_INHABER ? process.env.WA_VORLAGE_INHABER : "FEHLT (Meldungen kommen nur, wenn du in den letzten 24 Std. geschrieben hast)") + "\n" +
      "Vorlage Tagesstart: " + (process.env.WA_VORLAGE_TAGESSTART || "keine eigene (nutzt die für Meldungen)") + "\n" +
      "E-Mail-Notweg: " + (process.env.RESEND_API_KEY ? "an " + (process.env.NOTFALL_MAIL || "schaden@alb.berlin") : "AUS") + "\n\n" +
      "Dein letzter Kontakt mit Alex: " + await letzterKontaktText(from) + "\n\n" +
      "KI-Modell: " + (process.env.CLAUDE_MODEL || "claude-sonnet-5") + " (ohne Vorab-Nachdenken)\n" +
      "Absender-Prüfung (Meta-Signatur): " + (process.env.WHATSAPP_APP_SECRET ? "an" : "AUS (WHATSAPP_APP_SECRET fehlt)") + "\n" +
      "Nachhaken bei stillen Kunden: " + ((await nachhakenAktiv()) ? "an" : "AUS") + "\n" +
      "Wecker (alle 15 Min.): " + weckerText + "\n" +
      "Letzte Lernrunde: " + (lernStand ? lernStand.d : "noch keine") + " · offene Vorschläge: " + lernOffen + "\n" +
      "Technik-Meldungen gehen an: " + ((process.env.TECHNIK_NUMMERN || "").trim() ? "eigene Nummer (TECHNIK_NUMMERN)" : "dieselben wie Kundenmeldungen") + "\n\n" +
      "Letzte Aussetzer\n────────\n" +
      (fehler.length
        ? fehler.slice(-6).reverse().map(f => new Date(f.ts).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" }) + " · " + f.art + (f.grund ? " · " + f.grund : "")).join("\n")
        : "keine"));
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
      "Das Wichtigste geht ohne Befehle:\n" +
      "• Knöpfe unter jeder Karte: Ich rufe an · Vorbeikommen · Details · Erledigt\n" +
      "• Preis schicken: auf die Karte antworten (Nachricht nach rechts wischen), z. B. \"480 Euro, Stoßfänger lackieren\"\n" +
      "• Oder schreib mir einfach, was du brauchst: \"Was will Nr. 7?\" oder \"Schreib Nr. 7, dass wir uns Montag melden\". Ich zeige dir den Text, du tippst auf Senden.\n\n" +
      "Befehle, falls du sie lieber magst:\n" +
      "ANFRAGEN\n" +
      "Anfragen · Anfrage 3 · Fotos 3 · Gespräch 3 · Alle Details\n" +
      "Angebot 3: 480 Euro, … · Vorbeikommen 3 · Anruf 3\n" +
      "Erledigt 3 (auch mehrere: Erledigt 2 3 4) · Nachfassen 3\n" +
      "Übernehme 3 (selbst schreiben, \"Fertig\" beendet)\n" +
      "Mitlesen an/aus (jedes Gespräch live) · Nachhaken an/aus (Alex meldet sich bei stillen Kunden)\n" +
      "TERMINE\n" +
      "Termine · Voll/Frei Donnerstag · Urlaub 1.10. bis 5.10.\n" +
      "Absagen 7 · Verschieben 7 Freitag 8-10 · Eintragen Donnerstag 11-13 Meier · Fertig 7\n" +
      "SONST\n" +
      "Merk dir: … · Zeig Notizen · Lernen · Protokoll · Status");
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
