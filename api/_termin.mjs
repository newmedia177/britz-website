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
      "Ich kann dem Kunden hier direkt antworten.\n\n" +
      "Schreiben Sie mir dazu:\n" +
      "• \"Termin " + nr + " passt\"\n" +
      "• \"Termin " + nr + " lieber Donnerstag 10 Uhr\""
    : "\nKam über: Website-Chat\n" +
      "Dort erreiche ich den Kunden nicht mehr.\n" +
      "Bitte melden Sie sich selbst" +
      (tel ? ", Nummer siehe oben." : ".");

  for (const n of nummern) await sendWA(n, kopf + fuss);
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
      "Mit \"Termine\" zeige ich Ihnen die offenen an.");
    return true;
  }

  if (eintrag.kanal !== "whatsapp" || !eintrag.kundeNr) {
    await sendWA(vonInhaber,
      "Anfrage " + nr + " kam über die Website. Dort kann ich nicht antworten.\n" +
      "Bitte rufen Sie " + eintrag.name +
      (eintrag.tel ? " unter " + eintrag.tel : "") + " an.");
    return true;
  }

  if (Date.now() - (eintrag.ts || 0) > FENSTER_MS) {
    await sendWA(vonInhaber,
      "Anfrage " + nr + " ist älter als 24 Stunden. WhatsApp lässt mich dann " +
      "nicht mehr von sich aus schreiben.\n" +
      "Bitte melden Sie sich direkt bei " + eintrag.name +
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
    kalender = "\n\nIn den Kalender eintragen:\n" +
      icsAdresse(eintrag.wann,
                 eintrag.titel || "Termin, Autolackiererei in Britz",
                 eintrag.ort || "Haarlemer Straße 48-54, 12359 Berlin");
  }

  const ok = await sendWA(eintrag.kundeNr,
    "Kurze Rückmeldung aus der Werkstatt zu Ihrem Wunschtermin:\n\n" +
    nachricht + kalender);

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
    : "Das Weiterleiten hat nicht geklappt. Bitte melden Sie sich direkt bei " +
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

  const stunde = Number(new Date().toLocaleString("de-DE",
    { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }));
  const gruss = stunde < 11 ? "Guten Morgen" : (stunde < 18 ? "Guten Tag" : "Guten Abend");

  const liste = await jsonLesen("termine", []);
  const offen = liste.filter(e => Date.now() - (e.ts || 0) < 7 * 86400000);
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
           "Mit \"Termine\" zeige ich Ihnen die offenen an.";
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
