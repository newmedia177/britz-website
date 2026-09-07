# WhatsApp-Vorlagen bei Meta anlegen

Warum: WhatsApp erlaubt einem Unternehmen nur innerhalb von **24 Stunden
nach der letzten Kundennachricht**, frei zu schreiben. Danach darf Alex
den Kunden nur mit einer von Meta vorab genehmigten Vorlage anschreiben.
Ohne Vorlagen kann Alex also nur *antworten*, nicht *ansprechen* – keine
Übergabe aus dem Web-Chat, kein Angebot nach Feierabend, kein
Nachfassen, keine Terminerinnerung, keine Bewertungsbitte.

**Voraussetzung:** Zahlungsmethode im Meta Business Manager hinterlegen
(Kosten: wenige Cent pro Vorlagen-Nachricht, Kategorie „Utility").

## Wo

Meta Business Suite → WhatsApp Manager → Konto 1048346318099913 →
**Nachrichtenvorlagen** → „Vorlage erstellen".
Bei allen: Kategorie **Utility**, Sprache **Deutsch (de)**.
Platzhalter `{{1}}` und `{{2}}` genau so eintragen – Alex füllt sie.

Die Genehmigung dauert meist Minuten bis wenige Stunden. Danach den
**Vorlagennamen** als Umgebungsvariable in Vercel eintragen (Namen unten)
und neu ausrollen.

---

## 1. Übergabe aus dem Website-Chat

Name: `britz_uebergabe` → Vercel-Variable `WA_VORLAGE_UEBERGABE`

> Guten Tag {{1}}, hier ist Alex von der Autolackiererei in Britz. Wir
> haben gerade auf unserer Website gesprochen – hier auf WhatsApp geht es
> weiter, damit nichts verloren geht. Ihr Anliegen: {{2}}. Antworten Sie
> einfach hier, wenn Sie Fragen haben.

## 2. Angebot / Kostenvoranschlag

Name: `britz_angebot` → `WA_VORLAGE_ANGEBOT`

> Guten Tag {{1}}, hier ist Alex von der Autolackiererei in Britz. {{2}}

(Alex setzt in {{2}} den vollständigen Angebotstext ein.)

## 3. Nachfassen

Name: `britz_nachfassen` → `WA_VORLAGE_NACHFASSEN`

> Guten Tag {{1}}, hier ist Alex von der Autolackiererei in Britz. {{2}}

## 4. Terminerinnerung

Name: `britz_erinnerung` → `WA_VORLAGE_ERINNERUNG`

> Guten Tag {{1}}, hier ist Alex von der Autolackiererei in Britz. {{2}}

## 5. Bewertungsbitte

Name: `britz_bewertung` → `WA_VORLAGE_BEWERTUNG`

> Guten Tag {{1}}, hier ist Alex von der Autolackiererei in Britz. {{2}}

Zusätzlich in Vercel: `BEWERTUNGS_LINK` = Link zur Google-Bewertungsseite
des Betriebs (Google-Unternehmensprofil → „Bewertungen erhalten" → Link
kopieren). Ohne diesen Link wird keine Bewertungsbitte verschickt.

---

## Hinweise

- Vorlagen 2–5 sind bewusst gleich aufgebaut (Anrede + freier Text).
  Meta genehmigt solche allgemeinen Utility-Vorlagen in der Regel; wird
  eine abgelehnt, den Text etwas konkreter machen („…hat Ihren Schaden
  kalkuliert: {{2}}").
- Solange eine Variable fehlt, sagt Alex Dirk bei jedem Versuch ehrlich,
  dass er nicht schicken konnte, und gibt ihm den fertigen Text zum
  Selbstschicken. Nichts geht verloren, es ist nur Handarbeit.
- Innerhalb von 24 Stunden nach einer Kundennachricht braucht Alex keine
  Vorlage – dann schreibt er frei.
