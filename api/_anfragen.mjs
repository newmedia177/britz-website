// api/_anfragen.mjs
// Alex als digitaler Mitarbeiter: Jede Kundenanfrage bekommt eine Akte
// mit Status und wird bis zum Ende begleitet.
//
//   neu  ->  angebot  ->  termin  ->  erledigt
//
// Dirk steuert mit Stichworten ("Angebot 3: 480 Euro, Kotfluegel richten
// und lackieren"), Alex uebernimmt die Kundenkommunikation. Wo Meta das
// nicht erlaubt (24-Stunden-Fenster ohne genehmigte Vorlage), sagt Alex
// das offen und gibt Dirk den fertigen Text zum Selbstschicken.

import { jsonLesen, jsonSchreiben, redis, inhaberNummern, sendWA, sendMail,
         istRuhezeit, fetchMitZeit, rufnummerPruefen, RE_KONTAKT, RE_KVA,
         RE_TERMIN } from "./_termin.mjs";

const TAGE_AUFBEWAHRUNG = 30;      // erledigte Anfragen laenger nicht halten
const NACHFASS_TAGE = 3;           // Angebot raus, so lange still -> nachfassen?
const ANGEBOT_MAHNUNG_TAGE = 2;    // Anfrage wartet so lange auf Dirks Angebot

const GRAPH = "https://graph.facebook.com/v20.0";

// ---- Datum/Zeit in Berlin ------------------------------------------
export function berlinJetzt() {
  const t = new Intl.DateTimeFormat("de-DE", {
    weekday: "short", hour: "numeric", minute: "numeric", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin"
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    stunde: Number(t.hour), minute: Number(t.minute),
    wochentag: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"].indexOf(t.weekday.replace(".", "")),
    datum: t.year + "-" + t.month + "-" + t.day
  };
}

// ---- Akte anlegen / fortschreiben ----------------------------------
async function alleLaden() {
  const liste = await jsonLesen("anfragen", []);
  const grenze = Date.now() - TAGE_AUFBEWAHRUNG * 86400000;
  const frisch = liste.filter(a => a.ts > grenze);
  if (frisch.length !== liste.length) await jsonSchreiben("anfragen", frisch);
  return frisch;
}

// Wird nach jeder Kundenantwort aufgerufen. Legt bei Bedarf eine Akte an
// und traegt nach, was neu bekannt wurde. Rueckgabe: Akte oder null.
export async function anfrageFortschreiben({ sitzung, kanal, kundeNr, antwort, kundentext, fotos }) {
  if (!sitzung) return null;
  const a = String(antwort || "");
  const mK = a.match(RE_KONTAKT), mV = a.match(RE_KVA), mT = a.match(RE_TERMIN);
  const relevant = mK || mV || mT || (fotos > 0);
  const liste = await alleLaden();
  let akte = liste.find(x => x.sitzung === sitzung);
  if (!akte && !relevant) return null;          // Smalltalk bekommt keine Akte

  if (!akte) {
    const nr = (liste.length ? Math.max(...liste.map(x => x.nr)) : 0) + 1;
    akte = { nr, sitzung, kanal, kundeNr: kanal === "whatsapp" ? String(kundeNr || "") : "",
             name: "", tel: "", thema: "", schaden: "", fahrzeug: "", fotos: 0,
             status: "neu", ts: Date.now(), verlauf: [] };
    liste.push(akte);
  }
  if (mK) { akte.name = (mK[1] || "").trim().slice(0, 60) || akte.name;
            akte.tel  = (mK[2] || "").trim().slice(0, 40) || akte.tel; }
  if (mV) { akte.schaden  = (mV[1] || "").trim().slice(0, 60) || akte.schaden;
            akte.fahrzeug = (mV[2] || "").trim().slice(0, 120) || akte.fahrzeug; }
  if (mT) { akte.status = akte.status === "erledigt" ? "erledigt" : "termin";
            akte.termin = (mT[1] || "").trim(); }
  if (!akte.thema && kundentext) akte.thema = String(kundentext).slice(0, 140);
  akte.fotos += fotos || 0;
  akte.letzterKontakt = Date.now();
  await jsonSchreiben("anfragen", liste.slice(-120));
  return akte;
}

// ---- An den Kunden schreiben (mit ehrlicher Grenze) ------------------
// Rueckgabe: { ok, grund } - bei !ok bekommt Dirk den Text zum Selbstschicken.
async function anKunde(akte, text, vorlage) {
  if (akte.kanal !== "whatsapp" || !akte.kundeNr) {
    return { ok: false, grund: "Anfrage kam über die Website, dort kann ich nicht mehr schreiben" };
  }
  // Innerhalb von 24 h nach der letzten Kundennachricht darf frei
  // geschrieben werden.
  const frei = akte.letzterKontakt && (Date.now() - akte.letzterKontakt) < 23.5 * 3600000;
  if (frei && await sendWA(akte.kundeNr, text)) return { ok: true };

  // Sonst nur mit genehmigter Meta-Vorlage. Name der Vorlage kommt aus
  // der Umgebung (siehe META_VORLAGEN.md). Ohne Vorlage: ehrlich sagen.
  if (vorlage && process.env[vorlage]) {
    const r = await sendWAVorlage(akte.kundeNr, process.env[vorlage], [akte.name || "Kundin/Kunde", text]);
    if (r) return { ok: true };
    return { ok: false, grund: "Vorlage " + process.env[vorlage] + " wurde von WhatsApp abgelehnt" };
  }
  return { ok: false, grund: "der Kunde hat sich seit über 24 h nicht gemeldet und es ist keine genehmigte WhatsApp-Vorlage hinterlegt" };
}

async function sendWAVorlage(to, name, params) {
  try {
    const r = await fetchMitZeit(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: { name, language: { code: "de" },
          components: [{ type: "body", parameters: params.map(t => ({ type: "text", text: String(t).slice(0, 1000) })) }] }
      })
    }, 10000);
    if (!r.ok) console.error("vorlage", r.status, await r.text().catch(() => ""));
    return r.ok;
  } catch (e) { console.error("vorlage", e && e.message); return false; }
}

async function anInhaber(text) {
  const wartend = istRuhezeit();
  if (wartend) {
    const l = await jsonLesen("wartend", []);
    l.push({ text, bilder: [], ts: Date.now() });
    await jsonSchreiben("wartend", l.slice(-30));
    return true;
  }
  let ok = false;
  for (const n of inhaberNummern()) if (await sendWA(n, text.slice(0, 3900))) ok = true;
  if (!ok) await sendMail("Alex: Meldung nicht zustellbar", text);
  return ok;
}

function zeile(a) {
  const st = { neu: "wartet auf Angebot", angebot: "Angebot raus", termin: "Termin", erledigt: "erledigt" }[a.status] || a.status;
  const alter = Math.round((Date.now() - a.ts) / 86400000);
  return a.nr + ". " + (a.name || "Name unbekannt") +
    (a.tel ? " · " + a.tel : (a.kundeNr ? " · WhatsApp" : " · keine Nummer")) +
    "\n   " + (a.schaden ? a.schaden + " · " : "") + (a.fahrzeug || a.thema || "kein Anliegen notiert") +
    (a.fotos ? " · " + a.fotos + " Foto(s)" : "") +
    "\n   Status: " + st + " · seit " + (alter === 0 ? "heute" : alter + " Tag(en)") +
    (a.kanal === "web" ? " · Website" : "");
}

// ---- Befehle vom Inhaber -----------------------------------------
export async function anfrageBefehl(t) {
  const s = String(t || "").trim();
  let m;

  if (/^anfragen$/i.test(s)) {
    const offen = (await alleLaden()).filter(a => a.status !== "erledigt");
    return offen.length
      ? "Offene Anfragen (" + offen.length + ")\n――――――――――――\n" + offen.map(zeile).join("\n\n") +
        "\n\nBefehle: \"Angebot 3: 480 Euro, Kotflügel richten und lackieren\" · \"Erledigt 3\" · \"Nachfassen 3\" · \"Anfrage 3\""
      : "Keine offenen Anfragen.";
  }

  m = s.match(/^anfrage\s+(\d+)$/i);
  if (m) {
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    return a ? zeile(a) + (a.verlauf.length ? "\n\nVerlauf:\n" + a.verlauf.map(v => "· " + v).join("\n") : "")
             : "Anfrage " + m[1] + " kenne ich nicht.";
  }

  m = s.match(/^angebot\s+(\d+)\s*[:\-–]\s*([\s\S]{3,})$/i);
  if (m) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht. \"Anfragen\" zeigt die offenen.";
    const inhalt = m[2].trim();
    const text = "Guten Tag" + (a.name ? " " + a.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
      "Dirk hat Ihren Schaden kalkuliert: " + inhalt + ". " +
      "Der Kostenvoranschlag ist unverbindlich, der genaue Betrag steht nach der Begutachtung fest. " +
      "Wenn das für Sie passt, schlage ich Ihnen gern einen Termin vor. Bei Fragen erreichen Sie uns unter 030 607 97 930.";
    const r = await anKunde(a, text, "WA_VORLAGE_ANGEBOT");
    a.status = "angebot"; a.angebotTs = Date.now(); a.angebot = inhalt;
    a.verlauf.push(new Date().toLocaleDateString("de-DE") + " Angebot: " + inhalt.slice(0, 80) + (r.ok ? " (an Kunden geschickt)" : " (nicht zustellbar)"));
    await jsonSchreiben("anfragen", liste);
    return r.ok
      ? "Angebot an " + (a.name || "den Kunden") + " geschickt. Ich melde mich, wenn er antwortet oder nach " + NACHFASS_TAGE + " Tagen still bleibt."
      : "Angebot notiert, aber ich konnte es nicht selbst schicken: " + r.grund + ".\n" +
        (a.tel || a.kundeNr ? "Bitte selbst an " + (a.tel || a.kundeNr) + " schicken, hier der Text:\n\n" + text : "Es liegt keine Nummer vor.");
  }

  m = s.match(/^erledigt\s+(\d+)$/i);
  if (m) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    a.status = "erledigt"; a.erledigtTs = Date.now();
    a.verlauf.push(new Date().toLocaleDateString("de-DE") + " erledigt");
    await jsonSchreiben("anfragen", liste);
    let zusatz = "";
    if (process.env.BEWERTUNGS_LINK) {
      const text = "Vielen Dank, dass Sie bei uns waren" + (a.name ? ", " + a.name : "") + ". " +
        "Wenn Sie zufrieden sind, freuen wir uns über eine kurze Bewertung – das hilft einem kleinen Betrieb wie unserem sehr: " +
        process.env.BEWERTUNGS_LINK;
      const r = await anKunde(a, text, "WA_VORLAGE_BEWERTUNG");
      zusatz = r.ok ? " Bewertungsbitte ist raus." : " Bewertungsbitte konnte ich nicht schicken (" + r.grund + ").";
    }
    return "Anfrage " + a.nr + " abgeschlossen." + zusatz;
  }

  m = s.match(/^nachfassen\s+(\d+)$/i);
  if (m) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    const text = "Guten Tag" + (a.name ? " " + a.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
      "Ich wollte kurz nachhören, ob Sie unser Angebot erhalten haben und ob noch Fragen offen sind. " +
      "Wenn Sie möchten, schlage ich Ihnen gern einen Termin vor.";
    const r = await anKunde(a, text, "WA_VORLAGE_NACHFASSEN");
    a.nachgefasst = Date.now();
    a.verlauf.push(new Date().toLocaleDateString("de-DE") + " nachgefasst" + (r.ok ? "" : " (nicht zustellbar)"));
    await jsonSchreiben("anfragen", liste);
    return r.ok ? "Nachgefasst bei " + (a.name || "dem Kunden") + "."
                : "Konnte nicht nachfassen: " + r.grund + "." + (a.tel ? " Nummer: " + a.tel : "");
  }

  if (/^protokoll(\s+gestern)?$/i.test(s)) {
    const gestern = /gestern/i.test(s);
    const d = new Date(Date.now() - (gestern ? 86400000 : 0));
    const tag = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    return await protokoll(tag);
  }

  return null;
}

// ---- Protokoll (anonymisierte Verlaeufe + Akten) ---------------------
async function protokoll(tag) {
  const idx = await jsonLesen("lern:index", []);
  const teile = [];
  for (const k of idx) {
    let g = null;
    try { g = JSON.parse(await redis("GET", "lern:g:" + k)); } catch (_) {}
    if (!g) continue;
    const gTag = new Date(g.ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    if (gTag !== tag) continue;
    const uhr = new Date(g.ts).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
    teile.push("▶ " + uhr + " · " + (g.kanal === "web" ? "Website" : "WhatsApp") + "\n" +
      g.zuege.map(z => (z.wer === "Alex" ? "  Alex: " : "  Kunde: ") + z.text.replace(/\n+/g, " ").slice(0, 220)).join("\n"));
  }
  const akten = (await alleLaden()).filter(a => new Date(a.ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) === tag);
  const kopf = "Protokoll " + tag.split("-").reverse().join(".") + "\n――――――――――――\n" +
    "Gespräche: " + teile.length + " · neue Anfragen: " + akten.length + "\n" +
    (akten.length ? akten.map(a => "· Nr. " + a.nr + " " + (a.name || "ohne Name") + " – " + (a.schaden || a.thema || "").slice(0, 60)).join("\n") + "\n" : "") +
    "(Verläufe anonymisiert: Namen/Nummern durch Platzhalter ersetzt)\n\n";
  if (!teile.length) return kopf + "Keine Gespräche an diesem Tag.";
  return kopf + teile.join("\n\n");
}

// ---- Fehlerzaehler (fuer Wochenbericht und Stoerungsmeldung) ------------
export async function fehlerZaehlen(art) {
  const tag = berlinJetzt().datum;
  const n = Number(await redis("INCR", "fehler:" + tag + ":" + art)) || 0;
  await redis("EXPIRE", "fehler:" + tag + ":" + art, 8 * 86400);
  // Ab 5 Ausfaellen am Tag: Stoerungsmeldung an die Agentur, einmal.
  if (n === 5) {
    await sendMail("Alex: Störung – " + art + " heute " + n + "×",
      "Der Assistent musste heute " + n + "-mal auf einen Notsatz ausweichen (" + art + "). " +
      "Bitte Vercel-Logs und Upstash/Anthropic-Status prüfen.");
  }
  return n;
}

async function fehlerSumme(tage) {
  const arten = ["modell", "strom", "leer", "whatsapp"];
  let summe = 0;
  for (let i = 0; i < tage; i++) {
    const tag = new Date(Date.now() - i * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    for (const a of arten) summe += Number(await redis("GET", "fehler:" + tag + ":" + a)) || 0;
  }
  return summe;
}

// ---- Wecker-Aufgaben (aus api/cron.js) --------------------------------
// Morgenbriefing um 8 Uhr an Werktagen, Wochenbericht freitags 16 Uhr,
// Terminerinnerung fuer morgen, Mahnung bei liegenden Angeboten,
// Nachfass-Vorschlag bei stillen Angeboten. Jede Aufgabe laeuft pro Tag
// hoechstens einmal (Marke im Speicher).
async function einmalHeute(name) {
  const tag = berlinJetzt().datum;
  const r = await redis("SET", "einmal:" + name + ":" + tag, "1", "NX", "EX", 2 * 86400);
  return r === "OK";
}

export async function weckerAufgaben() {
  const j = berlinJetzt();
  const werktag = j.wochentag >= 1 && j.wochentag <= 5;
  const erledigt = [];

  // 1) Morgenbriefing, Werktage ab 8 Uhr
  if (werktag && j.stunde >= 8 && await einmalHeute("briefing")) {
    const liste = await alleLaden();
    const offen = liste.filter(a => a.status !== "erledigt");
    const wartend = offen.filter(a => a.status === "neu");
    const angebote = offen.filter(a => a.status === "angebot");
    const termine = await jsonLesen("termine", []);
    const heute = termine.filter(t => String(t.wann || "").startsWith(j.datum));
    const morgenTag = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const morgen = termine.filter(t => String(t.wann || "").startsWith(morgenTag));
    const gesternTag = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const gesternNeu = liste.filter(a => new Date(a.ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) === gesternTag).length;

    let text = "Guten Morgen Dirk, dein Überblick:\n――――――――――――\n" +
      "Heute: " + (heute.length ? heute.map(t => (t.wann || "").slice(11, 16) + " " + t.name).join(", ") : "keine Termine") + "\n" +
      "Warten auf dein Angebot: " + wartend.length + (wartend.length ? " (" + wartend.map(a => "Nr. " + a.nr).join(", ") + ")" : "") + "\n" +
      "Angebote raus, noch offen: " + angebote.length + "\n" +
      "Gestern neu: " + gesternNeu + " Anfrage(n)";
    // Terminerinnerung fuer morgen
    for (const t of morgen) {
      const a = liste.find(x => x.termin === t.wann) || { kanal: t.kanal, kundeNr: t.kundeNr, name: t.name, letzterKontakt: 0 };
      const r = await anKunde(a, "Guten Tag " + (t.name || "") + ", hier ist Alex von der Autolackiererei in Britz. " +
        "Kurze Erinnerung an Ihren Termin morgen um " + (t.wann || "").slice(11, 16) + " Uhr, " +
        (t.ort || "Haarlemer Straße 48-54, 12359 Berlin") + ". Bis morgen!", "WA_VORLAGE_ERINNERUNG");
      text += "\nMorgen " + (t.wann || "").slice(11, 16) + " " + t.name + ": " +
        (r.ok ? "Erinnerung geschickt" : "Erinnerung nicht möglich (" + r.grund + ")" + (t.tel ? " – " + t.tel : ""));
    }
    // Mahnung: Anfragen, die zu lange auf ein Angebot warten
    const alt = wartend.filter(a => Date.now() - a.ts > ANGEBOT_MAHNUNG_TAGE * 86400000);
    if (alt.length) text += "\n\n⚠ Länger als " + ANGEBOT_MAHNUNG_TAGE + " Tage ohne Angebot: " + alt.map(a => "Nr. " + a.nr + " " + (a.name || "")).join(", ");
    // Nachfass-Vorschlag
    const still = angebote.filter(a => a.angebotTs && Date.now() - a.angebotTs > NACHFASS_TAGE * 86400000 && !a.nachgefasst);
    if (still.length) text += "\n\nStill seit " + NACHFASS_TAGE + " Tagen nach dem Angebot: " + still.map(a => "Nr. " + a.nr).join(", ") + ". Soll ich nachfassen? → \"Nachfassen " + still[0].nr + "\"";
    text += "\n\n\"Anfragen\" zeigt alles im Detail.";
    await anInhaber(text);
    erledigt.push("briefing");
  }

  // 2) Wochenbericht, Freitag ab 16 Uhr
  if (j.wochentag === 5 && j.stunde >= 16 && await einmalHeute("wochenbericht")) {
    const liste = await alleLaden();
    const woche = Date.now() - 7 * 86400000;
    const neu = liste.filter(a => a.ts > woche);
    const erl = liste.filter(a => a.erledigtTs && a.erledigtTs > woche);
    const ang = liste.filter(a => a.angebotTs && a.angebotTs > woche);
    const k = await jsonLesen("lern:kennzahlen", null);
    const aktiv = await jsonLesen("lern:aktiv", []);
    const offenVorschlaege = await jsonLesen("lern:vorschlaege", []);
    const fehler = await fehlerSumme(7);
    const text = "Wochenbericht\n――――――――――――\n" +
      "Neue Anfragen: " + neu.length + " (Website " + neu.filter(a => a.kanal === "web").length + ", WhatsApp " + neu.filter(a => a.kanal === "whatsapp").length + ")\n" +
      "Angebote verschickt: " + ang.length + "\n" +
      "Abgeschlossen: " + erl.length + "\n" +
      "Noch offen gesamt: " + liste.filter(a => a.status !== "erledigt").length + "\n" +
      (k ? "Letzte Auswertung (" + k.d + "): Abschlüsse " + k.mit_abschluss + ", Abbrüche " + k.abbrueche + ", Schleifen " + k.schleifen + "\n" : "") +
      "Gelernte Regeln aktiv: " + aktiv.length + (offenVorschlaege.length ? " · " + offenVorschlaege.length + " Vorschläge warten auf dein Ok (\"Lernen\")" : "") + "\n" +
      "Technische Aussetzer diese Woche: " + fehler + (fehler ? " (Julian ist informiert)" : "") +
      "\n\nSchönes Wochenende!";
    await anInhaber(text);
    erledigt.push("wochenbericht");
  }

  return erledigt;
}

// ---- Kontext fuer Alex im Gespraech ------------------------------------
// Damit Alex im WhatsApp-Gespraech weiss, wo die Akte steht.
export async function akteKontext(kundeNr) {
  if (!kundeNr) return "";
  const a = (await alleLaden()).filter(x => x.kundeNr === String(kundeNr) && x.status !== "erledigt").pop();
  if (!a) return "";
  const st = { neu: "Dirk kalkuliert noch, kein Angebot bisher", angebot: "Angebot ist raus: " + (a.angebot || ""), termin: "Termin ist vorgemerkt" }[a.status] || "";
  return "\n\nStand dieses Kunden (Anfrage Nr. " + a.nr + "): " + st + ". Beziehe dich darauf, statt von vorn zu beginnen; frag nicht erneut nach Dingen, die schon vorliegen" +
    (a.schaden ? " (Schadensart: " + a.schaden + ")" : "") + (a.fahrzeug ? " (Fahrzeug: " + a.fahrzeug + ")" : "") + ".";
}

// ---- Uebergabe Website -> WhatsApp ---------------------------------
// Nennt der Kunde im Web-Chat seine WhatsApp-Nummer, schreibt Alex ihn
// dort an, damit das Gespraech einen dauerhaften Kanal bekommt. Das ist
// eine unternehmensseitig begonnene Nachricht und geht bei Meta NUR mit
// genehmigter Vorlage (WA_VORLAGE_UEBERGABE). Ohne Vorlage: kein Versand,
// aber die Akte merkt sich die Nummer fuer Dirk.
export function nummerInternational(roh) {
  let n = String(roh || "").replace(/[^\d+]/g, "");
  if (n.startsWith("+")) n = n.slice(1);
  if (n.startsWith("00")) n = n.slice(2);
  else if (n.startsWith("0")) n = "49" + n.slice(1);
  return /^\d{10,15}$/.test(n) ? n : "";
}

export async function uebergabeAnWhatsApp(akte) {
  if (!akte || akte.kanal !== "web" || akte.uebergeben) return { ok: false, grund: "" };
  const nr = nummerInternational(akte.tel);
  if (!nr) return { ok: false, grund: "keine gültige Nummer" };
  if (!process.env.WA_VORLAGE_UEBERGABE) return { ok: false, grund: "keine Vorlage hinterlegt" };
  const ok = await sendWAVorlage(nr, process.env.WA_VORLAGE_UEBERGABE,
    [akte.name || "Kundin/Kunde", (akte.schaden || akte.thema || "Ihre Anfrage").slice(0, 120)]);
  if (ok) {
    const liste = await alleLaden();
    const a = liste.find(x => x.nr === akte.nr);
    if (a) { a.uebergeben = true; a.kundeNr = nr; a.verlauf.push(new Date().toLocaleDateString("de-DE") + " auf WhatsApp übergeben"); await jsonSchreiben("anfragen", liste); }
  }
  return { ok, grund: ok ? "" : "Vorlage abgelehnt" };
}
