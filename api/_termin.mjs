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
    .replace(RE_TERMIN, "")
    .replace(RE_TERMIN_OK, "")
    .replace(RE_KONTAKT, "")
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

export async function redis(...befehl) {
  const url = speicherUrl();
  const tok = speicherToken();
  if (!url || !tok) return undefined;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify(befehl.map(String))
    });
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
        type: "image",
        image: { id: String(mediaId), caption: String(unterschrift || "").slice(0, 1000) }
      })
    });
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
    const r = await fetch(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/media`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: form
    });
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
export async function sendMail(betreff, text) {
  const key = process.env.RESEND_API_KEY;
  const an = process.env.NOTFALL_MAIL || "schaden@alb.berlin";
  if (!key) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
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
    });
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
        text: { preview_url: false, body: String(body).slice(0, 4000) }
      })
    });
    if (!r.ok) console.error("send", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) {
    console.error("send", e);
    return false;
  }
}

function inhaberNummern() {
  return (process.env.OWNER_NUMBERS || "")
    .split(",").map(s => s.replace(/\D/g, "")).filter(Boolean);
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
export async function leiteBilderWeiter({ kanal, mediaIds, base64Bilder, name, tel, hinweis }) {
  const nummern = inhaberNummern();
  if (!nummern.length) return false;

  const wer = [
    kanal === "whatsapp" ? "WhatsApp" : "Website-Chat",
    name && name !== "Name nicht genannt" ? name : null,
    tel || null
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
    await sendMail("Kunde hat Fotos geschickt (WhatsApp nicht zustellbar)",
      wer + "\n\n" + (hinweis || "") + "\n\n" +
      ids.length + " Bild(er) konnten nicht per WhatsApp zugestellt werden. " +
      "Schreiben Sie Alex kurz etwas, dann läuft es wieder über WhatsApp.");
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
    hour: "numeric", hour12: false, timeZone: "Europe/Berlin"
  }).formatToParts(d).find(p => p.type === "hour").value);
  return std < RUHE_BIS || std >= RUHE_VON;
}

// Zurückgehaltene Meldungen ablegen
async function warteschlangeAnhaengen(text, bilder) {
  const liste = await jsonLesen("wartend", []);
  liste.push({ text, bilder: Array.isArray(bilder) ? bilder : [], ts: Date.now() });
  await jsonSchreiben("wartend", liste.slice(-30));
}

// Beim nächsten Kontakt in der Bürozeit alles Zurückgehaltene zustellen.
// Wird bei jeder eingehenden Nachricht aufgerufen.
export async function warteschlangeZustellen() {
  if (istRuhezeit()) return false;
  const liste = await jsonLesen("wartend", []);
  if (!liste.length) return false;

  const nummern = inhaberNummern();
  if (!nummern.length) return false;

  const kopf = liste.length === 1
    ? "Das kam außerhalb der Bürozeit rein:\n――――――――――――\n"
    : "Das kam außerhalb der Bürozeit rein (" + liste.length + " Vorgänge):\n" +
      "――――――――――――\n";
  const text = kopf + liste.map(e => e.text).join("\n\n――――――――――――\n");

  let zugestellt = false;
  for (const n of nummern) {
    if (await sendWA(n, text.slice(0, 3900))) zugestellt = true;
  }
  // Zurückgehaltene Bilder hinterherschicken. Die Medien-Kennung bleibt
  // bei Meta gültig, wir haben nichts gespeichert.
  if (zugestellt) {
    for (const e of liste) {
      for (const id of (e.bilder || [])) {
        for (const n of nummern) {
          await sendWABild(n, id, "Nachgereicht: " +
            String(e.text || "").split("\n")[1] || "Kundenfoto");
        }
      }
    }
    await jsonSchreiben("wartend", []);
    return true;
  }
  // Zustellung nicht möglich (24-Stunden-Fenster zu). Liste behalten und
  // erst nach 12 Stunden per E-Mail nachreichen, statt sie zu verlieren.
  const aeltest = Math.min(...liste.map(e => e.ts || Date.now()));
  if (Date.now() - aeltest > 12 * 3600000) {
    await sendMail("Offene Anfragen (WhatsApp nicht zustellbar)", text);
    await jsonSchreiben("wartend", []);
  }
  return false;
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
      "――――――――――――\n" +
      "Kunde: " + vorhanden.name + "\n" +
      (vorhanden.tel ? "Telefon: " + vorhanden.tel + "\n" : "") +
      "Bisher: " + datumLesbar(alteZeit) + "\n" +
      "Neu: " + datumLesbar(wann) + "\n\n" +
      (vorhanden.kanal === "whatsapp"
        ? "Antworten Sie mit \"Termin " + vorhanden.nr + " passt\"."
        : "Kam über die Website, bitte selbst melden.");
    for (const n of nummern) await sendWA(n, text);
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
    "――――――――――――\n" +
    "Kunde: " + eintrag.name + "\n" +
    (tel ? "Telefon: " + tel + "\n" : "") +
    "Wunschtermin: " + datumLesbar(eintrag.wann) + "\n" +
    (thema ? "Anliegen: " + String(thema).slice(0, 140) + "\n" : "");

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

  let zugestellt = false;
  for (const n of nummern) {
    if (await sendWA(n, meldung)) zugestellt = true;
  }
  // Kam die Meldung bei niemandem an (meist: seit über 24 Stunden keine
  // Nachricht vom Inhaber, WhatsApp blockt dann frei formulierte Texte),
  // geht sie per E-Mail raus. Sonst ginge eine Terminanfrage still verloren.
  if (!zugestellt) {
    await sendMail("Neue Terminanfrage Nr. " + nr + " (WhatsApp nicht zustellbar)",
      meldung + "\n\n――――――――――――\n" +
      "Diese Meldung kam per E-Mail, weil WhatsApp sie nicht zustellen konnte. " +
      "Das passiert, wenn seit mehr als 24 Stunden keine Nachricht an Alex " +
      "geschickt wurde. Schreiben Sie Alex kurz etwas, dann läuft es wieder " +
      "über WhatsApp.");
  }
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
    hour: "numeric", hour12: false, timeZone: "Europe/Berlin"
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
