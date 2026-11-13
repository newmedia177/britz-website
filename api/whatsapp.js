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

import { SYSTEM, KNOWLEDGE } from "./_bundle.mjs";
import { gespraechAblegen, lernrunde, gelerntBlock, lernBefehl } from "./_lernen.mjs";
import { anfrageBefehl, anfrageFortschreiben, akteKontext, fehlerZaehlen, weckerAufgaben, chefUeberblick } from "./_anfragen.mjs";
import { buchungBefehl, buchungVerarbeiten, buchungKontext, RE_BUCHUNG } from "./_buchung.mjs";
import { spiegeln, kundeInUebernahme, uebernahmeKunde, uebernahmeBefehl, anUebernehmer } from "./_mitlesen.mjs";
import { akteHolenOderAnlegen } from "./_anfragen.mjs";
import { logGapIfNeeded, saeubern, zeitKontext, RUECKMELDUNG } from "./chat.js";
import { meldeTermin, inhaberAntwort, terminListe, markerRaus,
         RE_TERMIN_OK, icsAdresse, leiteBilderWeiter, belegteZeiten,
         warteschlangeZustellen, kvaNotiz, RE_KONTAKT, RE_KVA, RE_TERMIN,
         gespraechMerken, sendWA, offeneGespraecheMelden, inhaberNachliefern,
         fetchMitZeit, fehlerLog,
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
  const mediaIds = [];        // fuer die Weiterleitung an den Inhaber
  if (msg.type === "text") {
    text = (msg.text?.body || "").slice(0, 4000);
  } else if (msg.type === "image") {
    text = (msg.image?.caption || "(Foto vom Schaden)").slice(0, 4000);
    const img = await fetchWhatsAppMedia(msg.image?.id);
    if (img) images.push(img);
    if (msg.image?.id) mediaIds.push(msg.image.id);
  } else if (msg.type === "button") {
    // Tipp auf einen Knopf unter einer Vorlage, z. B. "Alles anzeigen"
    text = (msg.button?.text || msg.button?.payload || "").slice(0, 200);
  } else if (msg.type === "interactive") {
    text = (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "").slice(0, 200);
  } else {
    await sendWhatsApp(from,
      "Das Format kann ich hier leider nicht öffnen. Schicken Sie mir " +
      "gern Text oder Fotos vom Schaden – oder rufen Sie uns an: " +
      "030 607 97 930.");
    return;
  }

  // ---- Inhaber: einmal am Tag kurz begrüßen und Stand melden -----
  if (isOwner(from)) {
    // Dirk schreibt oder tippt "Alles anzeigen": Das 24-Stunden-Fenster
    // ist jetzt offen, also kommt alles Liegengebliebene sofort.
    const nachgeliefert = await inhaberNachliefern(from).catch(() => 0);
    if (/^(alles anzeigen|anzeigen|zeig alles)$/i.test(String(text).trim())) {
      if (!nachgeliefert) await sendWhatsApp(from, "Es liegt nichts mehr an, du bist auf dem neuesten Stand.");
      return;
    }

    // Der alte Tagesgruss (tagesBriefing) ist abgeschaltet: Er las noch die
    // Terminliste von vor der Direktbuchung und meldete deshalb "nichts
    // Offenes", obwohl Termine gebucht waren. Den Ueberblick liefert jetzt
    // allein das Morgenbriefing (weckerAufgaben).

    // ---- Uebernahme / Mitlesen ------------------------------------
    const ueb = await uebernahmeBefehl(from, text);
    if (ueb) { await sendWhatsApp(from, ueb); return; }

    // ---- Lern-Modus: nur Inhaber dürfen Anweisungen geben --------
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
      if (!ok) await sendWhatsApp(from, "⚠ Nicht zugestellt – der Kunde hat seit über 24 Std. nicht geschrieben.");
      return;
    }
  }

  // ---- Kunde in einer Uebernahme: Alex schweigt, Dirk liest direkt ----
  if (!isOwner(from)) {
    const ueb = await kundeInUebernahme(from);
    if (ueb) {
      await anUebernehmer(ueb, { text, mediaIds });
      const hist = await memGet(from);
      // WhatsApp-Verlauf muss mit "user" beginnen und abwechseln: wir haengen an
      await memSet(from, anhaengen(hist, { role: "user", content: text || "(Foto)" }));
      return;
    }
  }

  // ---- Gesprächsverlauf laden (optional, via Upstash) ----------
  const history = await memGet(from);
  const messages = anhaengen(history, { role: "user", content: text });

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

  const notesBlock = (await ownerNotesBlock()) + (await gelerntBlock()) +
                     (isOwner(from) ? "" : await akteKontext(from).catch(() => ""));

  // Schreibt der Inhaber, arbeitet Alex als sein Assistent statt als
  // Kundenberater. Dafuer bekommt er den Stand der offenen Anfragen mit.
  const chef = isOwner(from);
  let chefBlock = "";
  if (chef) {
    // Echter Stand aus den Anfragen-Akten und Buchungen. Frueher stand hier
    // die alte Terminliste, deshalb sagte Alex "nichts Offenes", obwohl
    // neun Anfragen warteten.
    const stand = await chefUeberblick().catch(() => "STAND NICHT LESBAR: sag Dirk, er soll \"Anfragen\" schreiben.");
    chefBlock =
      "\n\n=== DU SPRICHST MIT DIRK, DEM INHABER ===\n" +
      "Das ist kein Kunde, sondern der Chef. Du bist sein Assistent, ihr duzt euch. " +
      "Knapp, sachlich, kollegial, keine Verkaufsfloskeln, keine Begrüßung in jeder Nachricht. " +
      "Gegenüber KUNDEN bleibt es immer beim Sie.\n\n" +
      stand + "\n\n" +
      "REGELN FÜR DEINE ANTWORT:\n" +
      "• Antworte zum Stand NUR aus der Liste oben. Steht dort eine Anfrage, existiert sie. " +
      "Sag nie \"nichts Offenes\", wenn oben Anfragen stehen, und erfinde keine.\n" +
      "• Sag nie, dass Julian etwas prüfen muss oder dass du etwas nicht siehst, wenn es oben steht.\n" +
      "• Fragt er nach Details, Fotos oder Nummern, nenne ihm den Befehl, der sie sofort schickt: " +
      "\"Anfrage 3\" (alles zu Nr. 3 samt Fotos), \"Fotos 3\", \"Alle Details\" (alle offenen samt Fotos). " +
      "Die Nummern der Kunden stehen oben, die darfst du ihm direkt nennen.\n" +
      "• Fotos, die vor dem 13.11. kamen, sind nicht mehr abrufbar. Dann ehrlich sagen und die Nummer zum Nachfragen nennen.\n\n" +
      "BEFEHLE, DIE ES WIRKLICH GIBT:\n" +
      "\"Anfragen\" · \"Anfrage 3\" · \"Fotos 3\" · \"Alle Details\" · \"Angebot 3: [Preis], [was gemacht wird]\" · " +
      "\"Erledigt 3\" · \"Nachfassen 3\" · \"Übernehme 3\" (selbst mit dem Kunden schreiben) · \"Termine\" · " +
      "\"Fertig 3\" (Auto fertig) · \"Merk dir: …\" · \"Protokoll\" · \"Status\" · \"Hilfe\".\n" +
      "Erfinde keine weiteren Befehle oder Funktionen. Kannst du etwas nicht, sag es klar und nenne den passenden Befehl.\n" +
      "Website-Kunden kannst du nicht anschreiben, dann die Rufnummer nennen. WhatsApp-Kunden, die über 24 Stunden " +
      "nicht geschrieben haben, auch nicht: Rufnummer nennen.\n" +
      "Denk mit: Weise auf Anfragen hin, die schon lange warten. Kurz.\n" +
      "Setze im Gespräch mit Dirk NIEMALS Marker wie [[KONTAKT|…]] oder [[BUCHUNG|…]]. Die gelten nur für Kunden.";
  }

  // ---- Alex antworten lassen ------------------------------------
  // Zeit- und Buchungskontext einmal berechnen (auch fuer den zweiten Versuch)
  const kontextZeitBuchung = zeitKontext(await belegteZeiten().catch(() => [])) +
    (chef ? "" : await buchungKontext());
  const kiFragen = (zusatz) => fetchMitZeit("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 900,
      system: [{
        type: "text",
        text: SYSTEM + "\n\n<wissensbasis>\n" + KNOWLEDGE + "\n</wissensbasis>",
        cache_control: { type: "ephemeral" }
      }, {
        type: "text",
        // Derselbe Zeit- und Terminkontext wie im Web-Chat. Ohne ihn
        // kennt Alex weder das heutige Datum noch die buchbaren Fenster
        // und versteht Angaben wie "morgen 11 Uhr" nicht.
        text: kontextZeitBuchung + chefBlock +
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
          "nie wiederholen.") + notesBlock + (zusatz || "")
      }],
      messages
    })
  }, 25000);

  let r;
  try { r = await kiFragen(); }
  catch (e) { r = { ok: false, status: 0, text: async () => String(e && e.name) }; }

  if (!r.ok) {
    const fehlerText = await r.text().catch(() => "");
    console.error("Anthropic", r.status, fehlerText);
    await fehlerZaehlen("modell", "WhatsApp, " + (chef ? "Inhaber" : "Kunde") + ": KI nicht erreichbar (" +
      (r.status ? "Fehler " + r.status : "Zeitlimit 25 s") + ")",
      "Entschuldigung, ich bin gerade nicht erreichbar. Rufen Sie uns gern direkt an …").catch(() => {});
    await sendWhatsApp(from,
      "Entschuldigung, ich bin gerade nicht erreichbar. Rufen Sie uns " +
      "gern direkt an: 030 607 97 930 (Mo–Do 8–17, Fr 8–15 Uhr).");
    return;
  }

  const data = await r.json();
  let reply = (data.content || [])
    .filter(b => b.type === "text").map(b => b.text).join("\n").trim();

  // Reisst die Antwort am Laengenlimit ab, endet sie mitten im Satz
  // ("... ein, zwei Fotos vom"). Dann den angefangenen Satz lieber
  // wegschneiden als ihn halb zu verschicken.
  if (data.stop_reason === "max_tokens" && reply) {
    const bisSatzende = reply.replace(/\s+\S*$/, "");
    const m = bisSatzende.match(/^[\s\S]*[.!?…]/);
    if (m && m[0].trim().length > 20) reply = m[0].trim();
  }

  // Termin-Marker: auf WhatsApp gibt es keinen Kalender-Button –
  // Marker entfernen (der Termin steht ja im Text bestätigt).
  // Terminanfrage an den Inhaber melden, bevor die Marker entfernt werden
  // Nur bei Kunden eine Terminanfrage anlegen. Spricht der Inhaber ueber
  // Termine, waere das eine Geisteranfrage an ihn selbst.
  // Zurueckgehaltene Nachtmeldungen zustellen, sobald wieder Buerozeit
  // ist und irgendjemand schreibt.
  await warteschlangeZustellen().catch(() => {});
  // Der Wecker laeuft im Hobby-Tarif nur einmal am Tag. Deshalb erledigt
  // jede eingehende Nachricht die faelligen Aufgaben mit: Abbruch-
  // Meldungen, Morgenbriefing, Wochenbericht. Alles ist gegen doppelte
  // Ausfuehrung gesichert.
  await offeneGespraecheMelden().catch(() => {});
  await weckerAufgaben().catch(() => {});

  if (!chef) {
    await meldeTermin({ antwort: reply, kanal: "whatsapp", kundeNr: from,
                        thema: text, ersatzName: profilName });
    // Fotos gehen jetzt zusammen mit der Anfrage-Meldung an Dirk
    // (anfrageFortschreiben), mit Nummer und Name in der Unterschrift.
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

  // Rohfassung MIT Markern fuer den Verlauf: So sieht der Assistent
  // beim naechsten Zug, dass er die Daten schon weitergegeben hat.
  const rohAntwort = String(reply);
  const hatteDaten = RE_KONTAKT.test(rohAntwort) || RE_KVA.test(rohAntwort) ||
                     RE_TERMIN.test(rohAntwort) || RE_BUCHUNG.test(rohAntwort);

  reply = markerRaus(reply);

  // Gedankenstriche und Ausrufezeichen entfernen (wirken maschinell)
  reply = saeubern(reply, true).trim();
  // Leere Antwort: Hat das Modell nur Marker geschickt, ist das ein
  // Abschluss ohne Worte. Dann sagen wir dem Kunden, was jetzt passiert,
  // und fragen NICHT "anders formulieren" (das waere nach gelieferten
  // Daten ein Schlag ins Gesicht).
  if (!reply) {
    // Was hat die KI geliefert? Fuer die Fehlerliste, damit man die
    // Ursache spaeter erkennt.
    const bloecke = (data.content || []).map(b => b.type).join(",") || "keine";
    const marker = (rohAntwort.match(/\[\[([A-Z_]+)\|/g) || []).map(m => m.slice(2, -1)).join(",") || "keine";
    const wer = chef ? "Inhaber" : "Kunde …" + String(from).slice(-4);
    const technik = "stop_reason=" + (data.stop_reason || "?") + ", Blöcke=" + bloecke + ", Marker=" + marker;

    // Zweiter Versuch: nur den sichtbaren Satz nachfordern. Die Marker
    // aus dem ersten Versuch bleiben gueltig (Buchung, Kontakt).
    let zweiter = "";
    try {
      const r2 = await kiFragen("\n\nWICHTIG: Deine letzte Antwort enthielt keinen Text für " +
        (chef ? "Dirk" : "den Kunden") + ". Antworte jetzt mit ein bis zwei kurzen, sichtbaren Sätzen. " +
        "Keine technischen Marker in dieser Antwort.");
      if (r2.ok) {
        const d2 = await r2.json();
        zweiter = saeubern(markerRaus((d2.content || []).filter(b => b.type === "text").map(b => b.text).join("\n")), true).trim();
      }
    } catch (_) {}

    if (zweiter) {
      reply = zweiter;
      await fehlerLog("leer-behoben", "WhatsApp, " + wer + ": erste KI-Antwort ohne Text, zweiter Versuch erfolgreich (" + technik + ")");
    } else {
      const mB = rohAntwort.match(RE_BUCHUNG);
      reply = chef
        ? "Das habe ich gerade nicht hinbekommen. Schreib es mir bitte noch einmal, oder schick \"Hilfe\" für alle Befehle."
        : mB
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
  if (!chef) {
    const mKB = rohAntwort.match(RE_KONTAKT);
    const bu = await buchungVerarbeiten({
      antwort: rohAntwort, kanal: "whatsapp", sitzung: "wa:" + from, kundeNr: from,
      name: ((mKB && mKB[1]) || "").trim(), tel: ((mKB && mKB[2]) || "").trim() || from,
      thema: text, fotos: mediaIds.length
    }).catch(e => { console.error("buchung", e && e.message); return null; });
    if (bu && bu.ok) kalenderZeile = "\n\nIn den Kalender eintragen:\n" + bu.ics;
    else if (bu && bu.korrektur) reply += "\n\n" + bu.korrektur;
  }
  if (kalenderZeile) reply += kalenderZeile;

  await sendeMenschlich(from, reply);
  await logGapIfNeeded(text, reply);   // Wissenslücke still protokollieren

  // ---- Verlauf speichern ---------------------------------------
  await memSet(from, [...messages.map(m => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : text
  })), { role: "assistant", content: hatteDaten ? rohAntwort : reply }].slice(-MAX_TURNS));

  // Lernen: Gespraech anonymisiert ablegen (Kennung = gehashte Nummer,
  // nie die Nummer selbst). Nach LERN_INTERVALL Gespraechen Lernrunde.
  if (!chef) {
    // Offenes Gespraech mitfuehren. Auf WhatsApp ist der Rueckweg zwar
    // vorhanden, aber der Inhaber soll trotzdem sehen, wer angefragt
    // und dann nicht mehr geantwortet hat.
    await anfrageFortschreiben({
      sitzung: "wa:" + from, kanal: "whatsapp", kundeNr: from,
      antwort: rohAntwort, kundentext: text, fotos: mediaIds.length,
      profilName, mediaIds
    }).catch(e => console.error("akte", e && e.message));
    // Jede WhatsApp-Unterhaltung bekommt eine Nummer, damit Dirk sie mit
    // "Uebernehme N" uebernehmen kann (reine Unterhaltung = Status
    // "gespraech", zaehlt nicht als offene Anfrage).
    const akteM = await akteHolenOderAnlegen({ kanal: "whatsapp", kundeNr: from, sitzung: "wa:" + from, status: "gespraech" }).catch(() => null);
    await spiegeln({ kanal: "whatsapp", akte: akteM, kundeText: text, alexText: reply, fotos: mediaIds.length });
    const mKon2 = String(rohAntwort).match(RE_KONTAKT);
    await gespraechMerken({
      sitzung: "wa:" + from, kanal: "whatsapp",
      name: ((mKon2 && mKon2[1]) || "").trim(),
      tel: from,
      thema: String(text || "").slice(0, 160),
      fotos: mediaIds.length,
      abgeschlossen: hatteDaten
    }).catch(() => {});

    try {
      let hsh = 0;
      for (const c of String(from)) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
      const faellig = await gespraechAblegen({
        kennung: "wa" + hsh.toString(36), kanal: "whatsapp",
        verlauf: [...messages.map(m => ({ role: m.role, content: typeof m.content === "string" ? m.content : text })),
                  { role: "assistant", content: rohAntwort }]
      });
      if (faellig) await lernrunde();
    } catch (e) { console.error("lernen", e && e.message); }
  }
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

  if (/^(status|diagnose|test)$/i.test(t)) {
    const marke = "diag:" + Date.now();
    const schreiben = await redis("SET", marke, "ok", "EX", 60);
    const lesen = await redis("GET", marke);
    const verlauf = await memGet(from);
    const notizen = await notesGet();
    const fehler = await jsonLesen("fehlerlog", []);
    const u = speicherUrl();
    const tk = speicherToken();
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
      "Deine Befehle:\n" +
      "ANFRAGEN\n" +
      "• Anfragen – alle offenen mit Name und Nummer\n" +
      "• Anfrage 3 – alles zu Nr. 3 samt Fotos\n" +
      "• Fotos 3 – nur die Fotos zu Nr. 3\n" +
      "• Alle Details – alle offenen samt Fotos\n" +
      "• Angebot 3: 480 Euro, Kotflügel richten – ich schicke es dem Kunden\n" +
      "• Erledigt 3 / Nachfassen 3 – abschließen oder nachhaken\n" +
      "• Übernehme 3 – du schreibst selbst mit dem Kunden, \"Fertig\" beendet\n" +
      "• Mitlesen an / aus – Kundengespräche mitlesen\n" +
      "TERMINE\n" +
      "• Termine / Termine morgen – alle gebuchten Termine\n" +
      "• Voll Donnerstag / Frei Donnerstag – Tag sperren oder öffnen\n" +
      "• Urlaub 1.10. bis 5.10. – Zeitraum sperren\n" +
      "• Absagen 7 / Verschieben 7 Freitag 8-10 – Kunde wird informiert\n" +
      "• Eintragen Donnerstag 11-13 Meier – Telefontermin mitzählen\n" +
      "• Fertig 7 – Auto fertig, Kunde bekommt Abholzeiten\n" +
      "WISSEN\n" +
      "• Merk dir: … – neues Wissen, gilt sofort\n" +
      "• Zeig Notizen / Vergiss 2\n" +
      "• Zeig Lücken / Lücken leeren\n" +
      "• Lernen / Lernen 3 ok / Lernen 3 nein / Gelernt / Lernrunde\n" +
      "SONST\n" +
      "• Protokoll / Protokoll gestern – Gespräche des Tages\n" +
      "• Status – läuft alles?");
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
