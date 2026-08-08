# Pflege & Weiterentwicklung des KI-Assistenten

Der Assistent verbessert sich auf drei Ebenen – von "sofort" bis
"grundlegend". Wichtig: Er ändert seine Wissensbasis nie eigenmächtig.
Alles Neue kommt vom Inhaber oder von euch, er sammelt nur zu.

## Ebene 1 – Sofort: Lern-Modus per WhatsApp (Inhaber)
Der Inhaber schreibt dem Assistenten wie einem Mitarbeiter. Nur
Nummern aus OWNER_NUMBERS dürfen das.
- "Merk dir: Scheibentausch übernimmt immer die Teilkasko."
  -> gilt sofort in ALLEN Kundengesprächen (Web + WhatsApp)
- "Zeig Notizen"  -> alle gemerkten Hinweise, nummeriert
- "Vergiss 2"     -> Hinweis 2 löschen
- "Zeig Lücken"   -> Fragen, die der Assistent NICHT beantworten konnte
- "Lücken leeren" -> Liste zurücksetzen
- "Hilfe"         -> Befehlsübersicht
Wirkung: Sekunden. Kein Deployment nötig.

## Ebene 2 – Automatisch: Wissenslücken-Erkennung
Sagt der Assistent sinngemäß "da muss ich passen" oder "das klärt das
Team", protokolliert er die Kundenfrage still in Upstash (Schlüssel
`gaps`), mit Zähler und Datum. So entsteht von allein eine Liste, was
Kunden wirklich fragen und was noch fehlt.
Empfehlung: Der Inhaber schickt einmal pro Woche "Zeig Lücken" und
beantwortet die häufigsten direkt mit "Merk dir: …". Damit schließt
sich die Schleife: Der Assistent erkennt seine Lücken selbst, der
Fachmann füllt sie in 30 Sekunden.

## Ebene 3 – Regelmäßig: Wissensbasis pflegen (alle 4–8 Wochen)
Die Inhaber-Notizen sind ein Schnellspeicher, nicht die Wahrheit.
Deshalb regelmäßig in die knowledge/-Dateien überführen:
1. "Zeig Notizen" -> Notizen sichten
2. Inhalte in die passende Datei in knowledge/ einarbeiten
   (mit Claude Code: "Arbeite die Inhaber-Notizen in die Wissensbasis
   ein und lösche Doppeltes")
3. `node scripts/build-knowledge.mjs` ausführen
4. Commit + Push -> Vercel deployt automatisch
5. Übernommene Notizen mit "Vergiss N" entfernen
Vorteil: Die Wissensbasis bleibt die eine saubere Quelle, der
Prompt-Cache bleibt effizient, nichts widerspricht sich.

## Ebene 4 – Bei Bedarf: Verhalten & Qualität
- Neue Fallbeispiele (Fotos + Meister-Einschätzung) in
  knowledge/*fallbeispiele*.md ergänzen – das ist der stärkste Hebel
  für treffsichere Foto-Einschätzungen.
- Tonfall, Regeln, Grenzen: prompts/system-*.md anpassen.
- Modellwechsel: Umgebungsvariable CLAUDE_MODEL – kein Code-Umbau.

## Qualitätskontrolle (Test-Set)
Ein paar Fälle mit bekannter Meister-Einschätzung NICHT einpflegen,
sondern als Prüfsteine behalten. Nach jeder größeren Änderung dieselben
Fotos schicken und vergleichen, ob die Einschätzung noch stimmt.
So merkt ihr sofort, wenn eine Änderung etwas verschlechtert.

## Warum sich der Assistent nicht selbst umschreibt
Technisch möglich wäre es – sinnvoll ist es nicht: Ein Assistent, der
sein eigenes Regelwerk ändert, kann Fehler verstärken (falsche
Kundenaussage wird zur "Wahrheit"), und niemand könnte nachvollziehen,
warum er plötzlich etwas anderes sagt. In einem Betrieb, wo Aussagen zu
Preisen, Terminen und Versicherungen verbindlich wirken, gilt deshalb:
Der Assistent erkennt und meldet – der Mensch entscheidet und gibt frei.
