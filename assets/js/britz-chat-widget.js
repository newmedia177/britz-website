/*
  =====================================================
  KI-ASSISTENT "BRITZ SERVICE" – Einbau-Block
  =====================================================
  Unveraendert uebernommen; als selbst-injizierendes
  Widget verpackt, damit es am Ende des <body> landet.
  Der Assistent erscheint unten rechts (Avatar mit
  Puls + gruenem Online-Punkt). Antworten kommen erst
  mit dem Backend - bis dahin erscheint die Fallback-
  Meldung mit der Telefonnummer. Das ist normal.
  =====================================================
*/
(function () {
  "use strict";
  if (window.__albWidgetLoaded) return;
  window.__albWidgetLoaded = true;

  var FONT_PRECONNECT = "https://fonts.googleapis.com";
  var FONT_HREF = "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&display=swap";

  var WIDGET_CSS = [
'  :root {',
'    --alb-ink: #16181c;',
'    --alb-ink-2: #24272c;',
'    --alb-yellow: #f5c400;',
'    --alb-yellow-d: #e0b400;',
'    --alb-green: #4cbb87;',
'    --alb-aura: 158,209,228;',
'    --alb-line: #e7e7e3;',
'    --alb-bg: #f7f7f4;',
'    --alb-fd: "Space Grotesk", system-ui, sans-serif;',
'    --alb-fb: Inter, system-ui, sans-serif;',
'  }',
'',
'  /* ================= Avatar: Foto + Schein + Online-Punkt == */',
'  .alb-avatar { position: relative; display: inline-block;',
'    flex-shrink: 0; }',
'  .alb-avatar img { width: 100%; height: 100%; display: block;',
'    border-radius: 50%; object-fit: cover; position: relative;',
'    z-index: 2; background: #dfe3e8;',
'    border: 2.5px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,.16); }',
'  .alb-avatar::before { content: ""; position: absolute; inset: -16%;',
'    border-radius: 50%; z-index: 0; pointer-events: none;',
'    background: radial-gradient(circle,',
'      rgba(var(--alb-aura),.36) 0%, rgba(var(--alb-aura),.17) 52%,',
'      rgba(var(--alb-aura),0) 72%); }',
'  .alb-avatar .ring, .alb-avatar .ring2 {',
'    position: absolute; inset: -10%; border-radius: 50%;',
'    z-index: 0; pointer-events: none; opacity: 0;',
'    background: radial-gradient(circle,',
'      rgba(var(--alb-aura),.48) 0%, rgba(var(--alb-aura),.25) 45%,',
'      rgba(var(--alb-aura),0) 70%);',
'    filter: blur(1.5px);',
'  }',
'  @media (prefers-reduced-motion: no-preference) {',
'    .alb-avatar .ring  { animation: alb-glow 5.4s ease-out infinite; }',
'    .alb-avatar .ring2 { animation: alb-glow 5.4s ease-out 2.7s infinite; }',
'    .alb-avatar.thinking .ring  { animation-duration: 1.7s; }',
'    .alb-avatar.thinking .ring2 { animation-duration: 1.7s;',
'      animation-delay: .85s; }',
'    .alb-avatar.answering .ring  { animation-duration: 3s; }',
'    .alb-avatar.answering .ring2 { animation-duration: 3s;',
'      animation-delay: 1.5s; }',
'  }',
'  @keyframes alb-glow {',
'    0% { transform: scale(.92); opacity: .85; }',
'    100% { transform: scale(2.05); opacity: 0; }',
'  }',
'  .alb-avatar .dot { position: absolute; z-index: 3;',
'    right: 2%; bottom: 2%; width: 28%; height: 28%;',
'    background: var(--alb-green); border-radius: 50%;',
'    border: 3px solid #fff; box-sizing: border-box;',
'    box-shadow: 0 1px 4px rgba(0,0,0,.15); }',
'',
'  /* ================= Launcher =============================== */',
'  .alb-launch { position: fixed; right: 22px; bottom: 22px;',
'    z-index: 99998; border: 0; padding: 0; cursor: pointer;',
'    background: transparent; transition: transform .18s ease; }',
'  .alb-launch:hover { transform: scale(1.06); }',
'  .alb-launch .alb-avatar { width: 68px; height: 68px; }',
'  .alb-badge { position: relative; display: inline-block; }',
'  .alb-badge img { width: 100%; height: 100%; display: block;',
'    object-fit: contain; position: relative; z-index: 2;',
'    filter: drop-shadow(0 2px 6px rgba(0,0,0,.14)); }',
'  .alb-badge::before { content: ""; position: absolute; inset: -10%;',
'    border-radius: 26%; z-index: 0; pointer-events: none;',
'    background: radial-gradient(circle,',
'      rgba(var(--alb-aura),.16) 0%, rgba(var(--alb-aura),0) 68%); }',
'  .alb-badge .dot { position: absolute; z-index: 3; right: 0; bottom: 4%;',
'    width: 22%; height: 22%; background: var(--alb-green);',
'    border-radius: 50%; border: 3px solid #fff; box-sizing: border-box; }',
'  .alb-launch .alb-badge { width: 74px; height: 74px; }',
'  .alb-hero .alb-badge { width: 86px; height: 86px; }',
'  .alb-launch .hint { position: absolute; right: 84px; top: 50%;',
'    translate: 0 -50%; background: #fff; color: var(--alb-ink);',
'    white-space: nowrap; text-align: left;',
'    font: 500 13px/1.35 var(--alb-fb);',
'    padding: 10px 14px; border-radius: 12px;',
'    box-shadow: 0 4px 18px rgba(0,0,0,.16); opacity: 0;',
'    pointer-events: none; transition: opacity .2s ease; }',
'  .alb-launch .hint b { display: block; font-family: var(--alb-fd); }',
'  .alb-launch .hint span { color: #6a6c70; font-size: 12px; }',
'  .alb-launch:hover .hint { opacity: 1; }',
'',
'  /* ================= Panel ================================== */',
'  .alb-panel { position: fixed; right: 22px; bottom: 102px;',
'    z-index: 99999; width: 400px; max-width: calc(100vw - 24px);',
'    height: 640px; max-height: calc(100vh - 124px);',
'    background: var(--alb-bg); border-radius: 20px; overflow: hidden;',
'    box-shadow: 0 8px 24px rgba(10,12,16,.14),',
'                0 24px 64px rgba(10,12,16,.26);',
'    display: none; flex-direction: column;',
'    font: 14.5px/1.5 var(--alb-fb); color: var(--alb-ink); }',
'  .alb-panel.open { display: flex; }',
'  @media (max-width: 480px) {',
'    .alb-panel { right: 0; bottom: 0; width: 100vw; height: 100dvh;',
'      max-height: none; border-radius: 0; }',
'    .alb-inputwrap { padding-bottom:',
'      calc(6px + env(safe-area-inset-bottom)); }',
'    .alb-legal { padding-bottom:',
'      calc(10px + env(safe-area-inset-bottom)); } }',
'  @media (prefers-reduced-motion: no-preference) {',
'    .alb-panel.open { animation: alb-in .24s cubic-bezier(.2,.9,.3,1); }',
'    @keyframes alb-in { from { opacity: 0;',
'      transform: translateY(16px) scale(.97); } } }',
'',
'  /* Header */',
'  .alb-head { background: linear-gradient(165deg,',
'      var(--alb-ink) 50%, var(--alb-ink-2));',
'    color: #fff; padding: 12px 38px 12px 16px;',
'    display: flex; align-items: center; gap: 13px; }',
'  .alb-head .t { flex: 1; min-width: 0; }',
'  .alb-head .alb-avatar { width: 40px; height: 40px; display: none; }',
'  .alb-head.has-agent .alb-avatar { display: inline-block; }',
'  .alb-join { align-self: center; display: inline-flex; align-items: center;',
'    gap: 7px; font: 500 11.5px/1 var(--alb-fb); color: #6a6c70;',
'    background: #ecece8; padding: 6px 12px; border-radius: 999px;',
'    margin: 2px 0 10px; }',
'  .alb-join i { width: 6px; height: 6px; border-radius: 50%;',
'    background: var(--alb-green); }',
'  .alb-head .t b { display: block; font: 700 15.5px/1.2 var(--alb-fd);',
'    letter-spacing: .02em; }',
'  .alb-head .t span { font-size: 12px; opacity: .65; }',
'  .alb-pill { display: inline-flex; align-items: center; gap: 6px;',
'    font: 600 11px/1 var(--alb-fd); letter-spacing: .05em;',
'    text-transform: uppercase; color: #d9f5e8;',
'    background: rgba(76,187,135,.16);',
'    border: 1px solid rgba(76,187,135,.35);',
'    padding: 6px 10px; border-radius: 999px; white-space: nowrap; }',
'  .alb-pill i { width: 7px; height: 7px; border-radius: 50%;',
'    background: var(--alb-green); }',
'  .alb-close { position: absolute; top: 6px; right: 8px; z-index: 6;',
'    width: 28px; height: 28px; border: 0; background: none;',
'    color: rgba(255,255,255,.55); display: grid; place-items: center;',
'    padding: 0; font-size: 18px; line-height: 1; cursor: pointer;',
'    transition: color .15s ease; }',
'  .alb-close:hover { color: #fff; }',
'',
'  /* Welcome */',
'  .alb-hero { display: flex; flex-direction: column;',
'    align-items: center; gap: 8px; padding: 18px 20px 4px;',
'    text-align: center; flex-shrink: 1; min-height: 0;',
'    overflow-y: auto; }',
'  .alb-hero .alb-avatar { width: 56px; height: 56px;',
'    margin-bottom: 0; }',
'  .alb-hero h2 { margin: 0; font: 700 18px/1.25 var(--alb-fd); }', 
'  .alb-panel p, .alb-hero p, .alb-msg { hyphens: manual; }',
'  .alb-hero p { margin: 0; font-size: 13.5px; color: #5c5e63;',
'    max-width: 300px; }',
'  .alb-cards { display: grid; grid-template-columns: 1fr 1fr;',
'    grid-auto-rows: 1fr; gap: 8px; padding: 12px 16px 2px;',
'    flex-shrink: 1; min-height: 0; overflow-y: auto; }',
'  .alb-card { display: flex; flex-direction: column; gap: 5px;',
'    align-items: flex-start; text-align: left; cursor: pointer;',
'    background: #fff; border: 1px solid var(--alb-line);',
'    border-radius: 14px; padding: 10px 12px;',
'    font: 600 13px/1.3 var(--alb-fb); color: var(--alb-ink);',
'    box-shadow: 0 1px 3px rgba(0,0,0,.04);',
'    transition: transform .14s ease, border-color .14s,',
'                box-shadow .14s; }',
'  .alb-card:hover { transform: translateY(-2px);',
'    border-color: var(--alb-yellow);',
'    box-shadow: 0 6px 16px rgba(0,0,0,.08); }',
'  .alb-card svg { width: 21px; height: 21px; stroke: var(--alb-ink);',
'    stroke-width: 1.8; fill: none; stroke-linecap: round;',
'    stroke-linejoin: round; }',
'  .alb-card em { font: 400 11.5px/1.35 var(--alb-fb);',
'    color: #7a7c80; font-style: normal; }',
'',
'  /* Chatverlauf */',
'  .alb-log { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 16px 6px;',
'    display: flex; flex-direction: column; gap: 4px; }',
'  .alb-day { align-self: center; font: 600 10.5px/1 var(--alb-fd);',
'    letter-spacing: .08em; text-transform: uppercase; color: #9a9c9f;',
'    background: #ecece8;',
'    padding: 5px 10px; border-radius: 999px; margin: 4px 0 10px; }',
'  .alb-row { display: flex; gap: 8px; align-items: flex-end;',
'    margin-bottom: 8px; }',
'  .alb-row.user { justify-content: flex-end; }',
'  .alb-row .mini { width: 26px; height: 26px; border-radius: 50%;',
'    object-fit: cover; flex-shrink: 0; box-shadow: 0 1px 3px',
'    rgba(0,0,0,.15); }',
'  .alb-row .mini.ghost { visibility: hidden; }',
'  .alb-msg { max-width: 82%; padding: 10px 14px; border-radius: 16px;',
'    white-space: pre-wrap; word-wrap: break-word; font-size: 14px; }',
'  .alb-row:not(.user) .alb-msg { background: #fff;',
'    border: 1px solid var(--alb-line); border-bottom-left-radius: 5px;',
'    box-shadow: 0 1px 3px rgba(0,0,0,.04); }',
'  .alb-row.user .alb-msg { background: var(--alb-ink); color: #fff;',
'    border-bottom-right-radius: 5px; }',
'  .alb-msg img { max-width: 140px; border-radius: 10px;',
'    display: block; margin-top: 6px; }',
'  @media (prefers-reduced-motion: no-preference) {',
'    .alb-row { animation: alb-msg-in .22s ease; }',
'    @keyframes alb-msg-in { from { opacity: 0;',
'      transform: translateY(6px); } } }',
'',
'  /* Tipp-Indikator */',
'  .alb-typing { display: inline-flex; gap: 4px; padding: 13px 14px; }',
'  .alb-typing i { width: 6px; height: 6px; border-radius: 50%;',
'    background: #b9bbbe; }',
'  @media (prefers-reduced-motion: no-preference) {',
'    .alb-typing i { animation: alb-bounce 1.2s infinite; }',
'    .alb-typing i:nth-child(2) { animation-delay: .15s; }',
'    .alb-typing i:nth-child(3) { animation-delay: .3s; }',
'    @keyframes alb-bounce { 0%,60%,100% { transform: none; }',
'      30% { transform: translateY(-4px); } } }',
'',
'  /* Foto-Vorschau */',
'  .alb-previews { display: flex; gap: 7px; padding: 0 16px 6px; }',
'  .alb-previews .p { position: relative; }',
'  .alb-previews img { width: 48px; height: 48px; object-fit: cover;',
'    border-radius: 10px; border: 1px solid var(--alb-line); }',
'  .alb-previews .rm { position: absolute; top: -6px; right: -6px;',
'    width: 18px; height: 18px; border-radius: 50%; border: 0;',
'    background: var(--alb-ink); color: #fff; font-size: 11px;',
'    line-height: 18px; padding: 0; cursor: pointer; }',
'',
'  /* Eingabeleiste als Pill */',
'  .alb-inputwrap { flex-shrink: 0; padding: 10px 12px 6px; background:',
'    linear-gradient(180deg, rgba(247,247,244,0), var(--alb-bg) 40%); }',
'  .alb-input { display: flex; align-items: flex-end; gap: 6px;',
'    background: #fff; border: 1px solid var(--alb-line);',
'    border-radius: 24px; padding: 6px 6px 6px 8px;',
'    box-shadow: 0 2px 10px rgba(0,0,0,.05);',
'    transition: border-color .15s, box-shadow .15s; }',
'  .alb-input:focus-within { border-color: #d6c65e;',
'    box-shadow: 0 2px 14px rgba(245,196,0,.18); }',
'  .alb-input textarea { flex: 1; resize: none; border: 0;',
'    outline: none; background: none; font: 14px/1.45 var(--alb-fb);',
'    padding: 8px 4px; max-height: 96px; }',
'  .alb-ib { width: 38px; height: 38px; border-radius: 50%;',
'    border: 0; background: none; cursor: pointer; flex-shrink: 0;',
'    display: grid; place-items: center;',
'    transition: background .15s; }',
'  .alb-ib:hover { background: #f2f2ee; }',
'  .alb-ib svg { width: 20px; height: 20px; stroke: #6a6c70;',
'    stroke-width: 1.8; fill: none; stroke-linecap: round;',
'    stroke-linejoin: round; }',
'  .alb-sendb { background: var(--alb-yellow); opacity: .45;',
'    pointer-events: none; }',
'  .alb-sendb.ready { opacity: 1; pointer-events: auto; }',
'  .alb-sendb:hover { background: var(--alb-yellow-d); }',
'  .alb-sendb svg { stroke: var(--alb-ink); }',
'  .alb-legal { flex-shrink: 0; font-size: 10.5px; color: #97978f;',
'    text-align: center; padding: 6px 16px 10px; }',
'',
'  /* Kompakt bei niedriger Fensterh\u00f6he */',
'  @media (max-height: 720px) {',
'    .alb-hero { padding: 12px 20px 0; gap: 5px; }',
'    .alb-hero .alb-avatar { display: none; }',
'    .alb-hero p { display: none; }',
'    .alb-hero h2 { font-size: 16px; }',
'    .alb-cards { gap: 7px; padding: 10px 14px 2px; }',
'    .alb-card { padding: 8px 10px; gap: 4px; font-size: 12px; }',
'    .alb-card svg { width: 17px; height: 17px; }',
'    .alb-card em { display: none; }',
'    .alb-log { padding: 6px 16px 2px; } }',
'',
'  /* ====== Präsenz: atmender Punkt / Bald zurück ============= */',
'  @keyframes alb-breath {',
'    0%,100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(76,187,135,.45); }',
'    50% { transform: scale(1.12); box-shadow: 0 0 0 5px rgba(76,187,135,0); } }',
'  @media (prefers-reduced-motion: no-preference) {',
'    .alb-avatar.is-online .dot,',
'    .alb-badge.is-online .dot,',
'    .alb-pill.is-online i { animation: alb-breath 3.4s ease-in-out infinite; } }',
'  .alb-avatar.is-away .dot,',
'  .alb-badge.is-away .dot { background: var(--alb-amber, #e0a83a); }',
'  .alb-pill.is-away { color: #f6e6c4;',
'    background: rgba(224,168,58,.16);',
'    border-color: rgba(224,168,58,.38); }',
'  .alb-pill.is-away i { background: var(--alb-amber, #e0a83a); animation: none; }',
'',
'  /* ====== mitlaufende Tipp-Punkte hinter dem Text =========== */',
'  .alb-typing.live { display: inline-flex; padding: 0 0 0 6px;',
'    vertical-align: baseline; }',
'  .alb-typing.live i { width: 5px; height: 5px; }',
'',
'  /* ====== Termin-Karte mit Kalender-Download ================ */',
'  .alb-termin { display: block; margin-top: 10px; padding: 12px 14px;',
'    border-radius: 12px; background: rgba(255,255,255,.05);',
'    border: 1px solid rgba(255,255,255,.14); }',
'  .alb-termin b { display: block; font-size: 13px; margin-bottom: 3px; }',
'  .alb-termin span { display: block; font-size: 12.5px; opacity: .88; }',
'  .alb-termin i { display: block; font-style: normal; font-size: 11.5px;',
'    opacity: .62; margin: 6px 0 10px; }',
'  .alb-termin button { border: 0; cursor: pointer; font: inherit;',
'    font-size: 12.5px; font-weight: 600; padding: 8px 14px;',
'    border-radius: 999px; background: var(--alb-gold, #c9a227);',
'    color: #16181c; transition: filter .15s ease; }',
'  .alb-termin button:hover { filter: brightness(1.08); }',
'',
'  /* ================= Dark-Mode ==============================',
'     Die Seite schaltet ueber html[data-theme="dark"]. Das Widget',
'     hoert mit. Header hat bewusst einen EIGENEN dunklen Verlauf,',
'     sonst wird er hell, sobald --alb-ink umdefiniert ist. */',
'  html[data-theme="dark"] .alb-panel {',
'    --alb-bg: #12161b;',
'    --alb-line: #2a3038;',
'    --alb-ink: #e8eaed;',
'    color: var(--alb-ink);',
'    box-shadow: 0 8px 24px rgba(0,0,0,.42),',
'                0 24px 64px rgba(0,0,0,.55); }',
'  html[data-theme="dark"] .alb-head {',
'    background: linear-gradient(165deg, #10151b 50%, #171d25); }',
'  html[data-theme="dark"] .alb-hero p { color: #9aa1ab; }',
'  html[data-theme="dark"] .alb-card {',
'    background: #1a1f26; border-color: #2a3038; color: #e8eaed; }',
'  html[data-theme="dark"] .alb-card:hover { background: #212832; }',
'  html[data-theme="dark"] .alb-card svg { stroke: #e8eaed; }',
'  html[data-theme="dark"] .alb-card em { color: #9aa1ab; }',
'  html[data-theme="dark"] .alb-row:not(.user) .alb-msg {',
'    background: #1a1f26; border-color: #2a3038; color: #e8eaed;',
'    box-shadow: none; }',
'  /* Eigene Blase des Kunden: sonst dunkel auf dunkel = unsichtbar */',
'  html[data-theme="dark"] .alb-row.user .alb-msg {',
'    background: #1b3e63; color: #fff; }',
'  html[data-theme="dark"] .alb-inputwrap { background: #12161b; }',
'  html[data-theme="dark"] .alb-input {',
'    background: #1a1f26; border-color: #2a3038; }',
'  html[data-theme="dark"] .alb-input textarea { color: #e8eaed; }',
'  html[data-theme="dark"] .alb-input textarea::placeholder { color: #79808a; }',
'  html[data-theme="dark"] .alb-ib { color: #c3c8cf; }',
'  html[data-theme="dark"] .alb-ib:hover { background: #232a33; }',
'  html[data-theme="dark"] .alb-legal { color: #7c828b; }',
'  html[data-theme="dark"] .alb-previews img { border-color: #2a3038; }',
'  html[data-theme="dark"] .alb-typing i { background: #6c737c; }',
'  html[data-theme="dark"] .alb-launch .hint {',
'    background: #1a1f26; color: #e8eaed; }'
  ].join('\n');

  var WIDGET_HTML = [
'<button class="alb-launch" id="albLaunch" aria-haspopup="dialog"',
'        aria-label="Service-Chat \u00f6ffnen">',
'  <span class="alb-badge">',
'    <img src="assets/img/service-team.png" alt="Service-Team 24/7">',
'    <span class="dot" title="Online"></span>',
'  </span>',
'  <span class="hint"><b>Schaden am Auto?</b>',
'    <span>Unser Service-Team ist erreichbar</span></span>',
'</button>',
'',
'<div class="alb-panel" id="albPanel" role="dialog"',
'     aria-label="Service-Chat der Autolackiererei Britz">',
'  <button class="alb-close" id="albClose" aria-label="Chat schlie\u00dfen">\u00d7</button>',
'  <div class="alb-head" id="albHead">',
'    <span class="alb-avatar" data-avatar>',
'      <span class="ring"></span><span class="ring2"></span>',
'      <img alt="">',
'    </span>',
'    <div class="t">',
'      <b id="albName">Service-Team</b>',
'      <span id="albRole">Autolackiererei Britz \u00b7 24/7 erreichbar</span>',
'    </div>',
'    <span class="alb-pill" id="albStatus"><i></i>Online</span>',
'  </div>',
'',
'  <div class="alb-hero" id="albHero">',
'    <span class="alb-badge">',
'      <img src="assets/img/service-team.png" alt="Service-Team 24/7">',
'      <span class="dot" title="Online"></span>',
'    </span>',
'    <h2>Wir sind f\u00fcr Sie da</h2>',
'    <p>Am schnellsten geht es mit einem Foto vom Schaden.</p>',
'  </div>',
'',
'  <div class="alb-cards" id="albCards">',
'    <button class="alb-card" data-q="Ich m\u00f6chte einen Schaden per Foto einsch\u00e4tzen lassen." data-photo="1">',
'      <svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
'      Schaden per Foto pr\u00fcfen',
'      <em>Foto hochladen, Sofort-Einsch\u00e4tzung</em>',
'    </button>',
'    <button class="alb-card" data-q="Ich hatte einen Unfall. Wie l\u00e4uft Reparatur und Kasko-Abwicklung ab?">',
'      <svg viewBox="0 0 24 24"><path d="M12 3l8 3v6c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
'      Unfall &amp; Kasko',
'      <em>Wir \u00fcbernehmen die Abwicklung</em>',
'    </button>',
'    <button class="alb-card" data-q="Ich m\u00f6chte einen Termin zur kostenlosen Begutachtung vereinbaren.">',
'      <svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
'      Termin vereinbaren',
'      <em>Kostenfreie Begutachtung</em>',
'    </button>',
'    <button class="alb-card" data-q="Wie werden bei Ihnen die Reparaturkosten kalkuliert?">',
'      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M15 9.5a3.5 3.5 0 100 5M8.5 11h4M8.5 13.5h4"/></svg>',
'      Kosten verstehen',
'      <em>Transparent kalkuliert</em>',
'    </button>',
'  </div>',
'',
'  <div class="alb-log" id="albLog"></div>',
'',
'  <div class="alb-previews" id="albPreviews"></div>',
'',
'  <div class="alb-inputwrap">',
'    <div class="alb-input">',
'      <input type="file" id="albFile" accept="image/*" multiple hidden>',
'      <button class="alb-ib" id="albAttach" title="Schadensfoto hochladen"',
'              aria-label="Foto hochladen">',
'        <svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
'      </button>',
'      <textarea id="albText" rows="1"',
'        placeholder="Schaden beschreiben\u2026"></textarea>',
'      <button class="alb-ib alb-sendb" id="albSend" aria-label="Senden">',
'        <svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
'      </button>',
'    </div>',
'  </div>',
'  <div class="alb-legal">Alex ist unser digitaler Service-Assistent \u00b7',
'    Einsch\u00e4tzungen unverbindlich, exakte Preise nach Begutachtung</div>',
'</div>'
  ].join('\n');

  function injectFonts() {
    if (!document.querySelector('link[href="' + FONT_HREF + '"]')) {
      var pre = document.createElement('link');
      pre.rel = 'preconnect'; pre.href = FONT_PRECONNECT;
      document.head.appendChild(pre);
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = FONT_HREF;
      document.head.appendChild(l);
    }
  }

  function initWidget() {

    var CONFIG = {
      apiUrl: "/api/chat",
      avatarUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFhUSFBQXGiEcFxgfGRQUHScdHyIjJSUlFhwpLCgkKyEkJST/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT/wAARCAFoAWgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDvr+xVYelcdfxhLgivSNSt/wBx07V5zrIKXhrPEOyuFBXZWAHrQyZpgb8KXzMVxqZ1cg1o81Wliq0ZwBULMGq1IlxKEyACq6lc9RTtVn8lCc1yj+IFjudm+tkrmTOqZM9Kgkipmn3guFHOc1cdOKBmVLEcGq3lnPStSWPtVYR/N0piGwxe1XIYqbFFV6GHpQKw6GM+lXI4zRFHirkUWe1ADY4qtohApUjAHOBS213bXCuYZ45BGdrbWBwadwsOEdSrH3qSPYwyOfXFYfibxVBo9vttJIJbpuFVnG1Pdv8ACjmSBRbN5AAcEjmpsAdeK8hm8bajaTCaPXJ7lmxmLyFMbe3QED3rWT4ryNHtewCvjGfM4PvjFR7RFeyb2PSsDHUU4R5ryceMvEdzO1xDLFGi9I1jBjI7dTmnp8TNet5Ss0NtjOMeWRu+hzSVaI/YSR6wsR9KUxcdK4TT/igH2mWOOVVIEsSArMnuAeGH4g12+naxZapbpc2syyRt36Y9jnoa0U0yHFomWI+lSbKr/wBrWIlKCcbhxjBzV2J1mQOhBU9COlO5JD5XNOEdTiOnbKBlby6PLqzs9qUx0xFYx03y6tFKQp7UgK2zFNKjPWq+oXZiyAayvtss2cMaANw7B1ZaiZ4lGS4rEZpj/EfzqMrKe5NAG21zCvVxUZ1C3XjcKxjBKexrC1u5ntHGA2M+lFgTO7iljmGVNP8ALFct4X1F7khTnj1rsPLOM0XHYqtHTDHVwpTGjoApGOirRj9qKBHeanB+4rzXXrdRedK9a1CHMBrzPxLHtuxSxS9weH+I582+R1qN7dvrVssPWmlhXmo7jJuEdPWokLE1o3QBWq8aAsOO9aw3InsYeuxu8JwK87m0yWS/Dc4zXrOsWymDPtXJx20TXPOOtdkWc0i1ols0Uak5rcMeQDUNtGqIMVfEeUBFS2CM6VKg8vJrQmiPPFRCH2oGMgi5q/DFTIYauxxgUCsOSMDGc1Rk8T6bbTeU06+ZnG3I4+tcf4x8USm7FlaSTCJQRIVbCk9h7iuYbclvHKknGMEHpn/GpcrGkYX3Ow1TxZNqDyAXq29svWFUOX65y3p/OshPFL6bIr24jXBwMDqPQj25rkJdQKzNyWVuMH1pzXHmAFhlj8oHTNS03uaKy2OovfEF/euGW6mVHHKqSg/ED/PSoFV5wxdXQEHdnnn19qybbUI1/dsfLcnjaep962bG4WQp8znd1Ynr9fSspXRpGzMu8ZkU/ul3j+IHnj0qlDmGQP5xROpwQR+NdNqGnRSW8kuFyPlJJ5Hqa4vU22yMVYrngHGPpnFVB82gprl1OustXhkC2/mZBAH4+o/+vV57Gyki2I4BbJUF+h9q82trqWOeMxZkLEDap7muna/eBlDffTDFfT1FKdG2xUKqe5JqNubOR5BKQ2c7iOTz/KrOleJ7zT2eW3Zwk6FHWM5Vs9/apmYXkQjZA3XG76Vy99utFdBgDGSCMYHp706epNRWOtt/EMksh+3sboBdyxu7BGGO2DktXV2/iZ/DthBqemanaxpKMyaRcOzM3uvUoT9cV41pmtJHJ5V2u6HdwVOCmeuDW4tvPY+XfQTC5hY/OBkNjsfy/wAitH7u5klzbH0P4S8eaX4rQJF5ltdhctbzLtbjrt/vfhXUBM181/26vibULeLS44tPnRw0cslwQ3mY5JJOADjp+telaJ4n8X6PZreXtjBqmmq/lz+SSJrZgcHI5yPfpVRn0ZDp9Uel+Xijy89qqeH/ABBp/iWzNzYShwp2yIeGjb0YVqeXWtzMr+XntSGM81ZCChowAaBHI6pCZJGXOKn0jRkMZLnNPvos3DYrW0iEmE00Syo+lQL2qP7FAp+7WzJbE1We2Gc0wKi2sWPuiuW8WW0aqSEFdqsOOK5bxdF+7agDC8HqDcsK9AEfy9K4jwXHmdzjvXoAj+UVCLKhjphjNXDFSGI+lMRRMdFWXjooA9EvVzCa8m8bz/Z7pTmvXbtf3Jrxj4mHZMnbrRil+7DD/GYltdiaTA5q+8YC5xXO6XcIkuWNbc+pQ+QRkdK8CdWSlY9ZQTRSu7gJxnpTbaZGYHNYOo358wgNxVBtc8gferuw8nJnNWSijsNXkRrfAYVx8cR+1fU1R1HxTuT7/wCtZtr4iQzAlxXelY420z0O1hYKOK0FXC9K5K08UR7QN4rRj8TRMANwqWmUjXkSohHz0qO3v0uemOauqmaQxIlC43cCqeq30JtZ4o5SJAMEjtkVFrutppxFvFuacpuwhHyjtkngVz7an59pLFiKOMDGF5JY8nJ7mpbLjG5y2tr9nYzhwWbJyeR+Ht2rJXUhNEIWX+IsD6HFaGvLuyFOeMAHt3rl4pPs8mc5RmwQfrzRHVFSdmXMBJsqMspy4z1FXJLCV7YSREMh5K9cc1UmJGoMFOA3TPQ+lalndxQ/urkGIOCCvYn+lDv0BWMxoowQs5KSDo2Qc/WrVpfTWMhhlkUrncGXkEfWpL+2UuVIDZHBP8/pWLP9pttwh+VT1A6UJcyBuzOxt9W86yZHxu5yM9fQ/pXLak8J3Y71Qt9Slhl+cYU9SCeKS4kDk5OD64ojT5WEql0a/hC0XfPcSL80cTlGP8HbP161QkvmmvJlAKrJIEVep9M1LpN8bW3njDY3wkdfessOY7t5wclG+X61aV22yG7JWO1nvliu44EYfc+Y59uTXOXl3LPcPs2kFicHkVUF5JJM8pck7SKiMqyEMxKtnOe2aUYWHKdxLuEw7WQ8kbs9l/GtbRdXaKQ20o3IRwBxg+oqvbkSL87DA7tk49/SmvGkcvmQYeQt8q5GfqaqWqsyVpqWb5I7OYXEBUkn8ieldT4O+I2r6GwNjePGrttmhk+dGPoQexHQ+1casjTCFHUtlsMRzxnoP89qtxWQsongfIZ5iqORyMDj9ahrQtPU9w0HxVp2qajDd6dFHpXiFQRLApxBqKjkofR/T+tevWU0d7aRXMeQsqhgDwR7GvlXRNmoxi0vZY7S6OPIum48tx93LDoCe/avoT4U63PrfhRFvgV1Cyle2ulYYO9T1P1HNFN9GTUilqjq9nNDJkGrHl0eXweK2MTlbyP9+31rX0hMQ4qrNatLcsAD1rc07TJVh6U0SyF1zUDJ7VqPZsvVTVd4MGqAo7Oa5Pxeh8tq7UwnPQ1yfi6I+W1IDF8ERYmf6134j4FcV4LjxI/1rvRH8oqEWVWjpnl4FXGjxUbJTEUpE4oqZ04NFAHfXSjyD9K8W+KSfvUx617XdD9wa8Z+KIwU/wB6qrr3BUviPJbjUHtCcGqH/CRySMV3H86sahF5pYVzVzE9tNkg4zXkqmm9T0ed2Okjme7HPJqpe6bI/TNJpV0OMiugiKyDoK1oLlZlWd0cBqOlyqCBnNY8Wk3TSfeYV6XeWscr4wM0WOhiRslOK71I42jiU0+8gj3bmIAqi2rXdtOobOM+teo3mlQx27Dbg15/rlrGk/Cjg00wOy8K3j3KoSTzXexIMDOTx0FeeeCRlU5r0yHasRY9hk1lPQ0gjg9fCnWrh3XA7bewx0rjdQupd7or5JJ9hXX+JLeY3ROMRoMhmOOvb8vzrjL/AOVdvJOSee3vWS1OjYqahIZUQ8bimTnvjIrJ8rzeGGCzEBvcev51pttliYN1XLBv8aq+Yq4BABVw209x7VoiWTyxYUZTzcAr749j6/zqZpLTV7FozJm4QcgjDAjofpUE0gi3pGSVPzKT6f4VmTHEolAeKUdGAoSFexJmazPl3JLoPusDzUitCRuNyXUjoTjH41C11O4/fLGw9SMZ/OotzScRW8P1607AmSzTW2CVhiwe4Y5rPctITtTAHvmtGPSZ5+T0x93Falp4ckK5WNm4BFHMkHK5HP20TEEDJGDn3qVbF8tlcsecV11r4X8pQSN7Zzhatnw1I+cgnPzDH8PNZyrI1jh29zgWs5rct8p5GOKrCCRWIwcHv0xXocmisvytESQdpPcVRutBXa3mKFx2VeKI10EsM+hykO4IAoLLnhQBk/WrtpZ26SNNcMdvVgP4j0xUV5BNbz+XF8vXBK1Lb5nwr8lc8+v+Fat6XMLWdmR3Rklu45ogRESVGeMVryGO7i81gSUO4nvwOfxqvDGIV8hhwW2uT684NPjb7OkzjPD8j1z0/wA+9Q9SkrDoVa48hs/I+YyPTPKmvbv2e5J5JdZimb5gIi6k87hld35YrxPS9pKRhgAjE+2DyDXrPwe1YWHi2KOfKG8iaDI6FuCPzxUJ2kOSvE97CUpUYNSqmac0fHSuk5inpViJ7h2IH3q6+0sFWLG2uf0NcTP/AL1dfBygq0IzbjTlKnA5rDubLa/SuulHFZF1EDJTEYDWuO1ch4whxExxXo0ltlc1xHjKAiJuDUjOc8GR/vG+td2E4rjfB6Yd/rXcAcCs4lFdkqJkq6UzUTx4qhFGRODRU7J1ooA7K5/1BrxX4rttCn/ar2e5b9wa8R+Lsu2MH0ataivEzi9Ty9ZFknKtjrS6jp1s8QYkZrCe+Iujya3tFtm1eULn5RXE8PfVHUq9lqYqxrA+AcCtCK88teDW3rHhkQ25dB0FcBdambWRoy3INONFxeopVlJHRW96ZrsA13eh2QkjBxXj2n6yFuwzGvR9C8VxRxjLit7GTNbxFZmKM4XtXk3iRCk2enNej674pimhOGHSvL/EOpx3M3y460LcR1/gnlUr0PWJDa6FPOF3AKM4+8BnqPevOvA7fc5r1iONJrURyIGRlww9aynuawPMtVvrye0j3xCWI52PH6Y7iuLu5hllxhSfugcn8a7TxfoN9ovyWcrPZsWZUJ/1Y6kCvPpFnM21uCeST2rOKNmxZF/dmU8f3QTkn6VDHG12dvlMGHfFdZoejLqFvJMwVo4eCx7sewrc0PwrFDIj3SeUs5OJWHyr6A0pVFE2hRcjz+PR7lhgxuR2IBzUMmj3QYKqOrMe5Ir3d/DtpYIGmkAXjgAfN7D/AOtVeDwtHqj/AGiSFYo+ka9Mj/Pes1WZs8MjxCDw7PJLtaNmPq3Q102leC2PLIOecH0r1iPwRbsoLICfp/nita08NpAB8gJHtRKq2VHDRR57p3gooV3RqB13EZroYPCcG0ApkjGDjFdmmmKpzt/+tT3tQoPGK55TkdMKcVscmfDlumCEUkcZxVR9HUPu4/wrqpoxt5zkVnTLyeRWLkzdRVjnm0dWJBXqeKztQ0SNY2OOT29a63yhgBlP19az9UhB2heCaakQ4o8n8SaQxQyImCmfpWbBZQmKN0ON44z2OOVPv2r0HW7ANC/yc4/CvO9cV9OzLF91m3kf3T0r0KT5lY8qvHlkROGulCqQHUAc98cY/WltQXsJN+CS2wn3A/8ArVTguBO4ZQMkEMPXPFSQ3Ui28anO5yVJ9+x+tatHPe5PYQ4lZWyuEKt7E/0rsfDwmj1CwljbMkM8S+4bcK5eIGQ7wAN8Qbn1z/8AWNeieA7GGfxlZRSYMU9wh2kcHC5FZz3Ra2PpWIbowSMNjke9O2cVJGnyjpUgjyK6kchT02ZYJ2Dcc11VrdI0eciuUmtyj7gKkiv5YlKhWqkxHTzXaKOorIudSiWQ8isi5vrlx8qmsmRb2V84NFwOpfU4ynBrh/F188qlETdmtiC1uiOeKSfQ2uTlwDSbHY5vwlbOpZmUjJzXZhOKjstKW1XCgCrZTFJICHbTHWpytRuKAKrp1oqUrRQBu3R/cHmvFvirA90ojjBJLV7Pct+4NeceILWO61BFfkbhW0tjJbnk2m/Die4IlkBJPNbmj+HG0eYq6ACvZNM0WEW64QHiub8U6LNuZreOo1SKsup514mu1js5EXhsda8H1VZZb+UsTjdXs3imyurVHMynGK8i1adEvWHHJo5rgopGc9vIgDLnPtU9nNqGRtdgK1bWNJohwK27DS4iBkUXGYv+myx/vCxGKwr6KVZgWz1r1JNNt/LIOM1yuvWMKP8AKBUp6jN3wMx2RmvWLSX90v0rybwSCNo7Zr1G2bEQx6VjPc1iJr+jrr1m0KsY5guEccD8favCtds4oLiRIpgwSQoDj75B5r2671b7DiQ9FO7HrivJdb8NSTarI4wbczNLH/wLnH8/yoSKudR8OdNlutE8iKOR557gs3Hyqm0f4/pXq2naHsi+z3KIwAAwVyCPpWh4Fs7fTfB9jAiKDs3ZA9auOxEpYck+lclZLc9PDSdrGNJ4E0uWUSiFkYfdAYgD8K049BjhAGXbb0zWhHKzDkHinBmY4JWpVjRtkC2hVccD0pxh25zx64qdskgfLxTJASVy2M+lNiTKzxZUnH51TuMLkY6+oq65OzGT+dULjacjGT9axkbwMy4lxkAEc9qoyDe2RmrcyfNkCojGFXO7pWJqQsp2ZrOnTz3OR0FakuApxis5iPpQDMfWo1+yspBOAfwryfxOpXKMuY2Yqf8AZPvXrGrsxRtpJ96818SMgEsTgFjyD6/54rtw55uKRx0FnJbA3CZKDr7VcWNpOSANoLEe4PUVZ0qATW1xDI2EkXcpJ6Y7fWkkTypGIThSVKntmuxu559rGksDfuIs8lsZA/EV6b8L7dLnxNps+N3lz7XXPIZVPIH0rzOKQyTqWYgFlZPbgflXffDnUU07xTpjxuwNxc7Gz2JPGPzNZNaotPRn08o49aeKappwrqOYUqG60hiT0FOHNLQBXkjUDoKgCDPSrcgqFRzQA6NMVKExTGkES5OKz59chhfazgUAzRZajZaqW2rRXHRgaszSKsZbNAEbYB61GSD3Fc5rfiSLTeXcD6msmy8cW11NsWVSc+tPlZPMr2O1Ioqnb6gk0W7IoqUWb1w2YDXB6kN2pj613U/MBrhtRH/ExH1rpktDnR3ejRg2y/Sp7rTkmByoP4VHojZt1+laZ6GosWePfErRIhYzNtAwua+TteGL18dmNfZPxNXdpk4/2TXx7rKBrmX13H+dS9AiS6LcBlCntXVWszLHn0rkfDsW+bmvQLPTke3zkdKCjNiv5HYjmsLXbl93PrXZRaZGoJyOK5vxFaIpyMVLtcFsaPgt/u/WvUbdv3K89q8s8HAAj616dbHMK/SsZ7msNjD8SP8Au25rnluften2OMDyZZI5GPoMEfzra8UE7DXDDUXt7W7hUDKssq5+uD/SkUlqfS+iOq6HY7OR5Sj9KsAFjx3rH8HXgv8Awnpcyg/PApz61vJGCnvXHUWp6tF2iPiQFeRTgV6BhzxTRGSMY4qHaYWOMD9KhSsatXJ8hT3JqOVsjOCPTinQyblBY55NOlXd2qt0StHqUnk2/Jg9OlUp1O4tgDr3q/LFyc8iqFyRk8gVjJNnRBozZg2MZxzVd8kHBxirrkNHkuBmq37oj7w+pNZuLL5kVHDbTnp2FUnXqK0iysMKRj+dZ10uM4pITKV3aC4UjJ57+1efeKtHMQZtpfb09RXoxmyu0Y6c1TvNOS8jbIyT7dK6IS5TmqQ50eGW03kXgt5G+XdwSMVp3G0qzfMS0YyccAjg/wAqu+O/DT20wmhUhuvFZ2kyNcLGzjJeMoecfMDjP8q7001dHlSg4uzH26iSB5ACdhPGemRkEfhmuz+HdmVitdSvnINoP3CbsAMDwxNcpZWtw87RRx7gw24I6Ybj+ddrYcxmyKYRQM46VjWbtZM68JTTfNJHq/gv4qw3etJpF7ffaTKdquR9xu3Pcdq9V7V8jxxtY6sGAKNE6kMPTNfUWial/aOg2d4Wy0kQ3H3HB/lV4ebfusjMKEYWnHqaL3KR9ajbUoR/EPzrivFviddJid2OMV5vf/FkRElSTXTzHAot7I96bUoW43D86I50c8NxXgem/FgTygMxGfWu/wDD/jGO9CndU86DlZ22qT7IDtPQV4j431/VIL8ra5xz3r1a41IXMZGeK4vW9JjmZpXUc0Kso9BOk5aGT4I8U3s21bo4OfWvSpNX32nDc4rycRJpz74+BXQaRrX2k7C3tzUKpzPQpw5VqZnjO2uNU+VZHAz2Ncnpui3On32/fJgnua9YltEkQuVBrCvreL5iAARXVGo7WOZ01fmNDTNYaG1Cu3Qd6K4fVtaayiZQcYorJpmqsz6JlOYDXn3iK9FjdmQ+tegOMwGvK/iMjmIlDg5rqkjnR3nh3xAkluvzdq1pNfiGRuGa8j8J3F75QXfx0rqUsridt4lIxWVzdQZk/EjXlFjKC3UV8s6mrvcyMAcFiR+dfSnjfQ5LyycMc8V4jJohM7oVzhiOalyuU42OW024azkyeK6a38R7Ytoaq99oHHTFVbTQpA/ei5NjXj1+RkIz1rB1zV3c4J7+tbsWguE3c9K53XdLZGPXrSumx20Oo8EMXVT1ya9StxiFfpXl3gNSoRTXq6rtgU+1Yz3NIbHLeKP9WfavN55VS7O4fKeCPUV6teaRPrd8llBgM5JLt0RQMlj7AA1z2v2OmeD/AA1DKsMVxq2rOTG8i7vKt1PLAdi1K2lyk9T1P4QIJPBFrGZN32ZniB9s5H6GutlmRTtyABXkvgTxhLZeCbgzBUlnuiIyuFAUKB+HSquq/EqewIDEHrgBuv41jUjrodlGa5bs9iW5UggEGmNcK4KkdK8Kb4z3CSgDyWXuM9q6rQviPBqxAb5SfU4rJxa3OmFSMtj0q3uIwpGTlSetKb1ApwckHH0rnbLUEuS+18g88dqbJfGHzFY4JGQaz5jZwW5p3d8qqS0gAxnBPWub1fxTpthkS3CA46CuL8Ua5feZIkUjYYY9cVwVxZX+ouS9yE5ye9aRjfcxnUa0R6NffES2UtFDLHgevWsp/HEjqymREBHXpXOaV4Ht7x0M2sRjHYMBXTP4F8PWqKXvTIw67pc81TjAyUqjIrLxvJGzJuMq57EcVrWvi+CeQRyDy8/jWJP4e01fmtxEQOBgiom0oQkMg4HoeKzlCL1NYzmtztYgk+ZIyOeciposL37Vg6TNKML6DkYrfT5xkdaxasdEXc5vxpbI9puC52nt1rzlV8iEOq4Jckn+v8q9T8RRmW3ZAMnFeX3MMkdwYnYrGHyR6ZHJrpoS0scWKhZ3Op063is7ZJJSA0i7skcgYyan0vVNNuQ89vJNvY8hxjb7VPf6ZLc6JHPbYeRYBuHqMc4/I1zPky2SmZRsRj8y+hqPiOmlFxR1GoJ5ktrd4+WQiF/qDkH8q+hvDtuLTwnp0XfyAx+p5/rXzpZt9p0q2Dt8zXCY5+te9HxHaW9lDEsi4RFTr6DFb4daswzCWkYnK+NNJl1WTyhnaxrhtY+H3kwlgD0zXr9tNBfyK25TS+IbO2FoSSvSqlTk7sxp4mMLKx8z3WmPp8+MYwa7TwleMpUbqxfHE8UFydhBy3apfCt2PlJzWfK+ptUnCSuj2PSJjKgyc1Z1OANByB0rA0PUUAAzWzf36/Z+O9NP3dThabZxGtKI1b2qn4cucXgBPerfiGTMTNXM6Jdlb4YJ61dFXIqnsHm5s85HSuYupss4rSSfdYA5PSufmky7V2I5mcT4ylC7gD1oqh42l2uaKoSdj6K/4TCFoOJV/OvPPGniWK7/AHSsCSa8XtfGWstOq/aztPbFblneT3s8bSuWJrSUlsjKMH1PU/CWrLHGFPX3rtNN11XnaMrx61534dsyxBHWuiMn9nEs/GRUOOh1RkjW8U3sbWcm0jOK8cVo/tUm/Gdxre8ReKS6siPXBSai7XLH1NYtFSsauqzxKOorJt71DJ1FVL1prhuN3NUY7C5SUHml0IO6trqLyD0ziuQ8R3CbyPeta3Eggwc1yniLfvOTWNKbcrMGdT4IwXU+9ep7gIF+leTeBJeEzXqLS/uF7nHSrnuXHYv2loy6VPMG2SajJ9hjbusQ+aZvywv414z4815Nd8S3MkX/AB722LaAdgi8V6z8UtXXwvokdpE/762tltl9pGG+Q/XJA/CvCLXT7m9I2oV3dyOtWlr6aEJ6ep6J8O4Y9b0u4s7nDLbSJIB/sHj+ddHf6P4V0sMl3bxyMM5QgsT+Fc38Jg2keK59Outx+12TMmOuVOa6fxD8PJdZ1W61Ga5ZIHC4ijON5H9729hXNW0lY78NrC5y2o3Xg/5zb2ljE68ENjI/AA1lLPbzkG2it0Xs0ZZfyJrSvvhbbXF20hme1jDbwhgYkP6cHBGfyrXXSLfTdPSwlkcqSWbIAYkn0H8qTUe5tHncrWNr4dXs0k7WlxE7IRlJjyMjtmuw8QacIYjKDggZ61i+ErS2sZB5CTtvwd0hyBj0Haug11jcWzbjgdPrXNNpHXBNs8Y8SXjPcSRxdV71gtpc5tPNmZ2VjhY+RuPpmug1OAfb5UI4bvWhZG6cLFuATaAGxnBq4PQyqRdzlLfTdeWweWxnlgaNwBFBGc7Oc4OOcHFR2tj4uvZmF3Pcsu4YLx4UL35Yfyr0WKO7t12iMTZ54fYwp7NKiBm0y6lfH/LRt/fqOa29okYujd3ueeTaFrpmKxyqsWcBygFbWk6VqcGNly08Z4w5rqFsL/U2xcQyxRZ4VFGf1Na1tpUViABuA6YkXH8uKxnO5vTpJGdaadIUH2hZAPSPAX/Gryp5SgRjYvcetXPLZBjP/wBeq8w8ts8j1zXK3qdKjZGXfrvynHTnNcJqOjGXUJ92RDtyz55/Cu41CZd2e544rntSuVDrGwyCCSPWtqba2MKyTWpvW8gtba2RVUQlQrf7u3muKbTb7VgUtyHtUc5lJxhR0/SugncXmlwQrN5LTRFA/UDtWnoVnDp9s1kjAxMhy/qam/Kaw1Rz80kUFuIrdSY7RC5c93xxXLt4p1qCZVNw7jrzXa6vY/YQbWNdyudxI7isGbTQzbjFj8K9DDK0b9zysfNSqcq6HV+EPHLoq+e7ZHXNbXiPx/HLalY5MnFeeQRxxcYwafNbmZcbT+Vdl4nmWkupgapqT6rqI3KxUGuj0yNraIMoNU7fSmSYMY/0rfXCQYCjOK5qyvsdFOVtzb0K7YkbiRXRXF0PKAzXFWF8ITg8Vfl1pcYBrJ0y1MXxDMDbsBnpXJ6IXN8pYEDNa+pX4uEIBrOsHaGbcw71pSjy7kVHc9KhkjaxVQx6VkThU3Ecmssa+I4wgNV5daDgj1re5jY5Hxr5kr/KpNFW9Xja7J4zmiq5g5Tzm0lxdISa7LRpd08eTXBJJtnU+9ddpcpVVYdaoVj13RNYhtcAkCk8QeI45h5aMM4rz6O7ud3G7mgC7kl3MGOfWqEnYTUrg7yxNY4u4zN1rV1DTrmeM7UOa5mTTbqCUk5rOSLUrnQW15Ev3sU2a/jSTPGKwJxcxpkA8VnPPdPwTUWuO5151lFQ88Vyut6ks0nGOtRhZyhJzWVcxyeZlgamFJXuFzsfCmoeQVINeoeEdRXWfEemWLt+7MweT2RBvb9FNeN6DBcsUjhRneRgqKoyWJ7Cve/B3hWLwlpd5qF+BJqr2pRcHi3EhCYHvgnJpSlFSVy4xlJNo89+LuutqutIgbdljM3Pdju/wrh4fGF1AZoFKgM2QwHIrT8WXSXet3kyH5RvIwe2cD+VcFK585m960hsTJHo/wANddYePtKlkkJ8x3hJJ/vKR/hX0opWeNY0w3GTu6D618ceHdR/s7W9Pvf+fe4jkP0DDP6Zr6+0u8WaJSAME8+9cmL+JM9HAK6aKNz4fmmYquoTRxnsg/xqOw8H2ME3mBGll/56Stk10wt/M2sDnPX0p2zy0PAJxgYrmR3sz4LSO3mxGoGFPIrK8TTSJanJYHH51uRqGaRz6gfiaw/EPmzF44hkYHbpUTNaSOEn08XA80L8y1b01VhwrhSKeCY5TG/B75poRPMypz7VKY7dzo7e0UpviIIwOD2+lXIYQTlwR+NVNGlbCrt49+1b2zdtAUYPX3rRMhxVyOO2QKTsGRyD3qrdTIvy54PXNW5TsBHOfSs26dSSDnH0qJalxikV3ZQgx25xWTezkZyflzV+fjJGPzrIu2bJOOOvXNRYGzPuvmcsCc4/KsSZfM3HeA8eTn1BI6VtShlyx64zk9DWJNEzrNGcAEEjvlif8MVrE5ajNLTUjuLa2hcAHy96/ia2AsVrGTJgBVxjPQ1zBjdbJLpZGSS2iY/KOGxkkY+tcvpvjqTWXkSRNpAygB61cKDm730FLFRpQ13PSF1KCZgWj3npk1FqNzD5XywgZrirbxNEDy4GPU1cbxRbTIFMq5z616HJy6I8WU+ZtsUWs93dHylOM16NoPhGSa0UtHzj0rmvAs0F9ekFgVz3r3bQ7e3W2XG3pSYkeb3Pg+RAcIPyrEuvDVwrEYNe33MFuQeFrDurS3Ln7tNRG2eTJ4WuXP3TVhPB9w/8Jr0+G1ts/wANXobW2GPu07CPJf8AhCrj+7+lNfwXcg8LXsRtrbH8NQyW9v7UgPH38HXA6rUD+Epx0U169Ja2/tVZ7e39qoR5FJ4TuuwNFeqvb2/+zRQI+MB/rV+tdroi7ggNcTuxIp967TQGyENask9A0bSo52UstdQnhqFgMIKzvDkOdhFdvBAMD6VtFaGTepz0/hmMQ8KM1xWvaRFATkAGvXbiFRBnPNeTeN7o28jE8j2qKq0KpvU5W9tYhGelc7KYo3xgVoXOqLKuA3Wsi4SQyAhc5rnRsdR4Q8Kz+MNS+w2zrCiJ5k0xXIjTOM47kngCvSIvgB4flZTcXmpTY5OGVAfyFSfAfRJLLw9fatPHg3kwSPI6pHn/ANmJ/KvQWkvLq4Ai+WAqcuOx9K4a9WXNZM9PC4eLhzSWpnaJ8PvDPhtEfT9Nt4pU6TOd8mfXcas6rYRzWrrGvUc4qLVk1NObSUAL/CyAg1if2vrFhEBLZGfBJLI2Ccn3rkck3qd0KfKtDzLxv4OiZ5ZYFWG4fgHHEnsR2PvXi9xayxzSKykFGIYHsa+or27stUmjkceRKpIeKYbdwPXBPeuG8d+GdGDNPbtG0jd1/i9iP612Yas4+7LU5cXhlJc8FZnicIYNwDj1FfU/ww1r+1fDOn3MjbpRGEkz13L8p/kDXzI8ggmeONjsViAfXmvYPgjrRa2vNPZ/9U4mUezcH9RXRio3jfscmBnapZ9T3yO5UIO1Vbq/SNfvYA61R+0gQ9cHHrWJcXEmoahHaqWALZOPSvP5j2VT1OstJElt4dy8yMWyPQcCsjU5dpkweW4rUtdQshvDNtMS7cL2rnvFetWdtD5q5AxjHc05K6HTdmzmdajdpC0YwT3rOmtbmCIyhj68GorjxTBuDTYjHp6/hVW48X2sv7lVk54HykVChLoNzidH4a8R+bEFkxuHymuxg1KN4wflz615noNuYWZySDIxYj0z2rqbWVxyuWA7VbJXmdM12H78+orOuZ93U9O1VhfJICQckdfaqF3dkZ5IzUsq5JPdjO0EnHWqEs3XLc9arzSMHGMlj2qK5kRMc/e6/SlYzlIiublvNCZJBB6elUblHCuFYYPyg96e8hjuI2YB0x949ajuijxHzNxJycg9KtbnPJ6CTXAbTZ41bIEbjj6GvFtLnMFwrA4wetevxSefZ3GzGDvXPrxXjEHyykehrsw3U4cX9lnZ3MENztkhAV5F3Y7N6/jWWLZ45iTnipUnkk09dn3omzn2NW7SeK4+R3Xz/wD0Kum7OKxu+EtafTJh8xHOa9q0Hx5CtqN8oHHrXz1FMsc20cYrRi1MQ8bz+dZyVykz326+ItuAcTA/jWJdfEWHJ/ej868ffUVkHDH86oXF4ueWP504oTPZo/iPCG5mA/GrafE22BGZ1/Ovn6W7BYncfzqL7T/tH86uwj6K/wCFn2v/AD8L+dRv8T7U/wDLwv5189faPf8AWj7QD3/WlYD3yX4nW3adfzqs3xLtz/y2X868L87Pf9aPNp2A9vb4kQnpKPzorxATYPX9aKBGdHavIyn3rsNFHkhDnpWPbQkKPlrTgZk7VbYrHo2l68luEy2K6KHxnEoA3j868d+0Tjo5pVu7kHiQ1Sq2JdM9ku/GUbQkBxXmvi3XFu9w3ZFZsUtzKMbziqt7p8smSxNKVS44wtqYLXCh60LW5WTaq/NIThR6ntUT6SSSD9K9U+F/wdna7t9b1+EwwIwlt7U8PIQchnH8K+3U+wrGc1FXZtTg5OyPX/DWijT9A0/TQCiW8KoQOrHHJ/MmtK7vLbT0CkjI6AUt1eJZxYwWkPQAc1z08NzeSOzwNyeAWxivLlPXzPZpw012LzeIbXjcgO4EjPpUyTWd2vA6+1cl4h03UXW3nsrqOze2JODH5gcEcgjI4rnovH9zpbiPVUhjQsVWZGyrY/UfjUxXM7FztFX2O013w5bX0bbUUkj04ryjxJ4JeCfzoZnjYA7Iicxk4/SvRLHxlp+oTpbw3KmV1MmM8YH/AOuna7DHd2pPA4xmnZxfNEek1yyPlG8sp7W5kgnjZJo2IdT2NdV8Nb+XStcz0WVDGT+orc8W+Hmll/tAQ/KvyO/94A4z/wDXrKsIIIHVgBlTmvTU/aQseNUg6FWx7pb33m2fm5425zUel6tZ2BaWZg087bUHfFch4S1ltW0+aymYJJEpXBPPtWHPrq28ke/cX4VmJ6D0FefyO7R67r+6mup32v8AitLFDMgDjPJyAT6AH61xepeKnuow0skTJnK8025zf2plZjOWwVTuf/rVjXXhjU9ViitrSNtu7cVPB+prSKVrMzlVm/hMu91OSOZkgBMpOS5OeTSWmpTOy+btzkgkDByPWt+XwPqOFuEgZY0wkhk4z2zVOXSDHJKy+WUB4DEc1pdGNqnU1dM8QHy4lcYbkEj17Zqw/ip7cBXBPOd2axIoILKM/v05GPvAmsbUdTtZJRHbytPJ0CxKSfoe1Ty3ZpKpKKO4i8STStl9qtniQcfgf0rodK1GLVrKSV08uWA7JUxx7H6GvMLDTdUljYtH5ajB2sckfj613/hW1k06wvbqYkiZU6/j/jWc0rFUpu+omoz+TcRFThS2B35NVbycXBG/KqFPT1FUNWvkuLpUXghue4GKfdOwhJkw3Tay9Dx1pKI3LUcJPKgBfuc8n9Kp3t+ERmAJJH3ex7fnUYm82MvuACk4z2NUYCL/AFBEU5SE5c9iapLqZSlfRG/YWxjsI4jwcfN9T1rxi6iEGoToB92Rh+pr3GM4jLegzXiurrt1e6HpK3861wrvJmWNjaKLdu7eQwB6jmqKzsLxXBwQRjmrURxEe3BxWe3E3NdyR5p21nJp16ga4gkgmHV0OR+VOuNJtnlVrfUIZFPY8GuajeRQpTBBHZsV1senwQ2dtfWs7+TMgypUExt357is3oWtTT03wf8A2goWOaMt6ZwalufhvejrGfyqnYjVJIyYL6Ap2JXbiny+MPE+hTiF7yRF6ru+ZCPqaXMDRHJ8OL0ZOw/lVY/D+9JIVT+Vdr4d+LE837vVNPtp06GSM7G/LvXZ2fi/whNEJZLtbYnqsqEY/HFUmTY8Vf4e6ivJU1nXXg+8h4IOa+j4bvw9qSZtL60mzyNjjJrE1zTtPALfKPwp3EeP6H4JmuCPMQnNdI3w1XYD5fX2ru9AitAygAcGuuMVsUHyjpVWFc8Ob4Z5ydmMe1Fe1yQ22w8DpRRYD5t+zog+8KfFGH6HNc7Lq7KSDnIrV0e+8/bUtNFJmn5LDtTGyp+7WkUG0H1qvKgHJqbjLWnKrAZAq7LZS3MiQ28LzSyHaiIMsxPYCsuyu1javUvg3bQ3t/qepMAz2saRRk/wlySce5C4+maicuVXLpx5momz4I+HNhoMMN9fRLc6oVDsXGVtyf4VHcju35cV20cDO+4d/fpUEySSsQCVA/u8U6NJo0/1shA9TXlyqObuz2YUlBWRc+yQpzIQSeuarz3NqCI161Snt5p+Gkk9ueKiNpDaoW4En949abl5FKHdkGtwnyGKHnHGO1eF/EHS5/7Ku3jVi8Y3kHuO9elX+v3WnXxi3h7bdhgewPeoPEWnR3dk06gFWXJHqKIVOWSkh1KalFwZ8zaPql7pN/Fd2czJJEcjkkEdxj0Ir6C8E+OrTX7FUPLrxNE5yYz6/T3rwbWNNGk67c2ij5Ffcmf7p5FXtOle3lWS3uJLS4T7kqHBx6H1+lepUgpq6PJoVnSk4s+g7nTLWe2uIGkj8tcvGT3U9VP0ryK80f7NqMpjmRLTd8pznHsKoP4u8Q7kt7iVWhJ2tLGMNj19KvfbBaNFNKqXCxMGIJzn8e9Y0r0pXZ04hqvC0d0XbpZvC1zaX0MjeTMMSMeDVzUNOt7+9t3tcyC4O4gdvasPxxrr311FEoHlEDCnoAaf4f1n7FPHbzHJjb5HJ7GqqQ+0jCjUt7jO5bwkbLTIlgnlilJJJU+tZsNjqOnTA3Ml5coSAs0JCsozzkdD+nSuy06/j1GwDA9ODWnYNBa8yIskY4I7/nXPGXRnqwjHlORvbWG88qJ9dv7hC+Chi5AP+FVLvw3p6JGLS2ubx1cM/mkgbe9d9Pe6XvLxpGp24IJAzWPfajDM3lRMicfwck/jV3E6Ke7f3nAXfhyS5u3+5ApXaIoeFA+taGkeFrLTiFiiUyHoMdK2LkxRuY+PMHVe9WtPhGPMYZNZyqPYFCCfuiz6dBBp7gLlmH4VlPqMj6G9ncKUlgOcE9R/nj8K1L28xcGEAEgZAPpXM6jemNygU7GUjk5x9PWojdmdRpPQyov3k3nE7nPJBHQf/qqW9vExIq5VVPyhearxL5Llxhoz1PYYz/OsnVtQjggcbiHbGBn9K2UbnM52QahqDqRFbhXlYhVA7H1NbWjaf9jjRSctjLnufesLQbGVH+1Tg+ZLzjGcL6V1VsuPu8Z7VNR20RVGN3dl99oiYDvXjOskPrl4R080167f3It7VmJ7ZJ+leNyyme8mlJ++7N+taYNatkY96JEwb90apn/XVZZsRmq4Uk5rvPMLTuQqYyMccc11nhiZbnR5rWVsFGJXdXHHpznj3ra8PMweZAcAgHrmomrocXZnQWztBiMNlc5x2roA0GqWSqTGrp/fHGK52FcEH0qyJiflT5VrJxuaJmjAbOxiK21vHu7vgVlXd3JcS4DE/wAIGaglvgS+D8iDk+9WdIgLgTyjDNyoPYetUtNWS22VNVgext47iBmE8fMuzoRVW18Sa9kCK6kkTsrtkEfjXVNbIo2tiffwyZ6+1RQ+H9FtcTXQdGByIEk6/X0oUx8pt+D/ABl9n2nVrfyF6eYhyPrivTItXt7mBZLeRJYyOGQ5FeK3i6fLn7OZIW6DncPyNV9Kudb0y5/4l4eTuTEcqR7rVKZDge4Saguw8dqK820v4kxTP9nv4xE/3dw4wfcUU+YXKeP6uIxdEKa0fD2Ny5ovfCssAMkkpZzTdJR7aUIabasCOyLAIPpVG8lAUkGjzHZR9Kp3bMVPNZotlUX+xyK+gPglp/leD/teMSXtw8p91X5V/kfzr54sbR7q/jiTaWkbaAa+tPC+nx6VpFnYxAAW8KoceuMn9c1liJJKx04SPvcxsnZEMNjPp61mahr1tpjj7SPLjY4Eh+6Pr6VJqt3FBblppUVWOP3hHP0rg9e1iERtGLgPGf4GO4fga4G9dD1YQurs6x/EsW8bXQj9Kzp/EdvqklzHB/y7MiMc9SRn+VeG694hfSy6WN3LGSfljR8qPwPSoPA/jebSNWl/tS4d7e+K72xkoy9GwO3ODWvs21cy9pGMrHr13piXLPIVzlcYPeqNldEwT6bKxPlg7C3UrW2Ly2ubFLq2mWSNlGGXofxrkNd1CK11C3ML4kkJz9MVz8rvodF1Y8u+IVgIdYhn6FlaM++Dn+RrCCkpkdq1/iNfvc6lHgfcJbir/gufwpHpjXmuSymdZCi26w79y465JAHpzmvWoJ8iPDxVvaNmJY6bqd8P9Et5pF7tjCj6k8D86s6baTQat/Zty8JjkfdmOQOuQMkAjjnp9an1XxTZEtHbRyyRL8qLLJkADocDj0rnrjW5ppFfaibSNu1cbcHNaOHcyhUcdibxDem41hipwoPAFb95bJJpVtclgromAc8tXHSu0+oFj3P5Vv32oGWOC12gpEAPxp8pN9bnofw+1l/3ds7LllJK9MH0967G/wBLu50ZrW4eJmzkE8c98V414dvVs9USUsUaUfIM9weete3aZ4ntJrdHQmVmAA2DPOK8+vBxlc9fC1FOFmcbcafqWm7jMxcHgerkZqtbWup3TIu9wQRvB4yfr9K9Hv7FNUXMoyoBP3en5Gq0Oi2tpb7VWQsU+ZicEe3/AOqpUtDX2a5tzO0/wuUjEsrMzsRnPXNaX9nizjM0p2xqO/eqy6n9j3pJMzKgDL6EVn674tW8tjbxo4YIWwBjOB2PesleTNZNQRj6jdRXF40guPkGfLKsOCOufQ1y2o6v5N3t3bwTggHr7/WkvNSQWrTMioXJLE5/A+xriri9R2dyOSwwVYmuunTPNq1dTpdQ1hbZZDG4KvhSuORWbaWrajOtzPGyIpHlof5mk0zS5ryRLq7DEZBRDz+JrqLOy2dF49Owok1HRCjFzd2T2Vs8ZBKgjHFaUaY+bGMdcCooQSF/unip2PloTxgVyyd2d8EkjnvGV+LTTJVVvmcYzXm8Axya6TxrfNcXCwhuCc4Fc8FCAZ616GGjaB5eLnzTGyNwRTccACkJ3yVLGuWzXQcpKigIQRzir+jMyXq5CqGXtVQcIfmx+FJC3lSK67sgE57UNAdW8oi4z8xplzeC1sDIOXfhRVOwm+3ESDnPH0qK5dtR1SO1hOUh449am1hmjpVkbkDf9xeW/wBo+lbyQs4J+6g4z2FO0+G3tLZUwWYdQO596ivLiSfEa4Ueg6CsneTL0SF+0i2JS2yznguev4VPaWTSHzZBvY+tQWtui/Mxzj9aludQ8lCFOOPyoa6IE+5PPFYWnMg8+YniNemamuL+5S3W3t1VGY/MIlxj2qlpVqSpvLhtu/7mew9auPqSWaEQIB/tnqahrUq5Rm8JS3xFzNN9mkPc4OfqKKkGpTTElmJJ9aKd5C90wtZ8RWcqHa4PHSsPTrkXNwGXpVq+8JRWsecknuTVTSbb7Pche1aq1jN3udVgeWOO1UbskqcDNaIHyD6VUnUYOealFGt8KdGOreKoWZMx2/znj05/p+tfTen2vlwbmBDNzg9q8k+Bmhg215qBXAdhGGPcdTj8h+de0KAI89MCuep70jto+7A5rxHHHLD5RVXX0Zc15F4o0Gx3O6x+Ue4jYgflXrWvTqwYHLn06V5p4rVxC7AAueAo6CuWS949CDfIePXlupuH2gkA4qALt8yULwo2qa15bdlkmTGSpzmmHT5Bax8feGTXTGWhxOOtz2yyuGPhy0ViAI4EAUdPuivOri5F3rkkrksscbFc1b0LxM1t4dk0+8EhmjTZE4H317A+4rDn1FLWdpFgbaU2Z71CjqdMpKyOY8RQPcX/ADx5iZ57c1z7RPDuR8gg4IrrL29Go3vmtGFRVwDjk1V1jRC1kJg371h8y/yrrpu2h5tdLc5txs25yNwyvHWo35HNaOuqtu8UOAWVATnt6VlgvMcRqzn2FbrucrL+mweZKbneMoOh7mrMjyJmRgMkfKfWqthZSAneevOAelNu5zLIqgnA4FAF6W6eyuLJww4VSc/WvSfDeuW6QtNs3pC42sp4ZSRyAOwryvWj+9Qd1RR+lT6F4in0mYFgZYfLMZTHbt+tZ1KfOaUqjg7o99udYaO0DRXDDbn52OSwPf2qHS/EDvC6zSbnR9rSMcH2ry208dySWvlyzoS5LbUzlQOB+HPA9vem2Ot6opcRWs0iMf3jKeHI6c+lcnsWjv8ArSex6RqmuKGZgqRbcKysMgJnt61ymqawkVzNcIVVBh0Ckg4B9PXBI/A1mXtzrOoWJWRMM4G4sOUOQB+mfzqnFoNzcllnkZVYn5VJPGMc5pxpqOrZE60pOyMvV9RbUXSCyaWQFckBs7DnkfStHQfC6xFZrkiRwMqD0XHUVuWGixWcO2ONVyAeBV2OFiwwDnrxSnV0shQpa3luOjtIkVcIeOlW1j4yy/hmiJAv8WW/lU6Rc5PHeuds64oiVCOw+lVtRuBHA3XpWk3yJn865bxFebI3y3yqDTirsqpLlicTqc4udSkc9E4FUp22r71PGjNJuc/NIScVXu/mlCjpXqxVlY8SUuZ3I41OCe5qwgCLmkSIGmTtztGKYh8bSSuSvCgelSxxu/UnGCP0plugCYbvVqKFAQ24k56ZpgT6dK2naWzsf30vCL6CtTw7Ym3RpnP71+S3pWPaLJc3MasM44APQCuqtk2OkQ+pqNxl6P5d3J6cUoXAyfvHrQg4Jz1/lTqdhXAsR06CqoT7VcYYZRTlh61PIcKfpUa/6PbBRzJIc1LXQafUtlzcSEE4RePaqd45luFiTJA61L5gijIHReSfU1R+0CAlz80jnp3oatoCfUvq0dquXwWPAWiqe8xIZ5m+bsvpRUWKuZOq+Lba4UqhJNZ2k3QuLkP2zWxf+F7S1i+WMZx1rDtoRa3I29M1atYTudqoBiHPUVTnj5OelEVw/lLVqxje7uooVQyOx4X1Pb9az2Gj3v4U2AsPB1kwUZnLynjtnA/lXXXM4WI4OOKo6Hpp0XSrLTyebeFUOe7Y5/Umkv5SASFaua56CjokZN/m4LAA89z2rhvE6LCpPZRwPeuzuZyI2LMR6ADFeeeKbtpJDGvOeKwludsVocSLUSzytjhg1b66MFhi3IMbRVe2s83Sx454U/XPNdW8SmFAw5AwaXNqLkVjnTpcYRiVHHPFc9rMKL8idT+ldlqknlRbI1G4iuL1HEeXc5bFdETnqWSMVbUfaArfdQ8+/tUuq6hHB5alfMPZB/Ef8Kr3t+mmxhpEaWSQn5AcZPpn8qiNmTZvMXIuZkyY5l2/L/sHOMe1dkI2R5lSd2ctezm5u2kkIdmOSf8APatEjbbJHENueTt4rJWN2vCrjBU5I9K27cptaTbyBgfWtDMiinKqyHAb1rOQE3QB/vf1qZ2KSEnqeaLdd9ynuwoAXWz/AKUQDkjAqiz8Yxg1d1gj7c+Oee1UpPmYYoAZtKsPcV3ng7UwbcQOeD09jXD3AwFI6rWpoN19luuW+V8EH0rOpG6NaMuWR6mtv5vJGV6EVE6m1fcQWXFLot79oURk/Nj861J4kAxKMA8Bh0rj20O619TNikSdhsDEenQVoR2qkZJ/ADiiG2gB+SRceuavxCCEZLhvYdazaLRBHZ7yMKB+HWp/swizuTBPc9TVuJhJ9xQo9qjvZFSNtzcgdBUNG6slcw9SuFiRttcF4lut6BO8h9egFdRqNyCWLYCrz9K4XV2e8vv3Y3fLwP7o967MPT1ucGKrdCtbquZJvvBVxWeo82YtV+YldPAUHk84qpAgjGTwa7WcCJJCI049Kropds0+V/NPtU0MeOOp/lQMVVzgYzU0aEOp+UDPTvTkygwoyetIu0MC2A2fTpSEamjwCOJrlhjsK2tNRnVpj1fgVm2p82CG1Xr0P510EUQjRVXgKMCpSG2OptPxQwxTJIZPu+w5qjb3InlaVuFTgU/XLn7Jp7uD8zYUfjWfYP8A6KATgHk0hlprhwpI5DHgY60iAR/vpcFuwPakRDzKwwP4RWXqeolT5aNz9fu//XpWKE1TVSrFEbL45P8Ad/8Ar0VjkEnJ5PU0VVhXNfUfF5uQVRCffFV9Fja+nDtnGa6O/wBBtLeABY1Bx1qPQLBRMoQA5OMCs7q2hVjcg0wGFMKST7V6N8JPCAk1N9VukAS2wUB6l+35dfwFYvhTw7N4r1mTSYJ3t7S1jEl9dQkbwD0hQ9iect1Ar2/TtKtNHsIbKxtkt4Ih8qL39z6n3Nc052906qNK/vMmnVU59qybpGYlgMr7GtS4kAQZ4+nWsK+vhHkhs9uaybsjrgrsxNcmIjPBUVw00Ie5MjcheRmuh13UgQyg8ZrkLjUNu5s/SsXqdjaih8QUalEueeSa1Xu0V5ckY4rmbWaV3kuCDnoKqaprKwnaZNuM7jTjDUxlVSRf1jU1wTu5x0+tcZc3Zurk4b5FPGKpap4he7kMNuTgnBc/0pLWNnKxLnc3Ax1zXdRpNas8yvW5tEWLi6sCVgutNkvc5KssmwI31rG1eQK6su+3AIYI5Y4P45zW2P7Y0q2bT9WnZEVswpJEpQD64z+uK5bWrl7iYQkhjF8o2NlfwroOUqRTebPJKwJLGr0MxMixDgAc1RSLyCNxq5YLsLTOeW7egpgQXfzXG0Va0+Ei6jDDPIqCCRGne4kBOThFHc1fsNz3DuoBZfU96AKV/DHFdz7XUNuOFFZ+CW3Yxjk1d1BXnu23KpbP8HQ1BxGWiY5yeT6GmAydSyE+op2nsGOw9V6UrAohVvwqtGxgnBpNAmehaJfuqJg4kj/UV31jdRX9sA2M4ryzSbgSIrq3zL1HrXZeHdUjV/LPOTn3FcVSOp6NN3VzZuLUKT5YJA9KhilWN8Nuz71ozSxHGzcuecmq0kAOfuuOv1rNGli9BdKUyGBHpms/V7gsCmcZ7CoX1PT9MiaS9mWEIcYJ5PsB3ri9V8TvrlzILINDZocM38ch7D2q6dFzZNWvGnHV6jtY1LMv2WIeYc87e5/wFZTWpWVw8yoAo3EcZPPFaFpbR2yNdTkeZjIB7D/Gs2K4+137HyxKpyQGPv2/OvRUVGNjyJTc5XKU7vFppKbSDJgEVQjt5CA8mRu6VrXWRCEEKjEjEA5PNZ/zS+U7MWbkH0FSy0OihC4yKnVQx2rxTWQiULuGDjn0p0blXOMnJ29KAYZIGE/Ooi7Mh5+UHBOetTKVilKMuc1T+zZQSbiF3cKfrQB0+gDdMWxnHArpQvFYXhi3K2okPVua3geKSEwxSEU4c0pHBoEjlfFErT3trZR8kncRViONQViX7qgbjVVyDql5fvzsxFGP51dOLa2yx+cgs39aCirqd+LdNikegGa5wku29jn6+tS3E7XUpO47c8Z7Cqd3OsQKjqRQMS6nCIApyzA5oqtFE0z7mP50UAdJqHjGS4+REznit3w8J7W1E1yClxN8qIOqA9SfTis+z8NWmn2wv5ZvtFznbBGFwhf+9zyQKuS3DyukERY7RiSX29PxPJojFCbuexfs86haPp+rO0g+0T3ZkI9VAwtevy3KuBs6V8p/C3W5NH1BMOVQNhvcE19L6fcfabZZFweBXmt2kz1Y6wVg1CYqpycentXDa3qDSStGu4N/eU4//XXU67cCOF8tg9q4ZJCiT3L5w2QoNTLU1g7HM6pLOrFTOGGehFZsgwnmTSkg8KqjGavX0kQlaR8Ek8CsLVNRWLdLuVEjGM+/c01Emc7u5JqWswadb4jLccYPO5q5GW8muhdTSPndgAdh7Vn3OptqQM5JChyEHtTrFy9nIOvz4rupUuXU86tVc2QWqZkLHtV6O1OrJNBFc28UgGVEkqoT9MkZqs48lCDwTVy3stDNvHfLqcL3S/KYJImGT9SNp/OtTELu2e3tVRTOk6gACNy6k/QnjNYtzDdWkKST5WVXLBTjgVcuLSW7mVLbZArfeKycEf7tT66gaMAc7RjJoA557oXD73BH0qw96rxMixSAEYyD2qC3iDMRV9LTER4piKcV9DCVKhxsHA9D61KurlYvLggG49WbkkmqFxHslIrV0FbRZ3a6LqAnyFQDhs9T+FAyDzZbVA5YCQ/eXsB/jVdsOrOSdzdB6Cr+rNax37R2cxuYc/LIy43fhVB1yTyc5oQCxyeYvlt16A1DOMMM9RT/AOLiln/epnuBzQBPa3EluQyHkVrWuuNDMsoJRh19DWJburRrk4xxVgR5HTPuKHBS3HGbjsdvF48hWIB1d2HYCqd58QLloytnGsA/vk7mFcmYx13Y/CkKAcnJHucVKpRRcq831JLm7vNUuQXd5pXOAWPWunsLGLS7RGkI2pyc9z3NZmgwRZN1LhUTODjgepqLVtYe6BZQPs6nCDn94e30Fax91HNK8nYXUtWa8uQMN5RI8uPqXHTNRXF5cWMBmWOLDOVIAzsOPX3/AKUadbGXUElu5CZnQk9tvHFW7uATWTWyocHJLH+9njNJ3ZSSWhjxa0CwaeDOG3EoxGTT1vLV4fLVnXL7ssucVlyoYzsYYYcEe9TW68elSizQe8tcqzSSMy/dwuKY2qbmwtqWyc8k5NWtJ09bmZpJFykYz+NXhYo0uVUEL7dKZNzPkkJUSzQtGcgna2aSSYywqojYgnOQvWprvM84iXpnpWlptmskvmsMRxcKPU0gua2jW8lnZwK+Q2wAg1qxuJBkHnuKqwMWiO7JxzRaP++4PBz+FKwy+BSTHZC7egJqTIFU9Xl8rTpiTjKkUCRzNrm6mij/AIU/fye5PIpmuXpGIEPzMOfpU2myLFaSzkcuc59AKxZZTLLJcOTyePpTGQXEotoTzz7d6zoka5kJI/8ArUsjPeT7V6foKuoEgAQdaBipGI14AwPWinSEKpGeTRSA7DVLje/2khUCAmNemT0HHYc8D0FVll3ukSsEjjw8h7sf/wBdS21kdX1QwmRnUZlldeyjkn09qgvoEgufsluJJEkKSBj3Q8/0qvIgd4ZUfa5zu5R8Y7g5r6C8HeJUl05I9wyFwc18xWepzaZr9wv8LOcrXo+ja+YEEkEvPG5c159eDjK6PToVE48rPUfFGqo67Q+4n0OMVx2q60Y4RCjYA4rLvPEDXR3OeT1rFvdSU5LMv4Vmlc0lKxZubhljM0jcHhRXnnijW/7Qn+x2zHylOGOfvGp/EXiWSUtBbsQCNoPt3NY1jbeVC95KAET7uf4m7YrqpU+rOOrU6IW2kKxTQjko2RW1oaObR3YLjccZrntPkiF3++cxRvkMwGSK2bbV7C2tjbjzydxxJjr+FdJzk5ltRdRteiQw52kRjLH6VNeR6VGGjsZZUVuizx7QT78n9KSwv9HljmgurOSc4zHIsqqT9VPUflVW/lhCeWryQZP3WUHIP1pAGkWzi8NwZECgFdqZwKs6gRMhA5p1jAltb+WGJ9z3Jp0iqoJGCO1AHOqPKmx71swgOmB6VnXMI3M4wCDV+1JXarDjGaAMnUrfbMcVFat82DVu8cvcE9qhEO1g6nvTAddWbRKsi5IP6VCvzYz1rXA3Wp4rKZTISFADL1HrQBGUIB9e1M3cg469anxk4NV5V25x0pAFsBvdD9RVlWdR8p/CqaPskV89autggNVITEaY9GA/AUWtvNfzpEgALnAoRCx6Zq7DcCygklQfvXHlR49T1P5VVhEl3J55XTrc4hi4dhzuI/pTbWKJm+2zDNpBkRg/xn16dM0y2t2cC0T70mHlf+6vp+P5jFS6rKskkVlCMRJgYpC20GWouLy+Aix59xl1XGflAz/IVtWkP2vc9w52H5ioPByM81Qto3hL3MZ8uML5Z45IPUfT/wDVUerX6WM7srkyt0jzkKfU/wCFIe+xQ1m0RLkSptw/BC9OO/41DGm0VFGzzuZJGJJ6k1q6Zp73UoOMRryc96kou2Svb2axKMM53MfT0rYtolgthkZyQMepqG3sZCVJGcnpUwXy2iMh2qJRu+lO4rFAWAS9kbHQdDUzShWSCPjBGQKmvJ4zqE7I3AIUH1JplnBs3O6Zk3jJ/pTEasS/6K5P0pLD5Sw7npUsYHlYccMD0NTQooK7RjHIqWMkt5RMxGMYPfvWN4zujBprIDy5ArVaNonBX1A61y/jWc7IA4PzSAnPYDtQFildT+XpscCnBcDP071j6jNtRYlJq1eSeZIijIAA49B1P9KzsG6vM9RmqBEybbK2BI+dhmks1Lt5rc88Zpsim7uRGv3U6mpp5UgTavXGKAEllUNk8UVVjRp3ywz7UUFHc6bPaQ3N3FeebFHOoQuIy24Z+YAAg4wara9rqu9xfQo0KyKsFvG2NyxqAATjueT7EgdqoXF2sVzLczy+WxJG0ctjHYViXd1JqLJGikRoMKKRCEso3nmMzsc9c1ow3UsFx+7lKc9f6Vn26NCdu4rmp5IHYbg6kexo6WY763NiPxRIH8uRQ4/vLxVa+1mK8QhZmj7H5M/1rJZgi7QMH1zUPA6kVn7ONy/aStqThLRW3MJJ3z0Pyr/jUN7ePcFULYROFVeFX6CmSS7V4HJqvnFWSGTV/TLM6jcJbiaKHdk75DhfoTWfW/ouiW2o2rvJqENvN1VJH27h7ZGM/iKLgbGpXVssYtbzS7XzEXbvgkDKw9cdvwNc7d3MIuEa3TYi8qGGcEVoXMb2sO2eKC7hXhZEXaw+uP51jMPmJGcds80AasXiO4fCywwS577dp/SpDq9rJjeskLe3IrFVPfHvTckHg5xwKLAbe1bhFETxyjdk7TzU33BIWVl44Fc4hIbIJBHcVci1e8hGBMXH91xkUAWZIyRn3xS+SGVVIPAzTYtXgc/6VaD/AHom24/CtW3/ALHugDFqZgc/wXEf9RTuIjjg/wBC2gndmsy7tZYXE6feBrrYdHvHjLWxguk/6YyAn8qy9QtJo1ZZoJoTjHzoRQBhOEMfnqTk9Qf4T6VFKoKBx3/Sr62+1lVirI6ksPSqMg2M0eSRQBSbgfQ1chYsnqRVOUc1NbNyAaaGy0snlxEnqaswhII2up/mWIbI0/vyHnHByPXPt71UT97MiklUByxxnaB1NWrIf2leiVl2wQD5EPOP8nmm2Sa1pALKx3OczyEvIfUmqMMLM7zkZxzV1i9wH4JA/QVJcGKGyT5wqFPmGeW9MUEFO8v3s7aSFQPmIMZ6445Nc4d0suWJZmPOepq5cSNO67sgAcD0q1oukPeXBldlht4hvknkB2IP6n0A61O5paxb03TlKAuCx9hXSWsHkgLsVV2gn1qO21TwvY8GPVNScZHyMttH+uWNWk8f29mpbT/CujRnOA100lw36kCiwXJvNQsgVhuz2GaiGj6tewTC3sbqXJyGWMkAZ9cVDcfFDxHhvJksLE44+yWMSEfjgmud1Xxh4h1BCLvW9QmyeVM7AfkMCiwHWz+GNQ84vPHbW28xt/pFyiH5fYn3qeDQCHZpdc0CMMxc/wCmqe/tXm0siNIGdc5Ykk8k/nUschVTtBGSTjFCA9NRPDcRCXPjGzRx2htZJFH445qfZ4eLYi8aabk5/wBdbzJ/Q15jG5KKWznOBS3M7LImH4UEAZ9aLCPTZdKifbLB4m8OzpnPF3tJ/BgK4XxZp1w91DCk1rdPuzttpRJ1+lYF5IFgA4PaqQkaIxyRsUZeQV4INA0Xp32CXIxg7QDxjFRWqmOIkD94/wB2kuD91Ty3fvk1ID5CZY5fFMQpZLVNqnLHqfU1XihkunyeB61LDatO2+Unb/OrjfINqLtAoGRBFhXanJ9aKilnWMEDlvQUUARNazzTbpdzFuauwWm2SNVPA+Yn1ropNOVwOMYqvc2qJuOcZGKnmHYyL1o5cnbjB6iqTRkruDbh7dav3EIY7VJwOhrOlHlgoMYzkmncViNg3ZQuO5ppAUbmOeKG4HA+pqGRyw/GkMazlzk0lJRSGSQIskqI52qxAJ9q6W40PRpUX7Bq2/joVIZfqD/Q1l6LHpZZjqbzIpwEaNd20+pHf8KvzWGkiXfZ3BYAdHJ2sfX1FAijfg2gW3L5OBkr91qp7sim3Dh5DjOB0yaappgSbuCKQGkzRQAgHJpNvenDrQaAGDNPGcjimgc1Mg6H0pgPhneFwVZ0IPVWwa1YPGOtW0ZjTUJXj6eXNh1/I1jvGUKsKbIWJwB1pAba6/DeHfe6XBI3d4CY2/LpVS9ls7k7rRZl8scrKQT+dZgLDtT4JvLdX7E4P0pgNnw3I4zTIjtI9jUlyhidkPPcfSoVBPA7mkBdELSlIlPzS8n2UVtWkSxWp2AZc7RVSzh8sSSgfM3yJ7KKvFA1gSHVDE4LFuwqiWySOdLBGaQgxlWSTPY+mKwZNYuPPD2zmJVG1B1wPxqPUtRa+lIX5YgxIX1Pqfeq235aTY0rF8a/qTEZucn1KL/hU32y9u4h9pupHQHIQ8KPfA4rPgh3uB2HJq6pwcA8UIGTJII13KM8Y+lN83MeOxPSmngEc00LzTEOlkye9QTuA/Pp0p7feFVpMyS4/CgaFBeeXe3KjtVksVOVNRgBBgU3dlscYNAF1gVjQ9TjP51QkYtcA5q7K+1QPRQP0rOJzKG9aAH3zZVR2qvu+VPrUl6clajhTzXVe3ekNbF2NQCZ26/w/wCNKkO8+Y/XsKkjQswZgNo6L61YRAw3f5NMkjaQxAbmI74qpLOZOBwM1PKjeYTjIJ796b5Wc8AUhldQC2dpz60VaEak9G/HiigDupEABxWXdxbjzzU73oI61Umn3d6z5SrlC5XCkKKyLi3RTuc5Na11KFHvWNds0pIPSmhMqu284QYWomOTT2+Tjv3qKqYwp8a73CjqTimVq6FaafcPIb+7NsAP3ZCkgt746UgNX+xUsrfMF7pt5FIASOpB9D0IrGvf9GOBCsRPVQcj6ir11pNrEzmzvBOoyR82PyP+NY08plbnPHY00IbjcM96UdPQ00NgYpwO7uPxoAcPSlHJpAOc4pRkdO9AC4pDS59ulJjJPNAAF5qwg4qFfxqcfdGO9MBXbGBUZYDnFLJxgmmcudqjOaABiAg4xgE1Ao+Sp7gOqNu9hmoF+6B70AS3PzRxuOwx1qO2jMs6IO5qxOv7lVNTaLCDN5rdPuj60dQexqwY8xQQdoIXjsPWsvWNSE7mGI/uweSP4yKn1S8FvH9miI8wjDsPTNYhobFFEkCb3+lWSqMQMHg5NJZIPKdvyqYQ4YL7DNCHcVcRxAnqadDljk1DM/mzCMHgcVajUIpGOgpiBVIz69aO9OJwOgBqKR9vSgRHIfrUQ6g/ypSxJ5prEAYoKJGJYZpkfzS4680hbAxT7Vcyg8cc0ASXD/ISe5NVI/mUn0NTXTcYqG3BVWJIUHgE0mILsgkVJYQl9x7VFMq7c79zfTjFXbciGKNRyWHOKAexYYhBjjHvToGyjDPfNQO43N2FSj93GD680xCyNxzyKiaRVHPWoJrj86iXfIaBk8lwzdOPpRSLCFGe9FAG48vPFQPMTxRRUgQSksKoXB29OtFFAygx9epplFFIYo610NuPDpsVR/tS3WAGzgox9QRyKKKAZn3kEFooe3lLqx79RVS1tnvLhYkGSxoopN2Q0aGvaclh5AQcFcE+prKAyDRRSpu6CW49SQOCRUgdu4DUUVZIb16YZf1oCq7cMD+lFFAEkaMq5ORk089D83TgUUUwCRHGzzOF9RTZZFQgj5SOnqaKKQEBLzEBicdhUiIBIB1AoopoB0zbgcDsCK1E2abZBmHOAy+7UUUC6mGztNIzseWOTTQMn8aKKRRetxsgU9Cf1q3M3zH5o+oAIPB7UUUyCmIpbeQiSJwSfvAZBqyHHlck5J5oopjGGUYyTj8ajaQHr+lFFAEZSR/9XG7fRSab9muM8x7f94gUUUDHLaSv1aIAdcuKmiVIcl506YwgJoooEyKV4SMhWfngucD8hVV2LPyenTsBRRSYxGbI/CrNs5ZkP90UUUICzGmRuJ461DcXJbgdBRRTEiOGIyHJ6VZUbeBxiiigBygu3oB1JooooEf/2Q==",
      assistantName: "Alex",
      maxImages: 3,
      maxImagePx: 1600
    };

    var PLACEHOLDER = "data:image/svg+xml;utf8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">' +
      '<rect width="120" height="120" fill="#e2e5e9"/>' +
      '<circle cx="60" cy="46" r="20" fill="#9aa1ab"/>' +
      '<path d="M22 112c4-24 20-34 38-34s34 10 38 34z" fill="#9aa1ab"/></svg>');

    var $ = function (id) { return document.getElementById(id); };
    var panel = $("albPanel"), log = $("albLog"), text = $("albText");
    var previews = $("albPreviews"), hero = $("albHero");
    var cards = $("albCards"), status = $("albStatus"), sendB = $("albSend");
    var history = [], pendingImages = [], busy = false, dayShown = false;
    var agentJoined = false, joinedAt = 0;

    var avatars = document.querySelectorAll("[data-avatar]");
    avatars.forEach(function (a) {
      var img = a.querySelector("img");
      img.src = CONFIG.avatarUrl || PLACEHOLDER;
      img.onerror = function () { img.onerror = null; img.src = PLACEHOLDER; };
    });


    /* ---- Präsenz: 7-20 Uhr grün/atmend, sonst gelb "Bald zurück".
       Sobald der Kunde öffnet oder schreibt, dauerhaft grün. ---- */
    var engaged = false;
    var badges = document.querySelectorAll(".alb-badge");
    function istGeschaeftszeit() {
      var hh = new Date().getHours();
      return hh >= 7 && hh < 20;
    }
    function applyPresence() {
      var online = engaged || istGeschaeftszeit();
      var lbl = online ? "Online" : "Bald zur\u00fcck";
      avatars.forEach(function (a) {
        a.classList.toggle("is-online", online);
        a.classList.toggle("is-away", !online);
      });
      badges.forEach(function (b) {
        b.classList.toggle("is-online", online);
        b.classList.toggle("is-away", !online);
        var d = b.querySelector(".dot");
        if (d) d.setAttribute("title", lbl);
      });
      if (status) {
        status.classList.toggle("is-online", online);
        status.classList.toggle("is-away", !online);
        status.innerHTML = "<i></i>" + lbl;
      }
    }
    function markEngaged() {
      if (engaged) return;
      engaged = true;
      applyPresence();
    }
    applyPresence();
    setInterval(function () { if (!engaged) applyPresence(); }, 60000);

    function setState(s, label) {
      avatars.forEach(function (a) {
        a.classList.remove("thinking", "answering");
        if (s) a.classList.add(s);
      });
      status.innerHTML = "<i></i>" + label;
    }

    function updateSend() {
      var ready = !busy && (text.value.trim() || pendingImages.length);
      sendB.classList.toggle("ready", !!ready);
    }

    function autoGrow() {
      text.style.height = "auto";
      text.style.height = Math.min(text.scrollHeight, 96) + "px";
    }

    function joinNotice() {
      var j = document.createElement("div");
      j.className = "alb-join";
      j.innerHTML = '<i></i>' + CONFIG.assistantName + " ist dem Chat beigetreten";
      log.appendChild(j);
      var head = $("albHead");
      if (head) head.classList.add("has-agent");
      $("albName").textContent = CONFIG.assistantName;
      var role = $("albRole");
      if (role) role.textContent = "Service-Team \u00b7 antwortet meist sofort";
    }

    function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function row(role, content, imgs, typing) {
      if (!dayShown) {
        var d = document.createElement("div");
        d.className = "alb-day"; d.textContent = "Heute";
        log.appendChild(d); dayShown = true;
      }
      hero.style.display = "none"; cards.style.display = "none";

      var r = document.createElement("div");
      r.className = "alb-row" + (role === "user" ? " user" : "");
      if (role !== "user") {
        var mini = document.createElement("img");
        mini.className = "mini";
        mini.src = CONFIG.avatarUrl || PLACEHOLDER;
        mini.alt = "";
        r.appendChild(mini);
      }
      var m = document.createElement("div");
      m.className = "alb-msg";
      if (typing) {
        m.classList.add("alb-typingwrap");
        m.innerHTML = '<span class="alb-typing"><i></i><i></i><i></i></span>';
        m.style.padding = "0";
      } else {
        m.textContent = content;
      }
      (imgs || []).forEach(function (b64) {
        var im = document.createElement("img");
        im.src = "data:image/jpeg;base64," + b64;
        im.alt = "Hochgeladenes Schadensfoto";
        m.appendChild(im);
      });
      r.appendChild(m);
      log.appendChild(r);
      log.scrollTop = log.scrollHeight;
      return m;
    }

    function resizeImage(file) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var s = Math.min(1, CONFIG.maxImagePx / Math.max(img.width, img.height));
          var c = document.createElement("canvas");
          c.width = Math.round(img.width * s);
          c.height = Math.round(img.height * s);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/jpeg", 0.85).split(",")[1]);
          URL.revokeObjectURL(img.src);
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }

    function renderPreviews() {
      previews.innerHTML = "";
      pendingImages.forEach(function (b64, i) {
        var w = document.createElement("div");
        w.className = "p";
        w.innerHTML = '<img src="data:image/jpeg;base64,' + b64 +
          '" alt="Foto ' + (i + 1) +
          '"><button class="rm" aria-label="Foto entfernen">\u00d7</button>';
        w.querySelector(".rm").onclick = function () {
          pendingImages.splice(i, 1); renderPreviews(); updateSend();
        };
        previews.appendChild(w);
      });
    }

    /* Termin-Marker [[TERMIN|Datum|Titel|Adresse]] aus dem Text holen,
       sauberen Text anzeigen und eine Kalender-Karte anhaengen. */
    function handleTermin(node, txt) {
      var re = /\[\[TERMIN\|([^|]+)\|([^|]+)\|([^\]]+)\]\]/;
      var m = txt.match(re);
      var clean = txt.replace(re, "").replace(/\s+$/, "").trim();
      node.textContent = clean;
      if (!m) return clean;

      var isoStr = m[1].trim(), titel = m[2].trim(), adr = m[3].trim();
      var d = new Date(isoStr);
      if (isNaN(d.getTime())) return clean;

      var card = document.createElement("div");
      card.className = "alb-termin";
      var when = d.toLocaleDateString("de-DE", {
        weekday: "long", day: "numeric", month: "long"
      }) + ", " + d.toLocaleTimeString("de-DE", {
        hour: "2-digit", minute: "2-digit"
      }) + " Uhr";
      var b = document.createElement("b"); b.textContent = titel;
      var sp = document.createElement("span"); sp.textContent = when + " \u00b7 " + adr;
      var note = document.createElement("i");
      note.textContent = "Wunschtermin \u2013 wird vom Team noch best\u00e4tigt";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Zum Kalender hinzuf\u00fcgen";
      btn.onclick = function () {
        function fmt(x) {
          return x.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
        }
        var end = new Date(d.getTime() + 60 * 60 * 1000);
        var ics = [
          "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT",
          "DTSTART:" + fmt(d), "DTEND:" + fmt(end),
          "SUMMARY:" + titel, "LOCATION:" + adr,
          "END:VEVENT", "END:VCALENDAR"
        ].join("\r\n");
        var a = document.createElement("a");
        a.href = "data:text/calendar;charset=utf-8," + encodeURIComponent(ics);
        a.download = "termin.ics";
        a.click();
      };
      card.appendChild(b); card.appendChild(sp);
      card.appendChild(note); card.appendChild(btn);
      node.appendChild(card);
      return clean;
    }

    async function send(msg) {
      if (busy) return;
      msg = (msg || text.value).trim();
      if (!msg && !pendingImages.length) return;
      markEngaged();

      var imgs = pendingImages.slice();
      pendingImages = []; renderPreviews();
      text.value = ""; autoGrow(); updateSend();
      row("user", msg || "Foto gesendet", imgs);
      history.push({ role: "user", content: msg || "(Foto vom Schaden)" });

      busy = true; updateSend();

      if (!agentJoined) {
        agentJoined = true;
        joinedAt = Date.now();
        // Nur der Beitritts-Hinweis. Die Begruessung kommt aus der
        // echten Antwort (zeitKontext: Berliner Zeit) - sonst haette
        // der Kunde zwei Begruessungen und ggf. die falsche Tageszeit.
        setTimeout(function () { joinNotice(); }, 550);
      }

      setState("thinking", imgs.length ? "Pr\u00fcft Foto" : "Schreibt");
      var typingMsg, typer = null;
      var startTyping = function () { typingMsg = row("bot", "", [], true); };
      if (Date.now() - joinedAt < 2000) { await wait(1900); }
      startTyping();

      try {
        var res = await fetch(CONFIG.apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history, images: imgs })
        });
        if (!res.ok) throw new Error("HTTP " + res.status);

        setState("answering", "Antwortet");
        typingMsg.style.padding = "";
        typingMsg.innerHTML = "";
        // Textbereich + mitlaufende Punkte (bleiben animiert beim Tippen)
        var txtSpan = document.createElement("span");
        var liveDots = document.createElement("span");
        liveDots.className = "alb-typing live";
        liveDots.innerHTML = "<i></i><i></i><i></i>";
        typingMsg.appendChild(txtSpan);
        typingMsg.appendChild(liveDots);

        var reader = res.body.getReader();
        var dec = new TextDecoder(), buf = "", full = "", pending = "", shown = 0;
        var streamDone = false;

        // Nachbartasten fuer realistische Vertipper
        var NEAR = {
          a: "sq", b: "vn", c: "xv", d: "sf", e: "wr", f: "dg", g: "fh",
          h: "gj", i: "uo", j: "hk", k: "jl", l: "k\u00f6", m: "n", n: "bm",
          o: "ip", p: "o", r: "et", s: "ad", t: "rz", u: "zi", v: "cb",
          w: "qe", z: "tu"
        };
        function nachbar(c) {
          var low = c.toLowerCase();
          var opts = NEAR[low];
          if (!opts) return null;
          var pick = opts[Math.floor(Math.random() * opts.length)];
          return c === low ? pick : pick.toUpperCase();
        }

        // Tempo je nach Zeichen: Satzzeichen = kurze Denkpause
        function pauseFor(c) {
          if (c === "." || c === "!" || c === "?") return 280 + Math.random() * 200;
          if (c === "," || c === ";" || c === ":") return 160 + Math.random() * 110;
          if (c === "\n") return 240 + Math.random() * 120;
          if (c === " ") return 30 + Math.random() * 55;
          return 18 + Math.random() * 42;
        }

        // Hoechstens ein Vertipper pro Antwort, und nur manchmal
        var typoBudget = Math.random() < 0.35 ? 1 : 0;

        (async function () {
          try {
            while (true) {
              var r = await reader.read();
              if (r.done) break;
              buf += dec.decode(r.value, { stream: true });
              var lines = buf.split("\n"); buf = lines.pop();
              lines.forEach(function (line) {
                if (line.indexOf("data: ") === 0) {
                  var d = line.slice(6);
                  if (d !== "[DONE]") {
                    try { pending += JSON.parse(d); } catch (_) { pending += d; }
                  }
                }
              });
            }
          } catch (_) { /* Abbruch wird unten behandelt */ }
          streamDone = true;
        })();

        await new Promise(function (fertig) {
          function schritt() {
            if (shown >= pending.length) {
              if (streamDone) { fertig(); return; }
              typer = setTimeout(schritt, 70);   // auf Nachschub warten
              return;
            }
            var c = pending.charAt(shown);

            // gelegentlich vertippen und sofort korrigieren
            if (typoBudget > 0 && shown > 15 && /[a-z\u00e4\u00f6\u00fc\u00df]/i.test(c) &&
                Math.random() < 0.02) {
              var falsch = nachbar(c);
              if (falsch) {
                typoBudget--;
                txtSpan.textContent = pending.slice(0, shown) + falsch;
                typer = setTimeout(function () {
                  txtSpan.textContent = pending.slice(0, shown);   // Backspace
                  typer = setTimeout(schritt, 110 + Math.random() * 90);
                }, 240 + Math.random() * 200);
                return;
              }
            }

            shown++;
            txtSpan.textContent = pending.slice(0, shown);
            log.scrollTop = log.scrollHeight;
            typer = setTimeout(schritt, pauseFor(c));
          }
          schritt();
        });

        clearTimeout(typer); typer = null;
        liveDots.remove();
        full = pending;
        full = handleTermin(typingMsg, full);
        log.scrollTop = log.scrollHeight;
        history.push({ role: "assistant", content: full });
      } catch (e) {
        if (typer) { clearTimeout(typer); typer = null; }
        typingMsg.style.padding = "";
        typingMsg.textContent = "Entschuldigung, gerade ist keine " +
          "Verbindung m\u00f6glich. Sie erreichen uns direkt unter " +
          "030 607 97 930 (Mo\u2013Do 8\u201317, Fr 8\u201315 Uhr).";
      } finally {
        busy = false; updateSend();
        setState("", engaged || istGeschaeftszeit() ? "Online" : "Bald zur\u00fcck");
        applyPresence();
      }
    }

    /* Events */
    $("albLaunch").onclick = function () {
      markEngaged();
      if (panel.classList.contains("open")) {
        panel.classList.remove("open");
      } else {
        panel.classList.add("open");
        panel.scrollTop = 0;
        try { text.focus({ preventScroll: true }); } catch (e) { text.focus(); }
        panel.scrollTop = 0;
      }
    };
    $("albClose").onclick = function () { panel.classList.remove("open"); };
    sendB.onclick = function () { send(); };
    text.addEventListener("input", function () { autoGrow(); updateSend(); });
    text.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });
    cards.addEventListener("click", function (e) {
      var c = e.target.closest(".alb-card");
      if (!c) return;
      if (c.getAttribute("data-photo")) { $("albFile").click(); return; }
      send(c.getAttribute("data-q"));
    });
    $("albAttach").onclick = function () { $("albFile").click(); };
    $("albFile").addEventListener("change", async function (e) {
      for (var i = 0; i < e.target.files.length; i++) {
        if (pendingImages.length >= CONFIG.maxImages) break;
        try { pendingImages.push(await resizeImage(e.target.files[i])); }
        catch (_) {}
      }
      renderPreviews(); updateSend(); e.target.value = "";
    });
  }

  function boot() {
    injectFonts();
    var style = document.createElement("style");
    style.id = "alb-widget-css";
    style.textContent = WIDGET_CSS;
    document.head.appendChild(style);
    var wrap = document.createElement("div");
    wrap.innerHTML = WIDGET_HTML;
    while (wrap.firstChild) document.body.appendChild(wrap.firstChild);
    initWidget();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
