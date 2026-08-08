# Autolackiererei Britz — Website-Export

Statische Website, sofort auf jedem Webserver lauffähig. Kein Build, keine Datenbank, keine Abhängigkeiten außer Google Fonts.

## Struktur

```
/
├── index.html            Startseite (One-Page)
├── rechtliches.html      Impressum · Datenschutz · Cookies · Ihre Rechte · Haltung
├── sitemap.xml           Für Google Search Console
├── robots.txt            Verweist auf die Sitemap
├── site.webmanifest      Symbol und Farben beim Ablegen auf dem Startbildschirm
├── .htaccess             Komprimierung, Zwischenspeicher, Sicherheitskopfzeilen (nur Apache)
└── assets/
    ├── img/              Alle Bilder
    └── js/               Seitenlogik und Service-Chat
```

## Vor dem Hochladen anpassen

Die Domain ist an vier Stellen als `https://www.autolackiererei-britz.de` hinterlegt. Bei abweichender Domain ersetzen in:

1. `sitemap.xml` — beide `<loc>`-Einträge
2. `robots.txt` — die Sitemap-Zeile
3. `index.html` — `<link rel="canonical">`, `og:image` und `"url"` in den strukturierten Daten
4. `rechtliches.html` — `<link rel="canonical">`

Ebenfalls prüfen: die E-Mail-Adresse `info@autolackiererei-britz.de` (im Impressum, in der Datenschutzerklärung und in Kapitel 04).

## Noch offen im Impressum

- Umsatzsteuer-Identifikationsnummer
- Zuständige Handwerkskammer und Berufsbezeichnung des Meistertitels

## Nach dem Hochladen

1. In der **Google Search Console** die Property anlegen und `sitemap.xml` einreichen.
2. Den **Google-Unternehmenseintrag** mit der Website verknüpfen — Name, Adresse und Öffnungszeiten müssen wörtlich mit den Angaben auf der Seite übereinstimmen.
3. Mit dem **Test für Rich-Suchergebnisse** prüfen, ob `AutoBodyShop` und `FAQPage` erkannt werden.

## Was technisch bereits umgesetzt ist

- Genau eine `h1` mit Betrieb, Leistung und Ort
- Strukturierte Daten für Kfz-Betrieb (Adresse, Koordinaten, Öffnungszeiten, Einzugsgebiet, Leistungen)
- FAQ-Auszeichnung, die automatisch aus den sichtbaren Fragen erzeugt wird
- Vorschaudaten für soziale Netzwerke
- Verzögertes Laden aller Bilder unterhalb des ersten Bildschirms
- Sprachauszeichnung `de`, aussagekräftige Alternativtexte
- Heller und dunkler Modus, tageszeitabhängige Voreinstellung
- Bedienbar per Tastatur, Bewegungen respektieren die Systemeinstellung zur Bewegungsreduktion
