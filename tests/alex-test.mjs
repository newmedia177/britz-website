#!/usr/bin/env node
// tests/alex-test.mjs - Gesamttest fuer Alex, ohne echte Dienste.
// Aufruf im Projektordner:  node tests/alex-test.mjs
// Alle Netzaufrufe (KI, WhatsApp, Upstash, Resend) werden nachgebildet.
// Am Ende steht "X von Y bestanden". Vor jedem Deploy laufen lassen.

process.env.ANTHROPIC_API_KEY = "test";
process.env.OWNER_NUMBERS = "491700000001";
process.env.WHATSAPP_TOKEN = "t";
process.env.WHATSAPP_PHONE_ID = "1";
process.env.UPSTASH_REDIS_REST_URL = "https://test.upstash.io";
process.env.UPSTASH_REDIS_REST_TOKEN = "y";
process.env.RESEND_API_KEY = "r";
process.env.TEST_LEERLAUF_MS = "1500";

const DIRK = "491700000001", KUNDE = "4917612345678";
let kiSystem = "", sp = {}, gesendet = [], fensterOffen = true, kiAntwort = "Gern.", kiStrom = null, kiFolge = [];
const enc = new TextEncoder();

global.fetch = async (u, o = {}) => {
  u = String(u);
  if (u.includes("upstash")) {
    const b = JSON.parse(o.body), [c, k, v] = b;
    const r = x => ({ ok: true, json: async () => ({ result: x }) });
    if (c === "SET") { if (b.includes("NX") && sp[k] !== undefined) return r(null); sp[k] = v; return r("OK"); }
    if (c === "GET") return r(sp[k] ?? null);
    if (c === "DEL") { delete sp[k]; return r(1); }
    if (c === "INCR") { sp[k] = String((Number(sp[k]) || 0) + 1); return r(Number(sp[k])); }
    return r(null);
  }
  if (u.includes("resend")) { gesendet.push({ an: "mail", text: JSON.parse(o.body).subject }); return { ok: true, text: async () => "" }; }
  if (u.includes("anthropic")) {
    const body = JSON.parse(o.body);
    if (body.stream) {
      if (kiStrom === "haengt") return { ok: true, body: new ReadableStream({ pull() { return new Promise(() => {}); } }) };
      const teile = kiStrom || [kiAntwort]; let i = 0;
      return { ok: true, body: new ReadableStream({ pull(c) {
        if (i < teile.length) c.enqueue(enc.encode("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: teile[i++] } }) + "\n\n"));
        else c.close(); } }) };
    }
    kiSystem = JSON.stringify(body.system || "");
    const t = kiFolge.length ? kiFolge.shift() : kiAntwort;
    return { ok: true, json: async () => ({ content: t === "" ? [] : [{ type: "text", text: t }], stop_reason: "end_turn" }) };
  }
  if (u.includes("/messages")) {
    const b = JSON.parse(o.body);
    if (b.to === DIRK && b.type !== "template" && !fensterOffen) return { ok: false, status: 400, text: async () => "131047" };
    gesendet.push({ an: b.to === DIRK ? "dirk" : "kunde", typ: b.type, text: b.text?.body || (b.template ? "[Vorlage " + b.template.name + "]" : "[Bild " + (b.image?.caption || "") + "]") });
    return { ok: true, json: async () => ({}), text: async () => "" };
  }
  return { ok: false, text: async () => "" };
};

const R = Date;
const uhr = iso => { global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(iso); } static now() { return new R(iso).getTime(); } }; };
const reset = () => { sp = {}; gesendet = []; fensterOffen = true; kiAntwort = "Gern."; kiStrom = null; kiFolge = []; };

const stumm = console.error; console.error = () => {};
const log = console.log; console.log = () => {};
const T = await import("../api/_termin.mjs");
const B = await import("../api/_buchung.mjs");
const A = await import("../api/_anfragen.mjs");
const { default: chat } = await import("../api/chat.js");
const { default: wa } = await import("../api/whatsapp.js");

let ok = 0, n = 0;
const pruefe = (name, bed) => { n++; if (bed) ok++; log((bed ? "OK     " : "FEHLER ") + name); };
const res = () => ({ out: [], ende: false, setHeader() {}, writeHead() {}, status() { return this; }, json() {}, send() {}, write(s) { this.out.push(s); }, end() { this.ende = true; } });
const sichtbar = r => T.markerRaus(r.out.filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6).trim())).join("")).trim();
let mid = 0;
const waNachricht = (von, text, typ = "text") => wa({ method: "POST", query: {}, headers: {}, body: { entry: [{ changes: [{ value: {
  contacts: [{ profile: { name: "Test" } }],
  messages: [{ id: "m" + (++mid), from: von, timestamp: "1", ...(typ === "button" ? { type: "button", button: { text } } : typ === "bild" ? { type: "image", image: { id: "foto" + mid, caption: text } } : { type: "text", text: { body: text } }) }] } }] }] } }, res());
const buche = (s, d, f, art = "begutachtung", ort = "") => B.buchungVerarbeiten({ antwort: "Steht. [[KONTAKT|Kunde " + s + "|0176 1" + s + "]]\n[[BUCHUNG|" + d + "|" + f + "|" + art + (ort ? "|" + ort : "") + "]]", kanal: "web", sitzung: "s" + s, thema: "Delle" });

// ---- 1. Web-Chat: nie eine leere Blase -------------------------------
log("\n1. Web-Chat");
uhr("2026-10-22T08:00:00Z");
for (const [name, strom] of [["normal", ["Danke, notiert."]], ["nur Marker", ["[[KONTAKT|Kunde|0175 4383884]]", "\n[[KVA|Selbstzahler|Smart|1 Bild]]"]], ["Strom haengt", "haengt"]]) {
  reset(); kiStrom = strom; const r = res();
  await chat({ method: "POST", body: { messages: [{ role: "user", content: "0175 4383884" }], sitzung: "w" + name } }, r);
  pruefe("Web " + name + ": sichtbarer Text", sichtbar(r).length > 5);
}
reset(); kiAntwort = "Ihr Termin steht.\n[[KONTAKT|Sommer|01761234567]]\n[[BUCHUNG|2026-10-23|11-13|begutachtung]]";
{ const r = res(); let vorEnde = false; const alt = r.end; r.end = function () { vorEnde = gesendet.some(g => g.an === "dirk" && /Neuer Termin/.test(g.text)); alt.call(this); };
  await chat({ method: "POST", body: { messages: [{ role: "user", content: "Freitag 11-13" }], sitzung: "wbuch" } }, r);
  pruefe("Web-Buchung: Dirk informiert VOR Antwortende", vorEnde);
  pruefe("Web-Buchung: Kalenderkarte im Strom", r.out.join("").includes("TERMIN_OK")); }

// ---- 2. Buchungsregeln -------------------------------------------------
log("\n2. Buchungsregeln");
reset(); uhr("2026-09-23T05:30:00Z");
pruefe("Mo ab 9", JSON.stringify(B.fensterAm("2026-09-28")) === "[[9,10],[11,13],[14,17]]");
pruefe("Fr bis 15", JSON.stringify(B.fensterAm("2026-09-25")) === "[[8,10],[11,13],[14,15]]");
pruefe("Wochenende + Feiertag zu", !B.fensterAm("2026-09-26").length && !B.fensterAm("2026-10-03").length);
pruefe("10-11 tabu", !(await buche("a", "2026-09-23", "10-11")).ok);
pruefe("07:30 -> 8-10 erlaubt", (await buche("b", "2026-09-23", "8-10")).ok);
uhr("2026-09-23T07:10:00Z");
pruefe("09:10 -> 8-10 zu knapp", !(await buche("c", "2026-09-23", "8-10")).ok);
uhr("2026-09-23T09:30:00Z");
pruefe("11:30 -> laufendes 11-13 erlaubt", (await buche("d", "2026-09-23", "11-13")).ok);
pruefe("Abholung ohne Fertig abgelehnt", !(await buche("f", "2026-09-23", "14-17", "abholung")).ok);
for (const s of ["g", "h", "i"]) await buche(s, "2026-09-23", "14-17");
pruefe("6. Termin am Tag abgelehnt", !(await buche("j", "2026-09-23", "14-17")).ok);
pruefe("Begutachtung Kleinmachnow -> Britz", (await buche("k", "2026-09-24", "11-13", "begutachtung", "kleinmachnow")).buchung.ort === "britz");

// ---- 3. Zustellung an Dirk ----------------------------------------------
log("\n3. Zustellung an Dirk");
reset(); uhr("2026-10-22T09:00:00Z"); delete process.env.WA_VORLAGE_INHABER; fensterOffen = false;
await buche("m", "2026-10-23", "8-10");
pruefe("ohne Vorlage + Fenster zu -> E-Mail", gesendet.some(g => g.an === "mail" && /Neuer Termin/.test(g.text)));
gesendet = []; fensterOffen = true; await waNachricht(DIRK, "Hallo");
pruefe("Dirk schreibt -> Liegengebliebenes kommt", gesendet.some(g => g.an === "dirk" && /Liegengeblieben/.test(g.text)));
pruefe("kein falsches 'nichts Offenes'", !gesendet.some(g => /nichts Offenes/.test(g.text)));
reset(); process.env.WA_VORLAGE_INHABER = "kundenmeldung_alex"; fensterOffen = false;
await buche("n", "2026-10-23", "11-13"); await buche("o", "2026-10-23", "14-15");
pruefe("mit Vorlage: genau ein Anstupser", gesendet.filter(g => g.typ === "template").length === 1);
gesendet = []; fensterOffen = true; await waNachricht(DIRK, "Alles anzeigen", "button");
pruefe("Tipp 'Alles anzeigen' liefert beide", gesendet.filter(g => /Liegengeblieben/.test(g.text)).length === 2);
delete process.env.WA_VORLAGE_INHABER;

// ---- 4. WhatsApp-Kunde, Mitlesen, Uebernahme ------------------------------
log("\n4. WhatsApp");
reset(); uhr("2026-10-22T09:00:00Z"); kiAntwort = "Das schauen wir uns gern an.";
await waNachricht(KUNDE, "Delle am Kotfluegel");
pruefe("Kunde bekommt Antwort", gesendet.some(g => g.an === "kunde"));
pruefe("Dirk liest mit", gesendet.some(g => g.an === "dirk" && g.text.includes("💬")));
await waNachricht(DIRK, "Übernehme 1"); gesendet = [];
await waNachricht(KUNDE, "Wie lange dauert das?");
pruefe("Uebernahme: Kunde landet bei Dirk, nicht bei der KI", gesendet.some(g => g.an === "dirk" && g.text.includes("Wie lange")) && !gesendet.some(g => g.an === "kunde"));
gesendet = []; await waNachricht(DIRK, "Termine");
pruefe("Uebernahme: Befehl bleibt Befehl", !gesendet.some(g => g.an === "kunde"));
await waNachricht(DIRK, "Fertig"); gesendet = [];
await waNachricht(KUNDE, "Danke");
pruefe("nach Fertig antwortet Alex wieder", gesendet.some(g => g.an === "kunde"));

// ---- 5. Abgebrochene Gespraeche ------------------------------------------
log("\n5. Abbrueche");
reset(); uhr("2026-10-22T10:00:00Z");
await T.gespraechMerken({ sitzung: "x1", kanal: "web", thema: "Kotfluegel", fotos: 1 });
await T.gespraechMerken({ sitzung: "x1", kanal: "web", name: "Test", thema: "Kotfluegel" });
pruefe("nicht zu frueh gemeldet", (await T.offeneGespraecheMelden()) === 0);
uhr("2026-10-22T10:40:00Z");
pruefe("nach 40 Min gemeldet", (await T.offeneGespraecheMelden()) === 1);
pruefe("kein Doppel", (await T.offeneGespraecheMelden()) === 0);

// ---- 6. Leere KI-Antwort ---------------------------------------------
log("\n6. Leere KI-Antwort");
reset(); uhr("2026-10-22T09:00:00Z");
kiFolge = ["", "Gern, schicken Sie mir ein Foto vom Schaden."];
await waNachricht(KUNDE, "Hallo");
pruefe("leer -> zweiter Versuch erreicht den Kunden", gesendet.some(g => g.an === "kunde" && /Foto vom Schaden/.test(g.text)));
pruefe("behobener Fall: keine Technik-Mail", !gesendet.some(g => g.an === "mail"));
pruefe("behobener Fall steht in der Fehlerliste", JSON.parse(sp["fehlerlog"] || "[]").some(f => f.art === "leer-behoben"));
reset(); uhr("2026-10-22T09:00:00Z");
kiFolge = ["[[KONTAKT|Sommer|01761234567]]\n[[BUCHUNG|2026-10-23|11-13|begutachtung]]", ""];
await waNachricht(KUNDE, "Freitag 11-13 passt");
pruefe("zweimal leer nach Buchung -> Terminbestaetigung statt KV-Satz",
  gesendet.some(g => g.an === "kunde" && /Termin ist eingetragen/.test(g.text)) && !gesendet.some(g => g.an === "kunde" && /Kostenvoranschlag/.test(g.text)));
pruefe("Buchung trotzdem bei Dirk gemeldet", gesendet.some(g => g.an === "dirk" && /Neuer Termin/.test(g.text)));
pruefe("Technik-Mail mit Ersatzantwort", gesendet.some(g => g.an === "mail" && /Ersatzantwort/.test(g.text)));
reset(); uhr("2026-10-22T09:00:00Z");
kiFolge = ["", ""];
await waNachricht(DIRK, "Wie sieht es aus?");
pruefe("Dirk wird geduzt, nicht gesiezt", gesendet.some(g => g.an === "dirk" && /Schreib es mir/.test(g.text)) && !gesendet.some(g => g.an === "dirk" && /Können Sie/.test(g.text)));

// ---- 7. Anfragen fuer Dirk (Video vom 12.11.) -------------------------
log("\n7. Anfragen für Dirk");
reset(); uhr("2026-11-13T09:00:00Z");
kiAntwort = "Danke für das Foto. Welches Fahrzeug ist es?";
await waNachricht(KUNDE, "Kratzer an der Stoßstange", "bild");
const neu = gesendet.find(g => g.an === "dirk" && /Neue Anfrage/.test(g.text));
pruefe("neue Anfrage sofort bei Dirk", !!neu);
pruefe("mit Name aus dem WhatsApp-Profil und Nummer", neu && /Test/.test(neu.text) && /\+49 176 12345678/.test(neu.text));
pruefe("Foto geht mit Nummer in der Unterschrift an Dirk", gesendet.some(g => g.an === "dirk" && g.typ === "image" && /Nr\. 1/.test(g.text)));
gesendet = []; kiAntwort = "Danke, dann kalkulieren wir das. [[KVA|Selbstzahler|VW Golf 2018|1 Bild]]";
await waNachricht(KUNDE, "VW Golf 2018, zahle selbst");
pruefe("kalkulierbar-Meldung folgt", gesendet.some(g => g.an === "dirk" && /kalkulierbar/.test(g.text) && /VW Golf/.test(g.text)));
gesendet = []; await waNachricht(DIRK, "Anfragen");
pruefe("Liste zeigt Nummer statt nur 'WhatsApp'", gesendet.some(g => g.an === "dirk" && /\+49 176 12345678/.test(g.text)));
gesendet = []; await waNachricht(DIRK, "Anfrage 1");
pruefe("Anfrage 1 schickt Details und Foto", gesendet.some(g => g.an === "dirk" && /Schadensart: Selbstzahler/.test(g.text)) && gesendet.some(g => g.an === "dirk" && g.typ === "image"));
gesendet = []; await waNachricht(DIRK, "Schick mir sämtliche Fotos und detaillierte Anfragen");
pruefe("freie Bitte um alles wird verstanden", gesendet.some(g => g.an === "dirk" && /Alle offenen Anfragen im Detail/.test(g.text)) && gesendet.some(g => g.typ === "image"));
gesendet = []; kiAntwort = "Es liegt eine Anfrage vor.";
await waNachricht(DIRK, "Wie sieht es aus mit den Anfragen von gestern?");
pruefe("Chef-Alex bekommt echte Akten, nicht die alte Terminliste", /OFFENE ANFRAGEN \(1\)/.test(kiSystem) && /Nr\. 1: Test/.test(kiSystem) && !/keine offenen Terminanfragen/.test(kiSystem));
// Alte Anfrage (20 Tage) bleibt erhalten, erledigte nach 30 Tagen weg
reset(); uhr("2026-11-13T09:00:00Z");
sp["anfragen"] = JSON.stringify([
  { nr: 2, sitzung: "a", kanal: "whatsapp", kundeNr: "4915112345678", name: "", status: "neu", ts: Date.now() - 40 * 86400000, verlauf: [], fotos: 2, fahrzeug: "WVWZZZ1KZ" },
  { nr: 3, sitzung: "b", kanal: "web", status: "erledigt", ts: Date.now() - 40 * 86400000, verlauf: [] }]);
const off = await A.offeneAnfragen();
pruefe("offene Anfrage nach 40 Tagen noch da, erledigte weg", off.length === 1 && off[0].nr === 2 && JSON.parse(sp["anfragen"]).length === 1);
pruefe("alte Fotos: ehrlicher Hinweis", /nicht gemerkt/.test(await A.anfrageBefehl("Fotos 2", DIRK)));
pruefe("'Merk dir: alle Fotos …' bleibt Lernbefehl", !A.willAlleDetails("Merk dir: alle Fotos bitte vorher prüfen"));

global.Date = R;
log("\n" + ok + " von " + n + " bestanden" + (ok === n ? "" : "  <-- NICHT deployen"));
console.error = stumm;
process.exit(ok === n ? 0 : 1);
