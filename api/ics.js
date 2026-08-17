// Liefert eine Termindatei (.ics) mit korrektem Dateityp aus.
//
// Warum ueberhaupt ein eigener Endpunkt? Die Datei im Browser als
// "data:"-Adresse zusammenzubauen und per Download-Attribut anzubieten
// ist auf iPhone und iPad unzuverlaessig: Safari ignoriert den Download,
// oeffnet einen neuen Tab oder bricht ab. Eine echte Adresse mit
// Content-Type text/calendar oeffnet dagegen ueberall den Kalender.
//
// Aufruf: /api/ics?t=2026-08-20T11:00&s=Titel&l=Adresse

const TITEL_MAX = 120;
const ORT_MAX = 160;

// Berliner Ortszeit -> echter Zeitpunkt (UTC). Beruecksichtigt Sommerzeit.
function berlinZuUtc(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!m) return null;
  const alsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const probe = new Date(alsUtc);
  const inBerlin = new Date(probe.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const inUtc = new Date(probe.toLocaleString("en-US", { timeZone: "UTC" }));
  const d = new Date(alsUtc - (inBerlin - inUtc));
  return isNaN(d.getTime()) ? null : d;
}

function utcStempel(d) {
  return d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

// Pflicht nach RFC 5545: Komma, Semikolon und Backslash maskieren,
// sonst zerlegen manche Kalender die Adresse an jedem Komma.
function esc(t) {
  return String(t)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// Zeilen laenger als 75 Oktett muessen umgebrochen werden (RFC 5545).
function falten(zeile) {
  if (zeile.length <= 74) return zeile;
  const teile = [zeile.slice(0, 74)];
  let rest = zeile.slice(74);
  while (rest.length > 73) {
    teile.push(" " + rest.slice(0, 73));
    rest = rest.slice(73);
  }
  if (rest) teile.push(" " + rest);
  return teile.join("\r\n");
}

export default async function handler(req, res) {
  const q = req.query || {};
  const d = berlinZuUtc(q.t);
  if (!d) {
    res.status(400).send("Ungueltiger Termin.");
    return;
  }

  const titel = String(q.s || "Termin, Autolackiererei in Britz").slice(0, TITEL_MAX);
  const ort = String(q.l || "Haarlemer Straße 48-54, 12359 Berlin").slice(0, ORT_MAX);
  const ende = new Date(d.getTime() + 60 * 60 * 1000);

  const zeilen = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Autolackiererei in Britz//Termin//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    "UID:britz-" + d.getTime() + "@autolackiererei-britz.de",
    "DTSTAMP:" + utcStempel(new Date()),
    "DTSTART:" + utcStempel(d),
    "DTEND:" + utcStempel(ende),
    "SUMMARY:" + esc(titel),
    "LOCATION:" + esc(ort),
    "DESCRIPTION:" + esc("Bestätigter Termin. Rückfragen: 030 607 97 930"),
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT2H",
    "ACTION:DISPLAY",
    "DESCRIPTION:" + esc("Termin " + titel),
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR"
  ].map(falten);

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition",
    'attachment; filename="termin-autolackiererei-britz.ics"');
  res.setHeader("Cache-Control", "no-store");
  res.status(200).send(zeilen.join("\r\n"));
}
