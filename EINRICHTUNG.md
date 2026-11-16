# Einrichtung: Alex auf WhatsApp (Autolackiererei in Britz)

## Grundregel: alles eigen

Britz teilt sich **nichts** mit anderen Kundenprojekten. Jede der
folgenden Ressourcen wird für Britz neu angelegt:

| Ressource | Britz |
|---|---|
| Vercel-Projekt | `britz-website` |
| GitHub-Repo | `britz-website` (privat) |
| Anthropic API-Key | eigener Key, Name „britz" |
| Upstash-Datenbank | **neu anlegen**, z. B. `britz-alex` |
| Meta-App | **neu anlegen** |
| WhatsApp-Nummer | eigene eSIM, nie in normalem WhatsApp aktiviert |
| OWNER_NUMBERS | nur Dirks Nummer |

Ein Key oder eine Datenbank aus einem anderen Projekt hätte zur Folge,
dass sich Terminlisten, Notizen und Gesprächsverläufe zweier Betriebe
vermischen. Das darf nicht passieren.

---

## Umgebungsvariablen in Vercel

Vercel → Projekt `britz-website` → Settings → Environment Variables.
Alle auf **Production and Preview**.

### Schon gesetzt
| Name | Wert |
|---|---|
| `ANTHROPIC_API_KEY` | eigener Britz-Key |
| `CLAUDE_MODEL` | `claude-sonnet-5` |

### Neu für Speicher und Termine
| Name | Wert |
|---|---|
| `UPSTASH_REDIS_REST_URL` | aus der **neuen** Upstash-Datenbank |
| `UPSTASH_REDIS_REST_TOKEN` | aus derselben Datenbank |
| `OWNER_NUMBERS` | Chef-Nummern, kommagetrennt (siehe unten) |

### Seit 14.11.2026 (alle freiwillig)
| Name | Wert | Wozu |
|---|---|---|
| `TECHNIK_NUMMERN` | Julians Nummer, Format wie unten | Lernvorschläge, Lernbericht und Technik-Wochenbericht gehen dann NUR an diese Nummer. Dirk bekommt nur noch Kundenthemen. Die Nummer darf Befehle geben, auch wenn sie nicht in `OWNER_NUMBERS` steht. |
| `TECHNIK_MAIL` | E-Mail der Technik | Aussetzer und „Wecker läuft nicht“ |
| `WHATSAPP_APP_SECRET` | App-Geheimnis aus Meta (App-Dashboard → Einstellungen → Allgemein → App-Geheimnis), als **Secret** | Prüft, dass Webhook-Aufrufe wirklich von Meta kommen. Ohne sie könnte jemand Nachrichten „von Dirk“ vortäuschen. „Status“ zeigt „Absender-Prüfung: an“. |
| `CLAUDE_MODEL_DENKEN` | Modellname | Eigenes Modell für Zusammenfassung, Nachhaken und Lernrunde. Ohne Angabe gilt `CLAUDE_MODEL`. |
| `WA_SAMMELN_MS` | `2500` | So lange wartet Alex auf weitere Textnachrichten, bevor er einmal auf alles antwortet. |
| `WA_SAMMELN_BILD_MS` | `4500` | Dasselbe nach einem Foto (Fotos kommen meist im Paket). |

### Der Wecker (Pflicht)
`/api/cron` muss alle 15 Minuten aufgerufen werden, sonst kommen Karten,
Nachhaken und Erinnerungen nur, wenn zufällig jemand schreibt. Vercel
Hobby ruft nur einmal am Tag. Deshalb: cron-job.org, alle 15 Minuten,
`https://www.autolackiererei-britz.de/api/cron`, Header `Authorization:
Bearer <CRON_SECRET>`. Bleibt der Wecker über eine Stunde aus, bekommt
`TECHNIK_MAIL` eine Mail. „Status“ an Alex zeigt, wann er zuletzt lief.

#### Format der Chef-Nummern
International, **ohne** `+`, ohne Leerzeichen, führende `0` durch `49`
ersetzt. Mehrere Nummern mit Komma, ohne Leerzeichen dazwischen.

```
0172 3826925   ->  491723826925
0171 8838838   ->  491718838838
```

Wer hier eingetragen ist, wird von Alex als Chef erkannt: Er antwortet
dann als Assistent statt als Kundenberater, gibt einmal täglich ein
Briefing und nimmt Befehle wie „Termine" oder „Merk dir: …" an.

Die tatsächlichen Nummern stehen bewusst **nicht** in dieser Datei,
sondern nur in Vercel. Private Rufnummern gehören nicht in ein
Git-Repository, auch nicht in ein privates.

Ohne Upstash läuft der Web-Chat weiter, aber es gibt kein Gedächtnis,
keine Terminliste und keinen Lern-Modus.

### Neu für WhatsApp
| Name | Wert |
|---|---|
| `WHATSAPP_TOKEN` | Zugriffstoken der Britz-Meta-App |
| `WHATSAPP_PHONE_ID` | **nicht** die Rufnummer, siehe unten |
| `WHATSAPP_VERIFY_TOKEN` | frei wählbares Geheimwort, nur für den Webhook |
| `GRAPH_VERSION` | optional, Standard `v25.0` |

#### Häufiger Fehler: PHONE_ID ist keine Rufnummer
`WHATSAPP_PHONE_ID` ist eine interne Kennung von Meta, eine lange
Ziffernfolge ohne Bezug zur Rufnummer. Sie steht im Meta-Dashboard
unter WhatsApp → API Setup, direkt neben der registrierten Nummer.
Die Rufnummer selbst wird nirgends als Variable eingetragen.

Webhook-URL in der Meta-App:
`https://www.autolackiererei-britz.de/api/whatsapp`

---

## Reihenfolge

1. Upstash-Datenbank anlegen, beide Werte in Vercel eintragen
2. `OWNER_NUMBERS` eintragen
3. Neu deployen, dann im Web-Chat einen Termin durchspielen
4. Meta-App anlegen, Unternehmen verifizieren
5. WhatsApp-Nummer registrieren, Token in Vercel eintragen
6. Webhook eintragen und verifizieren
7. Test: Dirk schreibt „Hilfe" an die neue Nummer

Schritt 1 bis 3 gehen **ohne** WhatsApp. Danach meldet Alex
Terminanfragen aus dem Web-Chat bereits in der Liste — der Inhaber
sieht sie, sobald WhatsApp dazukommt.

---

## Was Alex nach der Einrichtung kann

**Für Kunden** (Web-Chat und WhatsApp)
- Schäden anhand von Fotos einschätzen
- Termine zur kostenfreien Begutachtung aufnehmen
- Kennt Öffnungszeiten, Feiertage und buchbare Zeitfenster

**Für Dirk** (nur von den Nummern in `OWNER_NUMBERS`)
- Pro Kunde EINE Karte, sobald das Gespräch ruht oder übergeben ist:
  Zusammenfassung, was fehlt, Empfehlung, Fotos, Knöpfe
  (Ich rufe an · Vorbeikommen · Details · Erledigt)
- Preis schicken: auf die Karte antworten, z. B. „480 Euro, Stoßfänger lackieren"
- Frei schreiben: „Was will Nr. 7?" oder „Schreib Nr. 7, dass wir uns
  Montag melden". Alex zeigt den Text, Dirk tippt auf „Senden"
- „Gespräch 7" zeigt den Wortlaut, „Übernehme 7" lässt Dirk selbst schreiben
- Morgens ein kurzer Überblick, Dringendes zuerst
- „Nachhaken aus" / „Nachhaken an": Alex schreibt stillen Kunden von
  sich aus (oder eben nicht). „Mitlesen aus" / „an": jedes Gespräch live
- „Hilfe" zeigt alle Befehle, „Status" den technischen Stand

---

## Grenzen, die Alex selbst kennt

- Terminanfragen aus dem **Web-Chat** kann er nicht zurückschreiben.
  Er sagt das klar und nennt die Rufnummer des Kunden.
- WhatsApp erlaubt kein Anschreiben mehr, wenn die letzte
  Kundennachricht über **24 Stunden** zurückliegt. Auch dann verweist
  er auf einen Anruf.
- Termine bucht er verbindlich in festen Zeitfenstern (seit September
  2026). Preise nennt er nie.
- Kunden schreibt er von sich aus höchstens zweimal an: einmal, wenn
  sie mitten im Ablauf verstummen, und einmal vor Ablauf der 24 Stunden.
  Nie nachts, nie mit Preisen, nie bei verärgerten oder lange wartenden
  Kunden. Die gehen als „dringend" an Dirk.
