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

### Neu für die Telefon-Übergabe

| Variable | Beispiel | Zweck |
|---|---|---|
| `WA_TEMPLATE_HANDOFF` | `alex_handoff` | Name der Meta-Vorlage für die erste Nachricht nach einem Anruf. Standard, wenn leer: `alex_handoff` |
| `WA_TEMPLATE_LANG` | `de` | Sprachcode der Vorlage. Standard, wenn leer: `de` |

Die Vorlage muss in **Meta Business → WhatsApp Manager → Vorlagen**
angelegt und freigegeben sein. Solange das nicht passiert ist, schlägt
der Vorlagen-Versand fehl und der Handoff fällt auf den gesprochenen
Hinweis zurück (`weg: "fallback"`).

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
- Einmal pro Tag ein kurzes Briefing mit offenen Anfragen
- Antwortet als Assistent statt als Kundenberater
- „Termine" · „Termin 3 passt" · „Lösche Termin 3"
- „Merk dir: …" · „Zeig Notizen" · „Zeig Lücken" · „Status" · „Hilfe"

---

## Telefon / Alex Anruf

Telefon ist der dritte Kanal. Derselbe Alex, dasselbe Wissen, dieselben
Marker. Neu ist nur ein Sprech-Overlay über dem normalen Prompt.

    Web      → api/chat.js        + prompts/system-alex.md
    WhatsApp → api/whatsapp.js    + prompts/system-alex.md
    Telefon  → api/voice.js       + system-alex.md + system-alex-voice.md
    Aktionen → api/_termin.mjs
    Wissen   → knowledge/ + npm run knowledge

`prompts/system-alex-voice.md` wird zur Laufzeit gelesen und steht
**nicht** im Bundle. Änderungen daran wirken nach dem nächsten Deploy,
ohne `npm run knowledge`. Für `prompts/system-alex.md` und `knowledge/`
gilt weiterhin: nach jeder Änderung `npm run knowledge` laufen lassen.

### Was am Telefon absichtlich nicht passiert

Kein Kostenvoranschlag, keine Fotobewertung, kein Fahrzeugschein. Alex
klärt am Telefon nur kurz das Anliegen und übergibt dann auf WhatsApp.
Ab dort übernimmt `api/whatsapp.js` wie gewohnt: Fotos, Fahrzeugschein,
Weiterleitung an Dirk.

### Endpunkt testen

    curl -X POST https://IHRE-DOMAIN.de/api/voice \
      -H "content-type: application/json" \
      -d '{"text":"Guten Tag, ich hab einen Kratzer an der Tür",
           "call":{"from_number":"+4917612345678"}}'

Antwort:

    { "text": "…reiner Sprechtext, ohne Marker…", "actions": [] }

Die Anrufernummer wird robust gelesen (`from`, `caller`,
`customer_number`, `from_number`, `call.customer.number`). Der Verlauf
kommt entweder als einzelner `text` oder als Liste unter `messages`,
`transcript` oder `conversation`. In den Logs steht jeder Aufruf mit
`channel: "phone"` und der Rufnummer **nur mit den letzten vier
Ziffern**.

### Wie die Übergabe auf WhatsApp läuft

Drei Wege, in dieser Reihenfolge:

1. **Vorlage** (`sendWATemplate`) — geht auch außerhalb der 24 Stunden,
   setzt aber eine in Meta freigegebene Vorlage voraus.
2. **Freier Text** (`sendWA`, unverändert) — greift nur, wenn der Kunde
   uns in den letzten 24 Stunden geschrieben hat.
3. **Gesprochener Hinweis** — Alex sagt dem Anrufer, dass er kurz selbst
   auf WhatsApp schreiben soll.

Welcher Weg genommen wurde, steht in der Antwort im Feld `weg`
(`template` · `freitext` · `fallback`) und im Log. Solange keine Vorlage
freigegeben ist, landet ein Anrufer praktisch immer bei Weg 3.

### Weitere Einschränkung

Eine Terminanfrage vom Telefon meldet Alex über dieselbe Liste wie den
Web-Chat. Im Zettel für Dirk steht deshalb „Kam über: Website-Chat".
Die Rufnummer und der Hinweis „Telefon-Anruf von …" stehen im selben
Zettel unter Telefon und Anliegen. Sauber getrennt wäre es erst mit
einer Anpassung in `api/_termin.mjs`, die hier bewusst unterblieben ist.

Eine Anbindung an Retell, Vapi oder Twilio ist noch nicht eingerichtet.
Der Endpunkt steht, die Telefonie davor fehlt.

---

## Grenzen, die Alex selbst kennt

- Terminanfragen aus dem **Web-Chat** kann er nicht zurückschreiben.
  Er sagt das klar und nennt die Rufnummer des Kunden.
- WhatsApp erlaubt kein Anschreiben mehr, wenn die letzte
  Kundennachricht über **24 Stunden** zurückliegt. Auch dann verweist
  er auf einen Anruf.
- Er sagt nie einen Termin verbindlich zu. Bestätigt wird immer
  vom Team.
