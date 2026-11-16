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
process.env.WA_SAMMELN_MS = "0";          // im Test nicht auf weitere Nachrichten warten

const DIRK = "491700000001", KUNDE = "4917612345678";
let kiSystem = "", sp = {}, gesendet = [], fensterOffen = true, kiAntwort = "Gern.", kiStrom = null, kiFolge = [];
let denkAntwort = "", denkFragen = [], kiAnfragen = 0, wamid = 0, gelesen = [], kiNutzer = "";
let spaetGescheitert = [], kundeFensterZu = false, kiThinking = null, kiThinkingAbgelehnt = false;   // _denken.mjs: Antwort der "rechten Hand"
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
    if (c === "GETDEL") { const x = sp[k] ?? null; delete sp[k]; return r(x); }
    if (c === "RPUSH") { (sp[k] = sp[k] || []).push(v); return r(sp[k].length); }
    if (c === "LPOP") { const l = Array.isArray(sp[k]) ? sp[k] : []; const out = l.splice(0, Number(b[2]) || 1); if (!l.length) delete sp[k]; return r(out.length ? out : null); }
    if (c === "EXPIRE") return r(1);
    return r(null);
  }
  if (u.includes("resend")) { const m = JSON.parse(o.body); gesendet.push({ an: "mail", text: m.subject + "\n" + m.text }); return { ok: true, text: async () => "" }; }
  if (u.includes("anthropic")) {
    const body = JSON.parse(o.body);
    if (body.stream) {
      if (kiStrom === "haengt") return { ok: true, body: new ReadableStream({ pull() { return new Promise(() => {}); } }) };
      const teile = kiStrom || [kiAntwort]; let i = 0;
      return { ok: true, body: new ReadableStream({ pull(c) {
        if (i < teile.length) c.enqueue(enc.encode("data: " + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: teile[i++] } }) + "\n\n"));
        else c.close(); } }) };
    }
    // Die "rechte Hand" (Lagebeurteilung) hat einen eigenen, kurzen Auftrag
    if (typeof body.system === "string" && body.system.startsWith("Du bist die rechte Hand")) {
      denkFragen.push(body.messages[0].content);
      return { ok: true, json: async () => ({ content: denkAntwort ? [{ type: "text", text: denkAntwort }] : [], stop_reason: "end_turn" }) };
    }
    if (kiThinkingAbgelehnt && body.thinking) return { ok: false, status: 400, clone() { return this; }, text: async () => "thinking.type: unsupported value" };
    kiAnfragen++;
    kiThinking = body.thinking || null;
    kiSystem = JSON.stringify(body.system || "");
    kiNutzer = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "";
    const t = kiFolge.length ? kiFolge.shift() : kiAntwort;
    return { ok: true, json: async () => ({ content: t === "" ? [] : [{ type: "text", text: t }], stop_reason: "end_turn" }) };
  }
  if (u.includes("/messages")) {
    const b = JSON.parse(o.body);
    if (b.status === "read") { gelesen.push(b.message_id); return { ok: true, json: async () => ({}), text: async () => "" }; }
    // So verhaelt sich WhatsApp wirklich: Ausserhalb des 24-Stunden-
    // Fensters wird eine freie Nachricht ERST ANGENOMMEN (200 mit Kennung)
    // und das Scheitern kommt spaeter per Webhook (Code 131047).
    if (b.type !== "template" && ((b.to === DIRK && !fensterOffen) || (b.to !== DIRK && kundeFensterZu))) {
      const sid = "wamid.x" + (++wamid);
      spaetGescheitert.push(sid);
      return { ok: true, json: async () => ({ messages: [{ id: sid }] }), text: async () => "" };
    }
    const id = "wamid." + (++wamid);
    gesendet.push({ an: b.to === DIRK ? "dirk" : "kunde", nr: b.to, typ: b.type, id,
      knoepfe: b.interactive ? b.interactive.action.buttons.map(x => x.reply) : null,
      text: b.text?.body || b.interactive?.body?.text || (b.template ? "[Vorlage " + b.template.name + "]" : "[Bild " + (b.image?.caption || "") + "]") });
    return { ok: true, json: async () => ({ messages: [{ id }] }), text: async () => "" };
  }
  return { ok: false, text: async () => "" };
};

const R = Date;
const uhr = iso => { global.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(iso); } static now() { return new R(iso).getTime(); } }; };
const reset = () => { spaetGescheitert = []; kundeFensterZu = false; kiThinkingAbgelehnt = false; sp = {}; gesendet = []; fensterOffen = true; kiAntwort = "Gern."; kiStrom = null; kiFolge = []; denkAntwort = ""; denkFragen = []; kiAnfragen = 0; gelesen = []; };

const stumm = console.error; console.error = () => {};
const log = console.log; console.log = () => {};
const T = await import("../api/_termin.mjs");
const B = await import("../api/_buchung.mjs");
const A = await import("../api/_anfragen.mjs");
const { default: chat } = await import("../api/chat.js");
const { default: wa } = await import("../api/whatsapp.js");

let ok = 0, n = 0;
const pruefe = (name, bed) => { n++; if (bed) ok++; log((bed ? "OK     " : "FEHLER ") + name); };
const res = () => ({ out: [], ende: false, setHeader() {}, writeHead() {}, status(c) { this.statusCode = c; return this; }, json() {}, send() {}, write(s) { this.out.push(s); }, end() { this.ende = true; } });
const sichtbar = r => T.markerRaus(r.out.filter(s => s.startsWith("data: ") && !s.includes("[DONE]")).map(s => JSON.parse(s.slice(6).trim())).join("")).trim();
let mid = 0;
// typ: "text" | "bild" | "button" (Vorlagen-Knopf) | "knopf" (Knopf unter einer Karte, text = Kennung)
// bezug: Kennung der Nachricht, auf die geantwortet wird (in WhatsApp: nach rechts wischen)
const waNachricht = (von, text, typ = "text", bezug = "") => wa({ method: "POST", query: {}, headers: {}, body: { entry: [{ changes: [{ value: {
  contacts: [{ profile: { name: "Test" } }],
  messages: [{ id: "m" + (++mid), from: von, timestamp: "1", ...(bezug ? { context: { id: bezug } } : {}),
    ...(typ === "button" ? { type: "button", button: { text } }
      : typ === "knopf" ? { type: "interactive", interactive: { type: "button_reply", button_reply: { id: text, title: "Knopf" } } }
      : typ === "bild" ? { type: "image", image: { id: "foto" + mid, caption: text } }
      : { type: "text", text: { body: text } }) }] } }] }] } }, res());
// WhatsApp meldet nachtraeglich: diese Nachrichten kamen nicht an
const whatsappMeldetFehler = async () => {
  const ids = spaetGescheitert.splice(0);
  for (const id of ids) await wa({ method: "POST", query: {}, headers: {}, body: { entry: [{ changes: [{ value: {
    statuses: [{ id, status: "failed", recipient_id: "x", errors: [{ code: 131047, title: "Re-engagement message" }] }] } }] }] } }, res());
  return ids.length;
};
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
pruefe("WhatsApp nimmt erst an (wie in echt), noch keine Mail", !gesendet.some(g => g.an === "mail"));
await whatsappMeldetFehler();
pruefe("WhatsApp meldet 'nicht zugestellt' -> E-Mail", gesendet.some(g => g.an === "mail" && /Neuer Termin/.test(g.text)));
gesendet = []; fensterOffen = true; await waNachricht(DIRK, "Hallo");
pruefe("Dirk schreibt -> Liegengebliebenes kommt", gesendet.some(g => g.an === "dirk" && /Liegengeblieben/.test(g.text)));
pruefe("kein falsches 'nichts Offenes'", !gesendet.some(g => /nichts Offenes/.test(g.text)));
reset(); process.env.WA_VORLAGE_INHABER = "kundenmeldung_alex"; fensterOffen = false;
await buche("n", "2026-10-23", "11-13"); await whatsappMeldetFehler(); await buche("o", "2026-10-23", "14-15");
pruefe("nach dem ersten Scheitern weiß Alex: Fenster zu, versucht es nicht mehr frei", spaetGescheitert.length === 0);
pruefe("mit Vorlage: genau ein Anstupser", gesendet.filter(g => g.typ === "template").length === 1);
gesendet = []; fensterOffen = true; await waNachricht(DIRK, "Alles anzeigen", "button");
pruefe("Tipp 'Alles anzeigen' liefert beide", gesendet.filter(g => /Liegengeblieben/.test(g.text)).length === 2);
delete process.env.WA_VORLAGE_INHABER;
// Der Fall vom 16.11.: Dirk hat am Freitag zuletzt geschrieben, Montag 8 Uhr kommt der Überblick
reset(); uhr("2026-11-13T10:00:00Z"); kiAntwort = "Moin."; await waNachricht(DIRK, "Moin");
uhr("2026-11-16T07:05:00Z"); fensterOffen = false; gesendet = [];
await A.weckerAufgaben();
pruefe("16.11.: Fenster bekannt zu -> Überblick gar nicht erst frei versucht", spaetGescheitert.length === 0);
pruefe("16.11.: Überblick kommt per E-Mail und liegt bereit", gesendet.some(g => g.an === "mail" && /Guten Morgen/.test(g.text)) && /Guten Morgen/.test(sp["unzugestellt:" + DIRK] || ""));
fensterOffen = true; gesendet = []; await waNachricht(DIRK, "Status");
pruefe("16.11.: Dirk schreibt -> Überblick kommt auf WhatsApp", gesendet.some(g => g.an === "dirk" && /Liegengeblieben/.test(g.text) && /Guten Morgen/.test(g.text)));
pruefe("Status zeigt Dirks letzten Kontakt und das Modell", gesendet.some(g => /Dein letzter Kontakt mit Alex: gerade eben/.test(g.text) && /ohne Vorab-Nachdenken/.test(g.text)));
// Viele Meldungen bei geschlossenem Fenster: eine Mail, nicht zehn
reset(); uhr("2026-11-16T09:00:00Z"); sp["inhaber:fenster:" + DIRK] = String(Date.now() - 30 * 3600000); fensterOffen = false;
for (let i = 0; i < 4; i++) await T.zustellenAnInhaber("Meldung " + i, { kurz: "Meldung " + i });
pruefe("4 Meldungen bei zu: nur eine Mail in der Stunde", gesendet.filter(g => g.an === "mail").length === 1);
uhr("2026-11-16T10:05:00Z"); delete sp["mailsperre:" + DIRK];   // (Sperre laeuft nach einer Stunde ab)
await T.zustellenAnInhaber("Meldung 5", { kurz: "Meldung 5" });
const sammel = gesendet.filter(g => g.an === "mail").pop();
pruefe("nächste Mail enthält alles Liegengebliebene", gesendet.filter(g => g.an === "mail").length === 2 && /Meldung 1/.test(sammel.text) && /Meldung 5/.test(sammel.text));

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

// ---- 5. Website-Besucher ohne Rueckweg ---------------------------------
log("\n5. Abbrueche");
reset(); uhr("2026-10-22T10:00:00Z");
await T.gespraechMerken({ sitzung: "x1", kanal: "web", thema: "Was kostet ein Kotfluegel" });
await T.gespraechMerken({ sitzung: "x1", kanal: "web", thema: "Und wie lange dauert das" });
pruefe("nicht zu frueh gezaehlt", (await T.offeneGespraecheMelden()) === 0);
uhr("2026-10-22T10:40:00Z"); gesendet = [];
pruefe("nach 40 Min als Abbruch gezaehlt", (await T.offeneGespraecheMelden()) === 1);
pruefe("Dirk bekommt dafuer keine Meldung mehr (er kann nichts tun)", !gesendet.some(g => g.an === "dirk"));
pruefe("steht im Wochenzaehler", (await T.statLesen("abbruchWeb")) === 1);
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

// ---- 7. Eine Karte pro Kunde ---------------------------------------------
log("\n7. Eine Karte pro Kunde");
const LAGE = (o = {}) => JSON.stringify({ kurz: "VW Golf, Stoßfänger hinten verkratzt, Parkrempler, Selbstzahler.", liegt_vor: "1 Foto", fehlt: "Fahrzeugschein",
  will: "Preis", stimmung: "ruhig", haengt: false, empfehlung: "Vom Foto kalkulierbar, Angebot schicken.", nachricht: "", ...o });
const akte = nr => JSON.parse(sp["anfragen"] || "[]").find(a => a.nr === nr);
reset(); uhr("2026-11-13T09:00:00Z");   // Freitag 10:00 Berlin
kiAntwort = "Danke für das Foto. Welches Fahrzeug ist es?";
await waNachricht(KUNDE, "Kratzer an der Stoßstange", "bild");
pruefe("Kunde sieht sofort 'gelesen' und 'schreibt'", gelesen.length === 1);
pruefe("erstes Foto: noch KEINE Einzelmeldung an Dirk (nur Mitlesen)", !gesendet.some(g => g.an === "dirk" && !g.text.includes("💬") && !/Guten Morgen/.test(g.text)));
uhr("2026-11-13T09:12:00Z"); gesendet = []; denkAntwort = LAGE();
await A.weckerAufgaben();
const karte = gesendet.find(g => g.an === "dirk" && g.knoepfe);
if (process.env.ZEIGE) log("\n>>> " + (karte && karte.text) + "\n    Knöpfe: " + (karte && karte.knoepfe.map(k => k.title).join(" | ")) + "\n");
pruefe("Gespräch ruht: Dirk bekommt EINE Karte mit Knöpfen", !!karte && gesendet.filter(g => g.an === "dirk" && g.typ !== "image").length === 1);
pruefe("Karte: Name, Nummer, Zusammenfassung, Empfehlung", karte && /Test/.test(karte.text) && /\+49 176 12345678/.test(karte.text) && /Stoßfänger hinten/.test(karte.text) && /👉 Vom Foto kalkulierbar/.test(karte.text));
pruefe("Karte sagt, was fehlt", karte && /Fehlt: Fahrzeugschein/.test(karte.text));
pruefe("Foto kommt mit der Karte, Nummer in der Unterschrift", gesendet.some(g => g.an === "dirk" && g.typ === "image" && /Nr\. 1/.test(g.text)));
pruefe("Knöpfe passen in WhatsApp (höchstens 3, je höchstens 20 Zeichen)", karte && karte.knoepfe.length <= 3 && karte.knoepfe.every(k => k.title.length <= 20) && karte.text.length <= 1024);
gesendet = []; await A.weckerAufgaben();
pruefe("Karte kommt nur einmal", !gesendet.some(g => g.an === "dirk"));
gesendet = []; kiAntwort = "Danke, dann kalkulieren wir das. [[KVA|Selbstzahler|VW Golf 2018|1 Bild]]"; denkAntwort = LAGE({ fehlt: "nichts" });
await waNachricht(KUNDE, "VW Golf 2018, zahle selbst");
const karte2 = gesendet.find(g => g.an === "dirk" && g.knoepfe);
pruefe("Übergabe an die Werkstatt: Karte sofort", !!karte2 && /🔄 Nr\. 1/.test(karte2.text));
pruefe("Fotos werden nicht doppelt geschickt", !gesendet.some(g => g.an === "dirk" && g.typ === "image"));
gesendet = []; await waNachricht(DIRK, "Anfragen");
pruefe("Liste zeigt Nummer statt nur 'WhatsApp'", gesendet.some(g => g.an === "dirk" && /\+49 176 12345678/.test(g.text)));
gesendet = []; await waNachricht(DIRK, "a:details:1", "knopf");
pruefe("Knopf Details: Angaben, Gespräch und Foto", gesendet.some(g => g.an === "dirk" && /Schadensart: Selbstzahler/.test(g.text) && /Kratzer an der Stoßstange/.test(g.text)) && gesendet.some(g => g.an === "dirk" && g.typ === "image"));
gesendet = []; await waNachricht(DIRK, "Gespräch 1");
pruefe("Gespräch 1: Wortlaut von Kunde und Alex", gesendet.some(g => g.an === "dirk" && /👤 VW Golf 2018/.test(g.text) && /Alex: Danke, dann kalkulieren/.test(g.text)));
gesendet = []; await waNachricht(DIRK, "Schick mir sämtliche Fotos und detaillierte Anfragen");
pruefe("freie Bitte um alles wird verstanden", gesendet.some(g => g.an === "dirk" && /Alle offenen Anfragen im Detail/.test(g.text)) && gesendet.some(g => g.typ === "image"));
gesendet = []; kiAntwort = "Er will einen Preis für den Stoßfänger.";
await waNachricht(DIRK, "Was will der eigentlich?", "text", karte2.id);
pruefe("Antwort auf die Karte: Alex kennt Anfrage und Wortlaut", /DIRK MEINT ANFRAGE NR\. 1/.test(kiSystem) && /GESPRÄCH IM WORTLAUT/.test(kiSystem) && /OFFENE ANFRAGEN \(1\)/.test(kiSystem));
gesendet = []; kiAntwort = "Mach ich. [[AN_KUNDE|1|Guten Tag, hier ist Alex von der Autolackiererei in Britz. Wir melden uns am Montag mit dem Kostenvoranschlag.]]";
await waNachricht(DIRK, "Schreib dem Golf-Fahrer, dass wir uns Montag melden");
const vorschau = gesendet.find(g => g.an === "dirk" && g.knoepfe);
pruefe("freier Auftrag: erst Vorschau mit Senden/Verwerfen, nichts geht raus", !!vorschau && /Montag/.test(vorschau.text) && vorschau.knoepfe.some(k => k.id === "e:senden") && !gesendet.some(g => g.an === "kunde"));
gesendet = []; await waNachricht(DIRK, "e:senden", "knopf");
pruefe("nach 'Senden' bekommt der Kunde genau diesen Text", gesendet.some(g => g.an === "kunde" && /am Montag mit dem Kostenvoranschlag/.test(g.text)) && gesendet.some(g => g.an === "dirk" && /Geschickt/.test(g.text)));
gesendet = []; await waNachricht(DIRK, "480 Euro, Stoßfänger hinten lackieren", "text", karte2.id);
pruefe("Preis als Antwort auf die Karte = Angebot an den Kunden", gesendet.some(g => g.an === "kunde" && /480 Euro/.test(g.text)) && akte(1).status === "angebot");
// Alte Anfrage (40 Tage) bleibt erhalten, erledigte nach 30 Tagen weg
reset(); uhr("2026-11-13T09:00:00Z");
sp["anfragen"] = JSON.stringify([
  { nr: 2, sitzung: "a", kanal: "whatsapp", kundeNr: "4915112345678", name: "", status: "neu", ts: Date.now() - 40 * 86400000, verlauf: [], fotos: 2, fahrzeug: "WVWZZZ1KZ" },
  { nr: 3, sitzung: "b", kanal: "web", status: "erledigt", ts: Date.now() - 40 * 86400000, verlauf: [] },
  { nr: 4, sitzung: "c", kanal: "whatsapp", kundeNr: "4915112345679", status: "neu", ts: Date.now() - 86400000, verlauf: [], fotos: 1 }]);
const off = await A.offeneAnfragen();
pruefe("offene Anfrage nach 40 Tagen noch da, erledigte weg", off.length === 2 && off[0].nr === 2 && JSON.parse(sp["anfragen"]).length === 2);
pruefe("alte Fotos: ehrlicher Hinweis", /nicht gemerkt/.test(await A.anfrageBefehl("Fotos 2", DIRK)));
pruefe("mehrere auf einmal abschließen: 'Erledigt 2 4'", /Nr\. 2, 4/.test(await A.anfrageBefehl("Erledigt 2 4", DIRK)) && (await A.offeneAnfragen()).length === 0);
pruefe("'Merk dir: alle Fotos …' bleibt Lernbefehl", !A.willAlleDetails("Merk dir: alle Fotos bitte vorher prüfen"));

// ---- 8. Kunden nicht verlieren ----------------------------------------
log("\n8. Kunden nicht verlieren");
// a) Kunde verstummt mitten im Ablauf
reset(); uhr("2026-11-16T08:00:00Z");   // Montag 9:00 Berlin
kiAntwort = "Das kommt auf den Schaden an. Schicken Sie mir ein Foto?";
await waNachricht(KUNDE, "Was kostet eine Stoßstange lackieren?");
uhr("2026-11-16T08:10:00Z"); gesendet = []; denkAntwort = LAGE({ haengt: true, nachricht: "Ein Foto vom Schaden reicht erst mal völlig, den Rest klären wir danach. Mögen Sie es kurz hier reinschicken?" });
await A.weckerAufgaben();
pruefe("nach 10 Min. noch kein Nachhaken", !gesendet.some(g => g.an === "kunde"));
uhr("2026-11-16T08:36:00Z"); await A.weckerAufgaben();
const nh = gesendet.find(g => g.an === "kunde");
pruefe("nach 36 Min.: Alex hakt einmal nach, passend zum Gespräch", nh && /Foto vom Schaden reicht erst mal/.test(nh.text));
pruefe("die KI bekam das Gespräch und die Stille mit", denkFragen.some(f => /Was kostet eine Stoßstange/.test(f) && /seit 36 Minuten/.test(f)));
pruefe("Nachhaken steht im Verlauf (Alex versteht die Antwort)", JSON.stringify(sp["wa:" + KUNDE] || "").includes("reicht erst mal"));
uhr("2026-11-16T09:30:00Z"); gesendet = []; await A.weckerAufgaben();
pruefe("kein zweites Nachhaken", !gesendet.some(g => g.an === "kunde"));
kiAntwort = "Danke, das sehe ich mir an."; await waNachricht(KUNDE, "Hier", "bild");
pruefe("Kunde kommt zurück: wird gezählt", (await T.statLesen("zurueckgeholt")) === 1 && (await T.statLesen("nachgehakt")) === 1);
// b) Gespräch endete sauber ("Alles klar"): kein Nachhaken
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Wir haben Mo bis Do von 8 bis 17 Uhr auf. Passt das für Sie?";
await waNachricht(KUNDE, "Alles klar");
uhr("2026-11-16T08:40:00Z"); gesendet = []; denkAntwort = LAGE({ haengt: false, nachricht: "" });
await A.weckerAufgaben();
pruefe("'Alles klar' ist kein Abbruch: KI gefragt, nichts an Kunden, nichts an Dirk", denkFragen.length === 1 && !gesendet.some(g => g.an === "kunde") && !gesendet.some(g => g.an === "dirk"));
// c) Die KI nennt verbotenerweise einen Preis: Nachricht wird verworfen
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Schicken Sie mir ein Foto?"; await waNachricht(KUNDE, "Was kostet das?");
uhr("2026-11-16T08:40:00Z"); gesendet = []; denkAntwort = LAGE({ haengt: true, nachricht: "Das kostet meist um die 400 Euro. Soll ich einen Termin eintragen?" });
await A.weckerAufgaben();
pruefe("Nachricht mit Preis geht NICHT raus (die KI wurde gefragt, der Code hat verworfen)", denkFragen.length === 1 && !gesendet.some(g => g.an === "kunde"));
// d) Übergeben, kein Angebot: Erinnerung an Dirk, dann Zwischenstand
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Danke, unser Team kalkuliert das. [[KVA|Selbstzahler|Golf 7|1 Bild]]"; denkAntwort = LAGE();
await waNachricht(KUNDE, "Stoßstange zerkratzt", "bild");
uhr("2026-11-16T11:30:00Z"); gesendet = [];   // 12:30, 3,5 Std. spaeter
await A.weckerAufgaben();
pruefe("nach 3 Std.: Erinnerung an Dirk mit Fensterende und Knöpfen", gesendet.some(g => g.an === "dirk" && /wartet auf dein Angebot/.test(g.text) && /offen bis/.test(g.text) && g.knoepfe));
gesendet = []; await A.weckerAufgaben();
pruefe("Erinnerung nur einmal", !gesendet.some(g => /wartet auf dein Angebot/.test(g.text)));
uhr("2026-11-16T18:30:00Z"); gesendet = [];   // 19:30, 10,5 Std. spaeter
denkAntwort = LAGE({ nachricht: "Guten Tag, hier ist noch einmal Alex von der Autolackiererei in Britz. Der Kostenvoranschlag für Ihren Golf ist noch in Arbeit. Soll ich Ihnen einen Termin zur kostenlosen Begutachtung eintragen?" });
await A.weckerAufgaben();
const zw = gesendet.find(g => g.an === "kunde");
pruefe("vor Fensterende: Zwischenstand, auf das Gespräch bezogen, mit Frage", zw && /für Ihren Golf/.test(zw.text) && /\?$/.test(zw.text.trim()));
pruefe("Dirk erfährt davon in einer Zeile (abends: am nächsten Morgen)", JSON.parse(sp["wartend"] || "[]").some(e => /Stand gesagt/.test(e.text) && e.akteNr === 1));
uhr("2026-11-16T19:30:00Z"); gesendet = []; await A.weckerAufgaben();
pruefe("kein zweiter Zwischenstand", !gesendet.some(g => g.an === "kunde"));
// e) KI nicht erreichbar: fester Text statt Stille
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Danke. [[KVA|Selbstzahler|Golf 7|1 Bild]]"; await waNachricht(KUNDE, "Kratzer", "bild");
uhr("2026-11-16T18:30:00Z"); gesendet = []; denkAntwort = "";
await A.weckerAufgaben();
pruefe("ohne KI: fester Zwischenstand mit freien Zeiten", gesendet.some(g => g.an === "kunde" && /Zwischenstand/.test(g.text) && /Uhr/.test(g.text)));
// f) Vorbeikommen
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Danke für das Foto.";
await waNachricht(KUNDE, "Delle Tür", "bild"); gesendet = [];
await waNachricht(DIRK, "Vorbeikommen 1");
pruefe("Vorbeikommen 1: Kunde bekommt Einladung mit freien Zeiten", gesendet.some(g => g.an === "kunde" && /kostenlos/.test(g.text) && /Uhr/.test(g.text)));
pruefe("Dirk bekommt Bestätigung", gesendet.some(g => g.an === "dirk" && /eingeladen/.test(g.text)));

// ---- 9. Der Fall Steffi: wartet 11 Tage und beschwert sich -----------------
log("\n9. Verärgerte und lange wartende Kunden");
reset(); uhr("2026-11-13T19:00:00Z");   // Freitag 20:00 Berlin, Ruhezeit
sp["anfragen"] = JSON.stringify([{ nr: 7, sitzung: "wa:" + KUNDE, kanal: "whatsapp", kundeNr: KUNDE, name: "Steffi", nameQuelle: "profil", status: "neu",
  ts: Date.now() - 11 * 86400000, letzterKontakt: Date.now() - 11 * 86400000, verlauf: [], fotos: 8, schaden: "Selbstzahler", fahrzeug: "VW T6.1", gemeldetKVA: true, gemeldetNeu: true }]);
kiAntwort = "Das hätte so nicht laufen dürfen, das tut mir leid. Ich gebe es jetzt als dringend direkt an den Chef. [[DRINGEND|wartet seit dem 2.11., verärgert]]";
denkAntwort = LAGE({ kurz: "VW T6.1, Karosserie- und Lackschaden, Selbstzahler.", stimmung: "verärgert", empfehlung: "Heute persönlich anrufen und entschuldigen.", fehlt: "nichts" });
await waNachricht(KUNDE, "Ich habe immer noch nichts gehört, sehr schlechter Service. Ein Nein wäre nett gewesen.");
pruefe("Alex weiß, dass sie seit 11 Tagen wartet, und darf nicht vertrösten", /wartet seit 11 Tagen/.test(kiSystem) && /Entschuldige dich ehrlich/.test(kiSystem));
pruefe("Akte ist als dringend markiert, mit ihrem Satz", akte(7).dringend && /Ein Nein wäre nett/.test(akte(7).dringend.zitat));
const nacht = JSON.parse(sp["wartend"] || "[]");
pruefe("nachts: genau EINE Meldung für diese Kundin, nicht 'Neue Anfrage'", nacht.length === 1 && /🔴 Dringend · Nr\. 7 · Steffi/.test(nacht[0].text) && !/Neue Anfrage/.test(nacht[0].text));
kiAntwort = "Gern."; await waNachricht(KUNDE, "Alle klar");
pruefe("'Alle klar' erzeugt keine zweite Meldung", JSON.parse(sp["wartend"] || "[]").length === 1);
uhr("2026-11-14T07:15:00Z"); gesendet = [];   // Samstag 8:15
await T.warteschlangeZustellen();
const rot = gesendet.find(g => g.an === "dirk" && g.knoepfe);
if (process.env.ZEIGE) log("\n>>> " + (rot && rot.text) + "\n    Knöpfe: " + (rot && rot.knoepfe.map(k => k.title).join(" | ")) + "\n");
pruefe("morgens: rote Karte mit Wartezeit, Zitat, Empfehlung und 'Ich rufe an'", rot && /🔴 Dringend/.test(rot.text) && /Seit 11 Tagen ohne Antwort/.test(rot.text) && /👉 Heute persönlich anrufen/.test(rot.text) && rot.knoepfe.some(k => k.title === "Ich rufe an"));
uhr("2026-11-14T09:30:00Z"); gesendet = []; await A.weckerAufgaben();   // 10:30, gut 14 Std. nach ihrer Nachricht
pruefe("KEIN automatischer Standardtext an die verärgerte Kundin", !gesendet.some(g => g.an === "kunde"));
gesendet = []; await waNachricht(DIRK, "a:anruf:7", "knopf");
pruefe("'Ich rufe an': Kundin erfährt es, Akte merkt es, Dirk hat die Nummer", gesendet.some(g => g.an === "kunde" && /meldet sich persönlich telefonisch/.test(g.text)) && akte(7).anruf && !akte(7).dringend && gesendet.some(g => g.an === "dirk" && /\+49 176 12345678/.test(g.text)));
// Frische Anfrage: kein Alarm, normaler Stand
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Danke. [[KVA|Selbstzahler|Golf|1 Bild]]"; await waNachricht(KUNDE, "Kratzer", "bild");
uhr("2026-11-16T10:00:00Z"); kiAntwort = "Ist in Arbeit."; await waNachricht(KUNDE, "Wie lange dauert das ungefähr?");
pruefe("frische Anfrage: kein Dringend, Alex kennt den Stand", !akte(1).dringend && /das Angebot ist in Arbeit/.test(kiSystem));

// ---- 10. Mehrere Nachrichten, eine Antwort -----------------------------
log("\n10. Sammeln");
reset(); uhr("2026-11-16T08:00:00Z"); process.env.WA_SAMMELN_MS = "40";
kiAntwort = "Danke für die Fotos. Welches Fahrzeug ist es?";
await Promise.all([waNachricht(KUNDE, "Hallo, ich habe einen Schaden"), waNachricht(KUNDE, "", "bild"), waNachricht(KUNDE, "", "bild"), waNachricht(KUNDE, "", "bild")]);
process.env.WA_SAMMELN_MS = "0";
pruefe("4 Nachrichten auf einmal: EINE Antwort an den Kunden", gesendet.filter(g => g.an === "kunde").length === 1 && kiAnfragen === 1);
pruefe("alle 3 Fotos und der Text sind in der Akte", akte(1).fotos === 3 && akte(1).medien.length === 3 && /ich habe einen Schaden/.test(akte(1).thema));
pruefe("Alex weiß, dass es mehrere Nachrichten waren", /4 Nachrichten hintereinander/.test(kiSystem));
gesendet = []; kiAnfragen = 0; await waNachricht(KUNDE, "VW Golf");
pruefe("danach geht es normal weiter", gesendet.filter(g => g.an === "kunde").length === 1 && kiAnfragen === 1);

// ---- 11. Lernrunde ---------------------------------------------------------
log("\n11. Lernen");
const L = await import("../api/_lernen.mjs");
reset(); uhr("2026-11-16T09:00:00Z");
for (let i = 1; i <= 3; i++) await L.gespraechAblegen({ kennung: "w" + i, kanal: "web", verlauf: [{ role: "user", content: "Was kostet das? 0176 1234567" }, { role: "assistant", content: "Schicken Sie mir Fahrzeugschein, FIN und drei Fotos." }] });
sp["lern:letzte"] = String(Date.now() - 8 * 86400000);
pruefe("Gespräche werden ohne Rufnummer abgelegt", !/0176/.test(sp["lern:g:w1"]) && /\[Nummer\]/.test(sp["lern:g:w1"]));
kiAntwort = JSON.stringify({ kennzahlen: { gespraeche: 3, mit_abschluss: 0, abbrueche: 3, schleifen: 0, ungeduld: 0, zurueckgeholt: 0 }, gut: [], ausstieg: "Nach der Bitte um drei Unterlagen auf einmal.",
  vorschlaege: [{ regel: "Bitte immer nur um EINE Sache, zuerst das Foto.", grund: "Drei Kunden stiegen nach der Dreifach-Bitte aus.", beispiel: "Ein Foto reicht erst mal.", art: "stil" }] });
gesendet = [];
const lr = await L.lernPflege();
const vs = gesendet.find(g => g.an === "dirk" && g.knoepfe);
pruefe("wöchentliche Lernrunde läuft im Wecker, mit dem Ergebnis je Gespräch", lr && lr.neue === 1 && /Ergebnis: keine Anfrage entstanden/.test(kiNutzer));
pruefe("Vorschlag kommt mit 'Übernehmen' und 'Ablehnen'", vs && /Lernvorschlag 1/.test(vs.text) && /nur um EINE Sache/.test(vs.text) && vs.knoepfe.some(k => k.title === "Übernehmen"));
pruefe("nichts gilt ohne Freigabe", JSON.parse(sp["lern:aktiv"] || "[]").length === 0);
gesendet = []; await waNachricht(DIRK, "l:ok:1", "knopf");
pruefe("ein Tipp auf 'Übernehmen': Regel ist aktiv", JSON.parse(sp["lern:aktiv"] || "[]").length === 1 && gesendet.some(g => g.an === "dirk" && /Freigegeben/.test(g.text)));
kiAntwort = "Gern."; await waNachricht(KUNDE, "Hallo");
pruefe("freigegebene Regel steht ab sofort in Alex' Anweisungen", /nur um EINE Sache/.test(kiSystem));
reset(); uhr("2026-11-16T09:00:00Z");
for (let i = 1; i <= 3; i++) await L.gespraechAblegen({ kennung: "v" + i, kanal: "web", verlauf: [{ role: "user", content: "Hallo" }, { role: "assistant", content: "Guten Tag." }] });
sp["lern:letzte"] = String(Date.now() - 8 * 86400000); kiAntwort = "Das ist kein JSON";
pruefe("scheitert die Auswertung, steht der Grund unter Status", (await L.lernPflege()) === null && JSON.parse(sp["fehlerlog"] || "[]").some(f => f.art === "lernen"));
pruefe("und sie wird am selben Tag nicht endlos wiederholt", (await L.lernPflege()) === null && kiAnfragen === 1);
reset(); uhr("2026-11-16T09:00:00Z"); process.env.TECHNIK_NUMMERN = "491700000002";
for (let i = 1; i <= 3; i++) await L.gespraechAblegen({ kennung: "u" + i, kanal: "web", verlauf: [{ role: "user", content: "Hallo" }, { role: "assistant", content: "Guten Tag." }] });
sp["lern:letzte"] = String(Date.now() - 8 * 86400000);
kiAntwort = JSON.stringify({ kennzahlen: { gespraeche: 3 }, gut: [], vorschlaege: [{ regel: "Kürzer antworten.", grund: "Zu lang.", art: "stil" }] });
await L.lernPflege();
pruefe("mit TECHNIK_NUMMERN geht das Lernen an Julian, nicht an Dirk", gesendet.some(g => g.nr === "491700000002" && /Lernvorschlag/.test(g.text)) && !gesendet.some(g => g.an === "dirk"));
delete process.env.TECHNIK_NUMMERN;

// ---- 12. Website ------------------------------------------------------------
log("\n12. Website: Karte, Nachhaken, Besucher ohne Rückweg");
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Danke, Herr Kurz. Unser Team meldet sich. [[KONTAKT|Kurz|0176 5550001]]"; denkAntwort = LAGE({ kurz: "Opel Corsa, Tür hinten rechts eingedellt." });
let rw = res(); await chat({ method: "POST", body: { sitzung: "web1", messages: [{ role: "user", content: "Delle in der Tür, mein Name ist Kurz, 0176 5550001" }] } }, rw);
pruefe("Website: beim Kontakt noch keine Karte (Gespräch läuft)", !gesendet.some(g => g.an === "dirk" && g.knoepfe));
uhr("2026-11-16T08:10:00Z"); gesendet = []; await A.weckerAufgaben();
const wk = gesendet.find(g => g.an === "dirk" && g.knoepfe);
pruefe("Website-Gespräch ruht: Karte mit Nummer und Hinweis 'anrufen'", wk && /Kurz · 0176 5550001/.test(wk.text) && /Opel Corsa/.test(wk.text) && /anrufen oder mailen/.test(wk.text));
reset(); uhr("2026-11-16T08:00:00Z"); kiAntwort = "Ein Foto reicht erst mal völlig.";
rw = res(); await chat({ method: "POST", body: { sitzung: "web2", nachhaken: true, messages: [{ role: "user", content: "Was kostet das?" }, { role: "assistant", content: "Schicken Sie mir ein Foto?" }] } }, rw);
pruefe("Website: stiller Kunde bekommt eine Nachricht von Alex", /Foto reicht erst mal/.test(sichtbar(rw)) && rw.ende);
pruefe("das Nachhaken legt keine Anfrage an und meldet nichts", !sp["anfragen"] && !gesendet.some(g => g.an === "dirk"));
reset(); uhr("2026-11-16T08:00:00Z"); kiAntwort = "Danke für das Foto. Wie erreichen wir Sie?";
sp["anfragen"] = JSON.stringify([{ nr: 1, sitzung: "web3", kanal: "web", kundeNr: "", name: "", tel: "", status: "neu", ts: Date.now(), letzterKontakt: Date.now(), verlauf: [], fotos: 1, karteOffen: true }]);
uhr("2026-11-16T10:30:00Z"); gesendet = []; await A.weckerAufgaben();
pruefe("Website-Besucher ohne Rückweg: keine Karte, Akte geht aus der Liste", !gesendet.some(g => g.an === "dirk" && g.knoepfe) && akte(1).status === "verloren" && (await A.offeneAnfragen()).length === 0);

// ---- 13. Wecker-Überwachung, Briefing -----------------------------------------
log("\n13. Wecker und Morgenüberblick");
reset(); uhr("2026-11-16T08:00:00Z");
pruefe("Wecker nie eingerichtet: kein Alarm", (await A.herzschlag(false)) === true);
await A.herzschlag(true); uhr("2026-11-16T08:30:00Z");
pruefe("Wecker läuft: alles gut", (await A.herzschlag(false)) === true);
uhr("2026-11-16T10:00:00Z"); gesendet = [];
pruefe("Wecker seit 2 Std. still: eine Mail an die Technik", (await A.herzschlag(false)) === false && gesendet.some(g => g.an === "mail" && /Wecker/.test(g.text)));
gesendet = []; await A.herzschlag(false);
pruefe("nur eine Mail am Tag", !gesendet.some(g => g.an === "mail"));
reset(); uhr("2026-11-17T07:05:00Z");   // Dienstag 8:05
sp["anfragen"] = JSON.stringify([
  { nr: 7, sitzung: "s7", kanal: "whatsapp", kundeNr: KUNDE, name: "Steffi", status: "neu", ts: Date.now() - 12 * 86400000, verlauf: [], fotos: 8, fahrzeug: "VW T6.1", dringend: { grund: "verärgert", zitat: "", ts: Date.now() } },
  { nr: 8, sitzung: "s8", kanal: "whatsapp", kundeNr: "4915100000008", name: "Alt", status: "neu", ts: Date.now() - 20 * 86400000, verlauf: [], fotos: 1 },
  { nr: 9, sitzung: "s9", kanal: "whatsapp", kundeNr: "4915100000009", name: "Frisch", status: "neu", ts: Date.now() - 86400000, verlauf: [], fotos: 2, fahrzeug: "Golf 7" }]);
gesendet = []; await A.weckerAufgaben();
const br = gesendet.find(g => g.an === "dirk" && /Guten Morgen/.test(g.text));
if (process.env.ZEIGE) log("\n>>> " + (br && br.text) + "\n");
pruefe("Morgenüberblick: Dringendes oben, Frisches einzeln, Altes in einer Zeile", br && br.text.indexOf("🔴 Bitte heute melden (1)") < br.text.indexOf("Warten auf dein Angebot: 1") && /Schon länger offen \(1\): Nr\. 8/.test(br.text) && /Nr\. 9 Frisch/.test(br.text));

// ---- 14. Randfälle ------------------------------------------------------------
log("\n14. Randfälle");
// a) Dirk hat 24 Std. nichts geschrieben: Karte wird aufgehoben, kommt mit Knöpfen nach
reset(); uhr("2026-11-16T08:00:00Z"); fensterOffen = false;
kiAntwort = "Danke. [[KVA|Selbstzahler|Golf|1 Bild]]"; denkAntwort = LAGE();
await waNachricht(KUNDE, "Kratzer", "bild"); await whatsappMeldetFehler();
pruefe("Dirks Fenster zu: Karte liegt bereit, E-Mail als Notweg", JSON.parse(sp["unzugestellt:" + DIRK] || "[]").some(e => e.akteNr === 1 && e.knoepfe) && gesendet.some(g => g.an === "mail"));
fensterOffen = true; gesendet = []; kiAntwort = "Moin."; await waNachricht(DIRK, "Moin");
const nachl = gesendet.find(g => g.an === "dirk" && /Liegengeblieben/.test(g.text));
pruefe("Dirk schreibt: Karte kommt nach, mit Knöpfen und Foto", nachl && nachl.knoepfe && gesendet.some(g => g.an === "dirk" && g.typ === "image"));
gesendet = []; await waNachricht(DIRK, "450 Euro, Stoßfänger lackieren", "text", nachl.id);
pruefe("auch auf die nachgelieferte Karte kann er mit dem Preis antworten", gesendet.some(g => g.an === "kunde" && /450 Euro/.test(g.text)));
// b) Kunde kommt nach abgeschlossener Anfrage mit neuem Schaden wieder
await waNachricht(DIRK, "Erledigt 1");
uhr("2026-11-20T08:00:00Z"); kiAntwort = "Danke für das Foto. Was ist passiert?"; await waNachricht(KUNDE, "Neuer Schaden", "bild");
pruefe("neuer Schaden nach Abschluss = neue Anfrage Nr. 2", akte(2) && akte(2).status === "neu" && akte(1).status === "erledigt");
// c) Übernahme: Dirks Worte stehen im Gespräch
await waNachricht(DIRK, "Übernehme 2"); await waNachricht(DIRK, "Kommen Sie morgen einfach vorbei");
await waNachricht(KUNDE, "Mache ich"); await waNachricht(DIRK, "Fertig");
const gsp = JSON.parse(sp["akte:g:2"] || "[]");
pruefe("Übernahme: Dirks Nachricht und die Antwort des Kunden stehen im Gespräch", gsp.some(z => z.w === "D" && /morgen einfach vorbei/.test(z.t)) && gsp.some(z => z.w === "K" && /Mache ich/.test(z.t)));
// d) Nachts zwei Kunden: morgens zwei Karten, die dringende zuerst
reset(); uhr("2026-11-16T19:00:00Z");
await T.meldenOderAufheben("🆕 Nr. 1 · Ruhig", { akteNr: 1, knoepfe: [{ id: "a:details:1", titel: "Details" }] });
await T.meldenOderAufheben("🔴 Dringend · Nr. 2 · Eilig", { akteNr: 2, prio: 2, knoepfe: [{ id: "a:anruf:2", titel: "Ich rufe an" }] });
await T.meldenOderAufheben("🔄 Nr. 1 · Ruhig, jetzt mit Foto", { akteNr: 1, bilder: ["f1"], knoepfe: [{ id: "a:details:1", titel: "Details" }] });
uhr("2026-11-17T07:10:00Z"); gesendet = []; await T.warteschlangeZustellen();
const karten = gesendet.filter(g => g.an === "dirk" && g.knoepfe);
pruefe("morgens: je Kunde EINE Karte (die neueste), Dringendes zuerst", karten.length === 2 && /Dringend · Nr\. 2/.test(karten[0].text) && /jetzt mit Foto/.test(karten[1].text));
pruefe("Fotos der ersetzten Karte gehen nicht verloren", gesendet.some(g => g.an === "dirk" && g.typ === "image"));
// e) KI fällt aus: Kunde bekommt die Telefonnummer, die Anfrage geht trotzdem nicht verloren
reset(); uhr("2026-11-16T08:00:00Z");
const echt = global.fetch;
global.fetch = async (u, o) => String(u).includes("anthropic") ? { ok: false, status: 529, text: async () => "overloaded" } : echt(u, o);
await waNachricht(KUNDE, "Unfallschaden vorne", "bild");
global.fetch = echt;
pruefe("KI aus: Kunde bekommt die Nummer der Werkstatt", gesendet.some(g => g.an === "kunde" && /030 607 97 930/.test(g.text)));
pruefe("KI aus: Foto und Text stehen trotzdem in der Akte", akte(1) && akte(1).fotos === 1 && akte(1).karteOffen === true);
uhr("2026-11-16T08:10:00Z"); gesendet = []; denkAntwort = ""; await A.weckerAufgaben();
pruefe("und Dirk bekommt die Karte, auch ohne KI-Zusammenfassung", gesendet.some(g => g.an === "dirk" && g.knoepfe && /Unfallschaden vorne/.test(g.text)) && gesendet.some(g => g.typ === "image"));

// f) WhatsApp lehnt Knöpfe ab: Karte kommt trotzdem, eben ohne
reset(); uhr("2026-11-16T08:00:00Z");
const echt2 = global.fetch;
global.fetch = async (u, o) => String(u).includes("/messages") && JSON.parse(o.body).type === "interactive" ? { ok: false, status: 400, text: async () => "nein" } : echt2(u, o);
await T.zustellenAnInhaber("🆕 Nr. 5 · Probe", { akteNr: 5, knoepfe: [{ id: "a:details:5", titel: "Details" }] });
global.fetch = echt2;
pruefe("Knöpfe abgelehnt: Karte kommt als Text, steht in der Fehlerliste", gesendet.some(g => g.an === "dirk" && /Nr\. 5 · Probe/.test(g.text)) && JSON.parse(sp["fehlerlog"] || "[]").some(f => f.art === "knoepfe"));
// g) Alte Lernvorschläge überfallen Dirk nicht
reset(); uhr("2026-11-16T09:00:00Z");
sp["lern:vorschlaege"] = JSON.stringify([{ nr: 1, regel: "Alt 1", grund: "x", art: "stil" }, { nr: 2, regel: "Alt 2", grund: "x", art: "stil" }]);
await L.lernPflege();
pruefe("alte Vorschläge: ohne TECHNIK_NUMMERN keine Nachrichten an Dirk", !gesendet.some(g => g.an === "dirk"));
process.env.TECHNIK_NUMMERN = "491700000002"; await L.lernPflege(); delete process.env.TECHNIK_NUMMERN;
pruefe("mit TECHNIK_NUMMERN: einmal mit Knöpfen an Julian", gesendet.filter(g => g.nr === "491700000002" && g.knoepfe).length === 2);

// h) Schalter "Nachhaken aus"
reset(); uhr("2026-11-16T08:00:00Z");
kiAntwort = "Schicken Sie mir ein Foto?"; await waNachricht(KUNDE, "Was kostet das?");
await waNachricht(DIRK, "Nachhaken aus");
uhr("2026-11-16T08:40:00Z"); gesendet = []; denkAntwort = LAGE({ haengt: true, nachricht: "Ein Foto reicht erst mal völlig. Mögen Sie es kurz schicken?" });
await A.weckerAufgaben();
pruefe("'Nachhaken aus': Alex schreibt keinem Kunden von sich aus", !gesendet.some(g => g.an === "kunde") && denkFragen.length === 0);
rw = res(); await chat({ method: "POST", body: { sitzung: "web9", nachhaken: true, messages: [{ role: "user", content: "Hallo" }, { role: "assistant", content: "Wie kann ich helfen?" }] } }, rw);
pruefe("auch im Website-Chat nicht", sichtbar(rw) === "" && rw.ende);
await waNachricht(DIRK, "Nachhaken an"); gesendet = []; await A.weckerAufgaben();
pruefe("'Nachhaken an': es geht wieder", gesendet.some(g => g.an === "kunde" && /Foto reicht erst mal/.test(g.text)));

// ---- 15. KI ohne Vorab-Nachdenken, Kundennachricht kam nicht an ---------
log("\n15. KI-Einstellung und nachträgliche Fehler");
reset(); uhr("2026-11-16T09:00:00Z"); process.env.CLAUDE_MODEL = "claude-sonnet-5";
kiAntwort = "Gern."; await waNachricht(KUNDE, "Hallo");
pruefe("Sonnet 5: Vorab-Nachdenken aus (sonst frisst es die Antwort)", kiThinking && kiThinking.type === "disabled");
process.env.CLAUDE_MODEL = "claude-sonnet-5-5"; await waNachricht(KUNDE, "Noch was");
pruefe("Sonnet 5.5: richtige Einstellung (between_tools)", kiThinking && kiThinking.type === "between_tools");
kiThinkingAbgelehnt = true; process.env.CLAUDE_MODEL = "claude-sonnet-5"; gesendet = [];
await waNachricht(KUNDE, "Und jetzt?");
pruefe("lehnt ein Modell die Einstellung ab: zweiter Versuch ohne, Kunde bekommt Antwort", gesendet.some(g => g.an === "kunde" && /Gern/.test(g.text)) && kiThinking === null);
delete process.env.CLAUDE_MODEL; kiThinkingAbgelehnt = false;
// Angebot an einen Kunden, dessen WhatsApp schon zu ist
reset(); uhr("2026-11-16T09:00:00Z");
sp["anfragen"] = JSON.stringify([{ nr: 4, sitzung: "wa:" + KUNDE, kanal: "whatsapp", kundeNr: KUNDE, name: "Herr Bauer", status: "neu", ts: Date.now() - 2 * 86400000,
  letzterKontakt: Date.now() - 20 * 3600000, verlauf: [], fotos: 2, kvaTs: Date.now() - 2 * 86400000, karteTs: Date.now() }]);
kundeFensterZu = true; gesendet = [];
const antw = await A.anfrageBefehl("Angebot 4: 520 Euro, Tür hinten links", DIRK);
pruefe("Angebot: WhatsApp nimmt erst an, Alex meldet 'geschickt'", spaetGescheitert.length === 1 && /Angebot/.test(String(antw)));
gesendet = []; await whatsappMeldetFehler();
const warn = gesendet.find(g => g.an === "dirk" && /kam NICHT an/.test(g.text));
pruefe("WhatsApp meldet Scheitern: Dirk bekommt sofort Bescheid, mit Nummer und Text", warn && /Herr Bauer/.test(warn.text) && /\+49 176 12345678/.test(warn.text) && /520 Euro/.test(warn.text));
pruefe("Akte vermerkt es, Alex hält den Kunden für nicht mehr erreichbar", akte(4).verlauf.some(v => /NICHT angekommen/.test(v)) && !/Vorbeikommen/.test(JSON.stringify(warn.knoepfe)));

// ---- 16. Absender-Prüfung und Website-Dringend ------------------------------
log("\n16. Sicherheit");
{
  const { Readable } = await import("node:stream");
  const crypto = await import("node:crypto");
  reset(); uhr("2026-11-16T09:00:00Z"); process.env.WHATSAPP_APP_SECRET = "geheim123";
  const koerper = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ profile: { name: "Test" } }],
    messages: [{ id: "sig1", from: DIRK, timestamp: "1", type: "text", text: { body: "Angebot 1: 1 Euro" } }] } }] }] });
  const anfrage = sig => Object.assign(Readable.from([Buffer.from(koerper)]), { method: "POST", query: {}, headers: { "x-hub-signature-256": sig } });
  let r1 = res(); await wa(anfrage("sha256=falsch"), r1);
  pruefe("gefälschte Nachricht 'von Dirk' wird abgewiesen (401)", r1.statusCode === 401 && !gesendet.length);
  const echt = "sha256=" + crypto.createHmac("sha256", "geheim123").update(koerper).digest("hex");
  kiAntwort = "Gern."; let r2 = res(); await wa(anfrage(echt), r2);
  pruefe("echte Nachricht von Meta wird angenommen", r2.statusCode !== 401 && gesendet.some(g => g.an === "dirk"));
  delete process.env.WHATSAPP_APP_SECRET;
}
reset(); uhr("2026-11-16T09:00:00Z");
kiAntwort = "Das tut mir leid. Wie heißen Sie und unter welcher Nummer erreichen wir Sie? [[DRINGEND|Auto nach Unfall nicht fahrbereit]]";
let rd = res(); await chat({ method: "POST", body: { sitzung: "web-d", messages: [{ role: "user", content: "Unfall, Auto fährt nicht mehr" }] } }, rd);
pruefe("Website ohne Nummer + dringend: keine nutzlose rote Karte, Alex fragt nach der Nummer", !gesendet.some(g => g.an === "dirk" && /Dringend/.test(g.text)));
kiAntwort = "Danke, Herr Roth, der Chef ruft Sie an. [[KONTAKT|Roth|0176 5550002]]";
rd = res(); await chat({ method: "POST", body: { sitzung: "web-d", messages: [{ role: "user", content: "Unfall, Auto fährt nicht mehr" }, { role: "assistant", content: "Wie erreichen wir Sie?" }, { role: "user", content: "Roth, 0176 5550002" }] } }, rd);
uhr("2026-11-16T09:10:00Z"); gesendet = []; denkAntwort = LAGE({ kurz: "Unfall, Fahrzeug nicht fahrbereit.", stimmung: "eilig" }); await A.weckerAufgaben();
pruefe("sobald die Nummer da ist: rote Karte mit Nummer", gesendet.some(g => g.an === "dirk" && /🔴 Dringend/.test(g.text) && /0176 5550002/.test(g.text)));

// ---- 17. Mitlesen nur, wo Dirk etwas tun kann ----------------------------------
log("\n17. Mitlesen");
reset(); uhr("2026-11-16T15:00:00Z"); kiAntwort = "Mo bis Do 8 bis 17 Uhr.";
let rm = res(); await chat({ method: "POST", body: { sitzung: "web-anonym", messages: [{ role: "user", content: "Öffnungszeiten?" }] } }, rm);
pruefe("anonymer Website-Besucher: kein Mitlesen bei Dirk", !gesendet.some(g => g.an === "dirk" && /💬/.test(g.text)));
kiAntwort = "Danke, Frau Lenz. [[KONTAKT|Lenz|0176 5550003]]";
rm = res(); await chat({ method: "POST", body: { sitzung: "web-lenz", messages: [{ role: "user", content: "Lenz, 0176 5550003, Delle Tür" }] } }, rm);
pruefe("Website mit Nummer: Dirk liest mit, mit Rückrufnummer", gesendet.some(g => g.an === "dirk" && /💬/.test(g.text) && /0176 5550003/.test(g.text)));
gesendet = []; kiAntwort = "Danke."; rm = res(); await chat({ method: "POST", body: { sitzung: "probe-x", messages: [{ role: "user", content: "Lenz, 0176 5550004, Delle" }] } }, rm);
pruefe("Testgespräche (probe-…): kein Mitlesen, nicht ins Lernen", !gesendet.some(g => g.an === "dirk" && /💬/.test(g.text)) && !Object.keys(sp).some(k => /lern:g:probe/.test(k)));
reset(); uhr("2026-11-16T15:00:00Z"); sp["inhaber:fenster:" + DIRK] = String(Date.now() - 30 * 3600000); fensterOffen = false;
kiAntwort = "Gern."; await waNachricht(KUNDE, "Hallo, Delle an der Tür");
await whatsappMeldetFehler();
pruefe("Dirks Fenster zu: Mitlesen wird gar nicht erst geschickt, nichts aufgehoben", !String(sp["unzugestellt:" + DIRK] || "").includes("💬"));
reset(); uhr("2026-11-16T15:00:00Z");
sp["unzugestellt:" + DIRK] = JSON.stringify([{ text: "💬 unbekannt · Website\nKunde: Öffnungszeiten?", ts: 1 }, { text: "🆕 Nr. 3 · Echt", akteNr: 3, ts: 2 }]);
gesendet = []; kiAntwort = "Moin."; await waNachricht(DIRK, "Moin");
pruefe("alte Mitlese-Ausschnitte werden nicht nachgeliefert, echte Karten schon", !gesendet.some(g => /💬 unbekannt/.test(g.text)) && gesendet.some(g => /Nr\. 3 · Echt/.test(g.text)));

global.Date = R;
log("\n" + ok + " von " + n + " bestanden" + (ok === n ? "" : "  <-- NICHT deployen"));
console.error = stumm;
process.exit(ok === n ? 0 : 1);
