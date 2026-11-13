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

import { jsonLesen, jsonSchreiben, redis, inhaberNummern, sendWA, sendMail, zustellenAnInhaber, fehlerLog,
         istRuhezeit, fetchMitZeit, rufnummerPruefen, sendWABild, RE_KONTAKT, RE_KVA,
         RE_TERMIN } from "./_termin.mjs";

const TAGE_AUFBEWAHRUNG = 30;      // erledigte Anfragen laenger nicht halten
const TAGE_OFFEN_MAX = 90;         // offene Anfragen spaetestens dann weg
const NACHFASS_TAGE = 3;           // Angebot raus, so lange still -> nachfassen?
const ANGEBOT_MAHNUNG_TAGE = 2;    // Anfrage wartet so lange auf Dirks Angebot

const GRAPH = "https://graph.facebook.com/v20.0";

// ---- Datum/Zeit in Berlin ------------------------------------------
export function berlinJetzt() {
  const t = new Intl.DateTimeFormat("de-DE", {
    weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Berlin"
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  return {
    stunde: Number(t.hour), minute: Number(t.minute),
    wochentag: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"].indexOf(t.weekday.replace(".", "")),
    datum: t.year + "-" + t.month + "-" + t.day
  };
}


// ---- Darstellung fuer Dirk -----------------------------------------
// WhatsApp-Nummer "4917612345678" -> "+49 176 12345678" (antippbar)
export function nummerLesbar(n) {
  const z = String(n || "").replace(/\D/g, "");
  if (!z) return "";
  return z.startsWith("49") ? "+49 " + z.slice(2, 5) + " " + z.slice(5) : "+" + z;
}
function erreichbar(a) {
  return a.tel || nummerLesbar(a.kundeNr) || "";
}
function anliegenKurz(a) {
  return [a.schaden, a.fahrzeug, a.thema].filter(Boolean).join(" · ").replace(/\s+/g, " ").slice(0, 160) || "kein Anliegen notiert";
}
function alterText(ts) {
  const t = Math.round((Date.now() - ts) / 86400000);
  return t === 0 ? "heute" : t === 1 ? "seit gestern" : "seit " + t + " Tagen";
}
const STATUS_TEXT = { neu: "wartet auf dein Angebot", angebot: "Angebot ist raus", termin: "Termin gebucht", erledigt: "erledigt", gespraech: "nur Gespräch" };

export function anfrageDetail(a) {
  const z = [];
  z.push("📋 Anfrage Nr. " + a.nr + (a.kanal === "web" ? " (Website)" : " (WhatsApp)"));
  z.push("────────");
  z.push("Kunde: " + (a.name || "Name nicht genannt"));
  z.push("Erreichbar: " + (erreichbar(a) || "keine Nummer, kam über die Website"));
  if (a.schaden) z.push("Schadensart: " + a.schaden);
  if (a.fahrzeug) z.push("Fahrzeug: " + a.fahrzeug);
  if (a.thema) z.push("Anliegen: " + a.thema);
  if (a.notizen && a.notizen.length) z.push("Kunde schrieb:\n" + a.notizen.map(n => "„" + n + "“").join("\n"));
  z.push("Fotos: " + (a.fotos || 0) + ((a.medien || []).length ? " (abrufbar mit \"Fotos " + a.nr + "\")" : a.fotos ? " (vor dem 13.11. eingegangen, nicht mehr abrufbar)" : ""));
  z.push("Status: " + (STATUS_TEXT[a.status] || a.status) + ", " + alterText(a.ts));
  if (a.termin) z.push("Termin: " + a.termin);
  if (a.angebot) z.push("Angebot: " + a.angebot);
  if (a.verlauf && a.verlauf.length) z.push("Verlauf: " + a.verlauf.slice(-4).join(" · "));
  z.push("");
  z.push(a.status === "neu"
    ? "Weiter: \"Angebot " + a.nr + ": 480 Euro, …\" · \"Übernehme " + a.nr + "\" · \"Erledigt " + a.nr + "\""
    : "Weiter: \"Übernehme " + a.nr + "\" · \"Erledigt " + a.nr + "\"");
  return z.join("\n");
}

// Meldung an Dirk: tagsueber sofort, nachts in die Morgen-Sammlung.
async function anDirk(text, kurz, bilder) {
  if (istRuhezeit()) {
    const l = await jsonLesen("wartend", []);
    l.push({ text, bilder: bilder || [], ts: Date.now() });
    await jsonSchreiben("wartend", l.slice(-30));
    return true;
  }
  return zustellenAnInhaber(text, { kurz, bilder: bilder || [] });
}

// Fotos einer Akte an eine Nummer schicken. Rueckgabe: Anzahl.
async function fotosSenden(an, a) {
  let n = 0;
  for (const id of (a.medien || [])) {
    if (await sendWABild(an, id, "Nr. " + a.nr + " · " + (a.name || "Kunde") + (a.medien.length > 1 ? " (" + (n + 1) + "/" + a.medien.length + ")" : ""))) n++;
  }
  return n;
}

// ---- Akte anlegen / fortschreiben ----------------------------------
async function alleLaden() {
  const liste = await jsonLesen("anfragen", []);
  // Erledigte und reine Gespraeche nach 30 Tagen weg. Offene Anfragen
  // bleiben bis 90 Tage, sonst verschwinden genau die, die liegen.
  const jetzt = Date.now();
  const frisch = liste.filter(a => ["erledigt", "gespraech"].includes(a.status)
    ? (a.letzterKontakt || a.ts) > jetzt - TAGE_AUFBEWAHRUNG * 86400000
    : a.ts > jetzt - TAGE_OFFEN_MAX * 86400000);
  if (frisch.length !== liste.length) await jsonSchreiben("anfragen", frisch);
  return frisch;
}

// Wird nach jeder Kundenantwort aufgerufen. Legt bei Bedarf eine Akte an
// und traegt nach, was neu bekannt wurde. Rueckgabe: Akte oder null.
export async function anfrageFortschreiben({ sitzung, kanal, kundeNr, antwort, kundentext, fotos, profilName, mediaIds }) {
  if (!sitzung) return null;
  const a = String(antwort || "");
  const mK = a.match(RE_KONTAKT), mV = a.match(RE_KVA), mT = a.match(RE_TERMIN);
  const mB = /\[\[BUCHUNG\|/.test(a);
  const relevant = mK || mV || mT || mB || (fotos > 0);
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
  const warLead = akte.status !== "gespraech" && akte.gemeldetNeu;
  if (akte.status === "gespraech" && relevant) akte.status = "neu";
  if (mK) { akte.name = (mK[1] || "").trim().slice(0, 60) || akte.name;
            akte.tel  = (mK[2] || "").trim().slice(0, 40) || akte.tel; }
  // WhatsApp liefert den Profilnamen mit: besser als "Name unbekannt"
  if (!akte.name && profilName) akte.name = String(profilName).trim().slice(0, 60);
  if (mV) { akte.schaden  = (mV[1] || "").trim().slice(0, 60) || akte.schaden;
            akte.fahrzeug = (mV[2] || "").trim().slice(0, 120) || akte.fahrzeug; }
  if (mT) { akte.status = akte.status === "erledigt" ? "erledigt" : "termin";
            akte.termin = (mT[1] || "").trim(); }
  // Was der Kunde selbst geschrieben hat (ohne Platzhalter wie "(Foto vom
  // Schaden)"), damit Dirk die Anfrage versteht, ohne nachzufragen.
  const echt = String(kundentext || "").trim();
  if (echt && !/^\(.*\)$/.test(echt) && echt.length > 3) {
    if (!akte.thema) akte.thema = echt.slice(0, 140);
    akte.notizen = [...(akte.notizen || []), echt.slice(0, 300)].slice(-6);
  }
  akte.fotos += fotos || 0;
  // Foto-Kennungen bei WhatsApp, damit Dirk die Bilder spaeter abrufen kann
  // ("Fotos N"). Gespeichert wird nur die Kennung, nicht das Bild.
  if (Array.isArray(mediaIds) && mediaIds.length) akte.medien = [...(akte.medien || []), ...mediaIds].slice(-12);
  akte.letzterKontakt = Date.now();

  // ---- Dirk informieren ------------------------------------------
  // 1) Neue Anfrage: sofort, mit allem Bekannten. Bei einer Buchung meldet
  //    die Buchung selbst, dann hier nichts doppelt.
  const meldungen = [];
  if (akte.status === "neu" && !akte.gemeldetNeu && !mB && !mT) {
    akte.gemeldetNeu = true;
    meldungen.push({
      text: "🆕 Neue Anfrage\n" + anfrageDetail(akte) +
            (akte.medien && akte.medien.length ? "\n\nDie Fotos kommen direkt hinterher." : ""),
      kurz: "Neue Anfrage Nr. " + akte.nr + " · " + (akte.name || "Kunde") + " · " + anliegenKurz(akte).slice(0, 60),
      bilder: akte.medien || []
    });
  } else if (mB || mT) {
    akte.gemeldetNeu = true;
  }
  // 2) Kalkulierbar: Alex hat Schadensart/Fahrzeug eingesammelt.
  if (mV && !akte.gemeldetKVA && akte.status === "neu") {
    akte.gemeldetKVA = true;
    if (warLead || meldungen.length === 0) {
      meldungen.push({
        text: "✅ Anfrage Nr. " + akte.nr + " ist jetzt kalkulierbar\n" + anfrageDetail(akte),
        kurz: "Anfrage Nr. " + akte.nr + " kalkulierbar · " + (akte.name || "Kunde")
      });
    }
  }
  // 3) Weitere Fotos zu einer schon gemeldeten Anfrage: direkt hinterher,
  //    mit der Nummer in der Bildunterschrift.
  const neueMedien = Array.isArray(mediaIds) ? mediaIds : [];
  if (neueMedien.length && !meldungen.some(m => (m.bilder || []).length) && akte.gemeldetNeu) {
    meldungen.push({
      text: "📷 " + neueMedien.length + " neue(s) Foto(s) zu Anfrage Nr. " + akte.nr + " · " + (akte.name || "Kunde") +
            (erreichbar(akte) ? " · " + erreichbar(akte) : "") + "\n" + anliegenKurz(akte),
      kurz: "Fotos zu Nr. " + akte.nr + " · " + (akte.name || "Kunde"),
      bilder: neueMedien
    });
  }
  await jsonSchreiben("anfragen", liste.slice(-120));
  for (const m of meldungen) await anDirk(m.text, m.kurz, m.bilder).catch(() => {});
  return akte;
}

// ---- Akten-Helfer (auch fuer die Buchung) ----------------------------
export async function akteFinden(nr) {
  return (await alleLaden()).find(a => a.nr === Number(nr)) || null;
}
export async function akteSpeichern(akte) {
  const liste = await alleLaden();
  const i = liste.findIndex(a => a.nr === akte.nr);
  if (i >= 0) liste[i] = akte; else liste.push(akte);
  await jsonSchreiben("anfragen", liste.slice(-120));
}
export async function akteHolenOderAnlegen({ kanal, kundeNr, sitzung, name, tel, thema, status }) {
  const liste = await alleLaden();
  let a = (sitzung && liste.find(x => x.sitzung === sitzung)) ||
          (kanal === "whatsapp" && kundeNr && liste.filter(x => x.kundeNr === String(kundeNr) && x.status !== "erledigt").pop());
  if (!a) {
    const nr = (liste.length ? Math.max(...liste.map(x => x.nr)) : 0) + 1;
    a = { nr, sitzung: sitzung || "", kanal, kundeNr: kanal === "whatsapp" ? String(kundeNr || "") : "",
          name: "", tel: "", thema: "", schaden: "", fahrzeug: "", fotos: 0,
          status: status || "neu", ts: Date.now(), verlauf: [] };
    liste.push(a);
  }
  if (name && !a.name) a.name = String(name).slice(0, 60);
  if (tel && !a.tel) a.tel = String(tel).slice(0, 40);
  if (thema && !a.thema) a.thema = String(thema).slice(0, 140);
  a.letzterKontakt = kanal === "whatsapp" ? Date.now() : a.letzterKontakt;
  await jsonSchreiben("anfragen", liste.slice(-120));
  return a;
}

// ---- An den Kunden schreiben (mit ehrlicher Grenze) ------------------
// Rueckgabe: { ok, grund } - bei !ok bekommt Dirk den Text zum Selbstschicken.
export async function anKunde(akte, text, vorlage) {
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

async function anInhaber(text, kurz, art) {
  // Briefing und Wochenbericht entstehen nur tagsueber (siehe
  // weckerAufgaben), deshalb hier keine Nachtliste mehr: Sie kaemen sonst
  // Stunden spaeter mit dem irrefuehrenden Kopf "kam nachts rein".
  return zustellenAnInhaber(text, { kurz, art });
}

function zeile(a) {
  return "Nr. " + a.nr + " · " + (a.name || "Name nicht genannt") + " · " + (erreichbar(a) || "keine Nummer") +
    "\n   " + anliegenKurz(a) + (a.fotos ? " · " + a.fotos + " Foto(s)" : "") +
    "\n   " + (STATUS_TEXT[a.status] || a.status) + ", " + alterText(a.ts) + (a.kanal === "web" ? " · Website" : "");
}

// ---- Befehle vom Inhaber -----------------------------------------
export async function offeneAnfragen() {
  return (await alleLaden()).filter(a => !["erledigt", "gespraech"].includes(a.status));
}

// Lange Texte in WhatsApp-taugliche Stuecke teilen (an Absaetzen)
function stuecke(text, max = 3500) {
  const teile = []; let akt = "";
  for (const absatz of String(text).split("\n\n")) {
    if (akt && (akt + "\n\n" + absatz).length > max) { teile.push(akt); akt = absatz; }
    else akt = akt ? akt + "\n\n" + absatz : absatz;
  }
  if (akt) teile.push(akt);
  return teile;
}

// Dirk fragt frei nach allem ("Schick mir saemtliche Fotos und
// detaillierte Anfragen"). Erkennen ohne KI, damit es sicher klappt.
export function willAlleDetails(s) {
  const t = String(s || "").toLowerCase();
  if (/^(merk|lern|notiz|vergiss|angebot|erledigt|l(ö|oe)sch)/.test(t.trim()) || t.length > 200) return false;
  const menge = /(alle|sämtliche|saemtliche|samtliche|jede|komplett|gesamt|ganzen?)/.test(t);
  const was = /(anfrage|foto|bild|detail)/.test(t);
  return (menge && was) || /^(details|alle details|alles im detail)$/.test(t.trim());
}

export async function anfrageBefehl(t, an) {
  const s = String(t || "").trim();
  let m;

  if (/^(offene\s+)?anfragen\??$/i.test(s)) {
    const offen = await offeneAnfragen();
    return offen.length
      ? "Offene Anfragen (" + offen.length + ")\n────────\n" + offen.map(zeile).join("\n\n") +
        "\n\n\"Anfrage 3\" zeigt alles zu Nr. 3 samt Fotos · \"Alle Details\" schickt alle\n" +
        "\"Angebot 3: 480 Euro, Kotflügel richten und lackieren\" · \"Erledigt 3\""
      : "Keine offenen Anfragen.";
  }

  m = s.match(/^(?:anfrage|nr\.?|details?)\s*(\d+)$/i);
  if (m) {
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht. \"Anfragen\" zeigt die offenen.";
    if (an && (a.medien || []).length) {
      await sendWA(an, anfrageDetail(a));
      await fotosSenden(an, a);
      return "Das waren alle " + a.medien.length + " Foto(s) zu Nr. " + a.nr + ".";
    }
    return anfrageDetail(a);
  }

  m = s.match(/^(?:fotos?|bilder?)\s*(?:von|zu|nr\.?)?\s*(\d+)$/i);
  if (m) {
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    if (!(a.medien || []).length) return a.fotos
      ? "Zu Nr. " + a.nr + " kamen " + a.fotos + " Foto(s), aber vor dem 13.11. habe ich mir die Bilder noch nicht gemerkt. " +
        (erreichbar(a) ? "Bitte beim Kunden nachfragen: " + erreichbar(a) : "")
      : "Zu Nr. " + a.nr + " gibt es keine Fotos.";
    const n = an ? await fotosSenden(an, a) : 0;
    return n ? n + " Foto(s) zu Nr. " + a.nr + " geschickt." : "Die Fotos konnte ich gerade nicht schicken. WhatsApp hält sie etwa 30 Tage bereit.";
  }

  // Alles auf einmal: jede offene Anfrage im Detail, Fotos hinterher
  if (willAlleDetails(s)) {
    const offen = await offeneAnfragen();
    if (!offen.length) return "Es gibt gerade keine offenen Anfragen.";
    const text = "Alle offenen Anfragen im Detail (" + offen.length + ")\n\n" + offen.map(anfrageDetail).join("\n\n");
    if (!an) return text;
    for (const st of stuecke(text)) await sendWA(an, st);
    let fotos = 0, alteFotos = 0;
    for (const a of offen) { fotos += await fotosSenden(an, a); if (a.fotos && !(a.medien || []).length) alteFotos++; }
    return (fotos ? fotos + " Foto(s) sind mitgekommen." : "Fotos konnte ich keine mitschicken.") +
      (alteFotos ? " Bei " + alteFotos + " älteren Anfrage(n) kamen die Fotos vor dem 13.11., die Bilder habe ich mir damals noch nicht gemerkt." : "");
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
    // Bewertungsbitte NICHT automatisch: unaufgefordert kann sie als
    // Werbung ohne Einwilligung gelten. Dirk schickt sie mit
    // "Bewertung N", wenn der Kunde zugestimmt hat.
    const zusatz = process.env.BEWERTUNGS_LINK
      ? " Hat der Kunde gesagt, dass er eine Bewertung schreiben mag? Dann \"Bewertung " + a.nr + "\"." : "";
    return "Anfrage " + a.nr + " abgeschlossen." + zusatz;
  }

  m = s.match(/^bewertung\s+(\d+)$/i);
  if (m) {
    if (!process.env.BEWERTUNGS_LINK) return "Es ist noch kein Bewertungslink hinterlegt (Vercel: BEWERTUNGS_LINK).";
    const a = (await alleLaden()).find(x => x.nr === Number(m[1]));
    if (!a) return "Anfrage " + m[1] + " kenne ich nicht.";
    const text = "Guten Tag" + (a.name ? " " + a.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
      "Vielen Dank, dass Sie bei uns waren. Wie besprochen hier der Link für Ihre Bewertung: " + process.env.BEWERTUNGS_LINK;
    const r = await anKunde(a, text, "WA_VORLAGE_BEWERTUNG");
    return r.ok ? "Bewertungslink an " + (a.name || "den Kunden") + " geschickt."
                : "Konnte nicht schicken (" + r.grund + ")." + (a.tel ? " Bitte selbst an " + a.tel + ":\n\n" + text : "");
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
  const kopf = "Protokoll " + tag.split("-").reverse().join(".") + "\n────────\n" +
    "Gespräche: " + teile.length + " · neue Anfragen: " + akten.length + "\n" +
    (akten.length ? akten.map(a => "· Nr. " + a.nr + " " + (a.name || "ohne Name") + " – " + (a.schaden || a.thema || "").slice(0, 60)).join("\n") + "\n" : "") +
    "(Verläufe anonymisiert: Namen/Nummern durch Platzhalter ersetzt)\n\n";
  if (!teile.length) return kopf + "Keine Gespräche an diesem Tag.";
  return kopf + teile.join("\n\n");
}

// ---- Fehlerzaehler (fuer Wochenbericht und Stoerungsmeldung) ------------
const ART_KLAR = {
  leer: "Die KI hat geantwortet, aber ohne Text für den Gesprächspartner – auch ein zweiter Versuch blieb leer.",
  modell: "Die KI war nicht erreichbar oder hat mit einem Fehler geantwortet.",
  strom: "Die Antwort im Website-Chat ist mittendrin abgebrochen.",
  zustellung: "Eine Meldung an Dirk kam weder per WhatsApp noch per E-Mail an.",
  vorlage: "WhatsApp hat eine Nachrichtenvorlage abgelehnt."
};

export async function fehlerZaehlen(art, grund, ersatz) {
  const tag = berlinJetzt().datum;
  const n = Number(await redis("INCR", "fehler:" + tag + ":" + art)) || 0;
  await redis("EXPIRE", "fehler:" + tag + ":" + art, 8 * 86400);
  await fehlerLog(art, grund || "");
  // Erster Aussetzer des Tages: kurze, verstaendliche Mail an die Technik
  // (nicht an Dirk). Weitere stehen unter "Status".
  if (n === 1 && await einmalHeute("technikmail")) {
    await sendMail("Alex: Aussetzer heute – " + (ersatz ? "Gesprächspartner hat eine Ersatzantwort bekommen" : "bitte kurz prüfen"),
      "Was passiert ist:\n" + (ART_KLAR[art] || art) + "\n\n" +
      "Einzelheiten:\n" + (grund || "keine") + "\n\n" +
      (ersatz ? "Was stattdessen geschickt wurde:\n„" + String(ersatz).slice(0, 300) + "“\n\n" +
                "Handlungsbedarf: keiner, das Gespräch ist nicht abgerissen. Häufen sich solche Fälle, bitte melden.\n\n"
              : "Handlungsbedarf: bitte prüfen.\n\n") +
      "Alle Aussetzer mit Uhrzeit: per WhatsApp „Status“ an Alex. Weitere Mails kommen heute nicht.",
      process.env.TECHNIK_MAIL || process.env.NOTFALL_MAIL);
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
// Einmal pro Kalenderwoche (Montag als Wochenstart)
async function einmalDieseWoche(name) {
  const j = berlinJetzt();
  const d = new Date(j.datum + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const r = await redis("SET", "einmal:" + name + ":" + d.toISOString().slice(0, 10), "1", "NX", "EX", 9 * 86400);
  return r === "OK";
}

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
  if (werktag && j.stunde >= 8 && !istRuhezeit() && await einmalHeute("briefing")) {
    const liste = await alleLaden();
    const offen = liste.filter(a => !["erledigt", "gespraech"].includes(a.status));
    const wartend = offen.filter(a => a.status === "neu");
    const angebote = offen.filter(a => a.status === "angebot");
    const buchungen = (await jsonLesen("buchungen", [])).filter(b => b.status === "aktiv");
    const heute = buchungen.filter(b => b.datum === j.datum).sort((a, b) => a.von - b.von);
    const morgenTag = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const morgen = buchungen.filter(b => b.datum === morgenTag);
    const gesternTag = new Date(Date.now() - 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const gesternNeu = liste.filter(a => new Date(a.ts).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) === gesternTag).length;

    let text = "Guten Morgen Dirk, dein Überblick:\n────────\n" +
      "Heute: " + (heute.length ? heute.length + " von 5\n" + heute.map(b => "· " + b.von + "–" + b.bis + " " + (b.name || "ohne Name") + " (" + b.art + ")").join("\n") : "keine Termine") + "\n\n" +
      "Warten auf dein Angebot: " + wartend.length +
      (wartend.length ? "\n" + wartend.slice(0, 12).map(a => "· Nr. " + a.nr + " " + (a.name || "Name nicht genannt") +
        (erreichbar(a) ? " · " + erreichbar(a) : "") + "\n  " + anliegenKurz(a).slice(0, 90) +
        (a.fotos ? " · " + a.fotos + " Foto(s)" : "") + " · " + alterText(a.ts)).join("\n") +
        (wartend.length > 12 ? "\n· … und " + (wartend.length - 12) + " weitere" : "") : "") + "\n\n" +
      "Angebote raus, noch offen: " + angebote.length + "\n" +
      "Gestern neu: " + gesternNeu + " Anfrage(n)";
    // Terminerinnerung fuer morgen
    for (const b of morgen) {
      const a = liste.find(x => x.nr === b.akteNr) || { kanal: b.kanal, kundeNr: b.kundeNr, name: b.name, letzterKontakt: 0 };
      const ort = b.ort === "kleinmachnow" ? "Albert-Einstein-Ring 45, 14532 Kleinmachnow" : "Haarlemer Straße 48-54, 12359 Berlin";
      const r = await anKunde(a, "Guten Tag" + (b.name ? " " + b.name : "") + ", hier ist Alex von der Autolackiererei in Britz. " +
        "Kurze Erinnerung an Ihren Termin morgen zwischen " + b.von + " und " + b.bis + " Uhr, " + ort + ". Bis morgen!", "WA_VORLAGE_ERINNERUNG");
      text += "\nMorgen " + b.von + "–" + b.bis + " " + (b.name || "ohne Name") + ": " +
        (r.ok ? "Erinnerung geschickt" : "Erinnerung nicht möglich (" + r.grund + ")" + (b.tel ? " – " + b.tel : ""));
    }
    // Mahnung: Anfragen, die zu lange auf ein Angebot warten
    const alt = wartend.filter(a => Date.now() - a.ts > ANGEBOT_MAHNUNG_TAGE * 86400000);
    if (alt.length) text += "\n\n⚠ Länger als " + ANGEBOT_MAHNUNG_TAGE + " Tage ohne Angebot: " + alt.map(a => "Nr. " + a.nr + " " + (a.name || "")).join(", ");
    // Nachfass-Vorschlag
    const still = angebote.filter(a => a.angebotTs && Date.now() - a.angebotTs > NACHFASS_TAGE * 86400000 && !a.nachgefasst);
    if (still.length) text += "\n\nStill seit " + NACHFASS_TAGE + " Tagen nach dem Angebot: " + still.map(a => "Nr. " + a.nr).join(", ") + ". Soll ich nachfassen? → \"Nachfassen " + still[0].nr + "\"";
    text += "\n\n\"Anfrage 3\" zeigt alles zu Nr. 3 samt Fotos, \"Alle Details\" schickt alles auf einmal.";
    const kurzB = (heute.length ? heute.length + " Termin(e) heute" : "Heute keine Termine") +
      (wartend.length ? ", " + wartend.length + " Anfrage(n) warten auf dein Angebot" : "");
    await anInhaber(text, kurzB, "tagesstart");
    erledigt.push("briefing");
  }

  // 2) Wochenbericht, Freitag ab 16 Uhr
  // Freitag ab 16 Uhr. Laeuft der Wecker nur einmal am Tag (Vercel Hobby,
  // morgens) und gab es freitags nach 16 Uhr keine Nachricht, kommt der
  // Bericht am Samstagmorgen.
  if (((j.wochentag === 5 && j.stunde >= 16) || j.wochentag === 6) && !istRuhezeit() && await einmalDieseWoche("wochenbericht")) {
    const liste = await alleLaden();
    const woche = Date.now() - 7 * 86400000;
    const neu = liste.filter(a => a.ts > woche && a.status !== "gespraech");
    const erl = liste.filter(a => a.erledigtTs && a.erledigtTs > woche);
    const ang = liste.filter(a => a.angebotTs && a.angebotTs > woche);
    const k = await jsonLesen("lern:kennzahlen", null);
    const aktiv = await jsonLesen("lern:aktiv", []);
    const offenVorschlaege = await jsonLesen("lern:vorschlaege", []);
    const fehler = await fehlerSumme(7);
    const text = "Wochenbericht\n────────\n" +
      "Neue Anfragen: " + neu.length + " (Website " + neu.filter(a => a.kanal === "web").length + ", WhatsApp " + neu.filter(a => a.kanal === "whatsapp").length + ")\n" +
      "Angebote verschickt: " + ang.length + "\n" +
      "Abgeschlossen: " + erl.length + "\n" +
      "Noch offen gesamt: " + liste.filter(a => !["erledigt", "gespraech"].includes(a.status)).length + "\n" +
      (k ? "Letzte Auswertung (" + k.d + "): Abschlüsse " + k.mit_abschluss + ", Abbrüche " + k.abbrueche + ", Schleifen " + k.schleifen + "\n" : "") +
      "Gelernte Regeln aktiv: " + aktiv.length + (offenVorschlaege.length ? " · " + offenVorschlaege.length + " Vorschläge warten auf dein Ok (\"Lernen\")" : "") + "\n" +
      "Technische Aussetzer diese Woche: " + fehler + (fehler ? " (Einzelheiten: \"Status\")" : "") +
      "\n\nSchönes Wochenende!";
    await anInhaber(text, "Wochenbericht: " + neu.length + " neue Anfrage(n), " + erl.length + " abgeschlossen");
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


// ---- Echter Stand fuer Alex, wenn Dirk schreibt ---------------------
// Ersetzt die alte Terminliste. Alex darf nur hieraus antworten.
export async function chefUeberblick() {
  const offen = await offeneAnfragen();
  const buch = (await jsonLesen("buchungen", [])).filter(b => b.status === "aktiv")
    .sort((a, b) => (a.datum + String(a.von).padStart(2, "0")).localeCompare(b.datum + String(b.von).padStart(2, "0")));
  const z = [];
  z.push("OFFENE ANFRAGEN (" + offen.length + "), Stand jetzt aus dem System:");
  if (!offen.length) z.push("keine");
  for (const a of offen) z.push("- Nr. " + a.nr + ": " + (a.name || "Name nicht genannt") + ", " + (erreichbar(a) || "keine Nummer") +
    ", " + anliegenKurz(a) + ", Fotos: " + (a.fotos || 0) + ((a.medien || []).length ? " (abrufbar)" : a.fotos ? " (nicht mehr abrufbar)" : "") +
    ", " + (STATUS_TEXT[a.status] || a.status) + ", " + alterText(a.ts) + ", " + (a.kanal === "web" ? "Website" : "WhatsApp"));
  z.push("");
  z.push("GEBUCHTE TERMINE (" + buch.length + "):");
  if (!buch.length) z.push("keine");
  for (const b of buch.slice(0, 15)) z.push("- " + b.datum.split("-").reverse().join(".") + " " + b.von + "–" + b.bis + ": " +
    (b.name || "ohne Name") + " (" + b.art + ")" + (b.akteNr ? ", Anfrage Nr. " + b.akteNr : ""));
  return z.join("\n");
}
