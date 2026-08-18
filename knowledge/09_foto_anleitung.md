---
thema: Foto-Anleitung für Schadensbilder
prioritaet: A
quelle: autolackiererei-britz.de (Startseite, alle Leistungsseiten)
status: BEISPIELBILDER VOM KUNDEN AUSSTEHEND
---

# Foto-Anleitung für Schadensbilder

Dieses Dokument beschreibt, wie Kunden ihren Schaden fotografieren sollen,
damit Werkstatt und KI-Assistent ihn beurteilen können. Es ist zugleich die
Referenz für die Bildanalyse im Chat.

## Anforderungen an gute Schadensfotos
0. **Zwei bis vier Bilder**, und auf einem davon soll das **Kennzeichen
   sichtbar** sein. So ist das Fahrzeug eindeutig zuzuordnen, wenn
   mehrere Anfragen gleichzeitig laufen. Ein einzelnes Nahfoto reicht
   für eine Kalkulation nicht aus.
1. Das beschädigte Bauteil UND die angrenzenden Bauteile müssen im Bild sein.
   Nur so lassen sich die Größe des Schadens und der Aufwand für Ein- und
   Ausbauarbeiten beurteilen.
2. Mehrere Fotos aus verschiedenen Distanzen: eine Gesamtaufnahme der
   Fahrzeugseite/-ecke, eine mittlere Distanz mit dem betroffenen Bauteil
   komplett im Bild, eine Nahaufnahme des Schadens.
3. Gute Ausleuchtung (Tageslicht), keine starken Spiegelungen direkt auf dem
   Schaden, Fahrzeug möglichst sauber an der Schadstelle.
4. Bei Dellen hilft ein flacher Blickwinkel (schräg über das Blech
   fotografieren), damit die Verformung sichtbar wird.

## Ungeeignete Fotos (dann um neue bitten)
- Nur extreme Nahaufnahme ohne erkennbares Bauteil
- Zu dunkel, verwackelt oder starke Reflexion genau auf der Schadstelle
- Schaden von Schmutz überdeckt
- Bauteil nur teilweise im Bild, angrenzende Teile fehlen

## Was der Assistent aus Fotos einschätzen darf
- Betroffenes Bauteil (z. B. Stoßfänger vorn links, Fahrertür, Kotflügel)
- Schadensart: Kratzer (oberflächlich/tief), Delle, Beule, Riss, Lackplatzer
- Grobe Größe und ob angrenzende Bauteile betroffen wirken
- Wahrscheinlicher Reparaturweg als VORLÄUFIGE Einschätzung

## Was der Assistent aus Fotos NICHT ableiten darf
- Verbindliche Preise oder verbindliche Reparaturwege
- Aussagen zu verdeckten Schäden (Struktur, Sensorik, Träger) – hier immer
  auf die Begutachtung verweisen, besonders nach Unfällen
- Versicherungs- oder Haftungsbewertungen

## [TODO KUNDE]
Beispiel-Fotoreihen liefern: je Schadensbild (Kratzer, Delle, Unfallschaden)
eine geeignete und eine ungeeignete Serie. Diese dienen später als
Few-Shot-Referenzen für die Bildanalyse und als Beispielbilder im Widget.

## Fahrzeugschein mitschicken (beschleunigt den Kostenvoranschlag)
Alex bittet bei KVA-Anfragen um ein Foto der Zulassungsbescheinigung
Teil I (Fahrzeugschein), **aufgeklappt**, und liest daraus die
Fahrzeugdaten aus: Marke/Modell, HSN/TSN (Felder 2.1/2.2), FIN,
Erstzulassung. Damit kann das Team die Kalkulation ohne Rückfragen
aufsetzen.
Statt des Scheins genügt auch die FIN allein. Möchte jemand die FIN
nicht herausgeben, reichen für eine erste Kalkulation die
Schlüsselnummern zu 2 und zu 3 (HSN/TSN) – die Ausstattungspakete
sind daraus zwar nicht erkennbar, für den Anfang genügt es. Details
siehe Kapitel 11.
Hinweise von Alex an den Kunden: Foto bei gutem Licht, ohne
Spiegelung; Name und Adresse dürfen gern abgedeckt werden – wichtig
sind nur die Fahrzeugdaten. Die Daten werden nur für die Anfrage
genutzt und nicht gespeichert.
