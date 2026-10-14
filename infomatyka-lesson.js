/* InfoMatyka Lesson Runtime v1.
 * Jeden plik, który wyświetla lekcje zbudowane w Edytorze lekcji InfoMatyki (format JSON "infomatyka-lesson").
 * Ten sam kod renderuje lekcję w edytorze (tryb "edit") i u ucznia (tryb "view"), więc podgląd = efekt końcowy.
 *
 * Osadzenie w poście Bloggera (dowolna z form):
 *   <div class="infomatyka-lesson" data-src="https://.../moja-lekcja.json"></div>
 *   <script type="application/json" class="infomatyka-lesson">{ ...lekcja... }</script>
 *   <div class="infomatyka-lesson" data-from-location></div>   // ?lekcja=URL, #lekcja=KOD, ?id=ID_Z_BIBLIOTEKI
 *   <script src="https://cdn.jsdelivr.net/gh/redakcja-infomatyka/InfoMatyka-CDN@main/infomatyka-lesson.js" defer></script>
 */
(function (root) {
  'use strict';
  if (root.InfoMatykaLesson && root.InfoMatykaLesson.VERSION) return;

  const VERSION = '1.1.0';
  const FORMAT = 'infomatyka-lesson';
  const doc = root.document;
  const VIEWER_URL = 'https://www.infomatyka.pl/p/lekcja.html';
  const LIB = {
    katexCss: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css',
    katex: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js',
    chart: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
    hljs: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/highlight.min.js',
    hljsCss: 'https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.10.0/styles/github.min.css',
    mathlive: 'https://cdn.jsdelivr.net/npm/mathlive@0.110.0',
    fonts: 'https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Manrope:wght@600;700;800&display=swap'
  };
  const MAX_DEPTH = 6;

  /* ---------------------------------------------------------------- utils */
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  const arr = v => Array.isArray(v) ? v : [];
  const str = v => v == null ? '' : String(v);
  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

  function uid(prefix) {
    const rnd = (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return (prefix || 'b') + '-' + Date.now().toString(36).slice(-5) + rnd;
  }

  function h(tag, attrs) {
    const el = doc.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && isObj(v)) {
          for (const s in v) { if (v[s] == null || v[s] === '') continue; if (s.startsWith('--')) el.style.setProperty(s, v[s]); else el.style[s] = v[s]; }
        }
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // tylko z oczyszczonym HTML
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(c => append(el, c)); return; }
    el.append(child.nodeType ? child : doc.createTextNode(String(child)));
  }

  const scriptCache = {};
  function loadScript(src, test) {
    if (test && test()) return Promise.resolve();
    if (scriptCache[src]) return scriptCache[src];
    scriptCache[src] = new Promise((resolve, reject) => {
      const s = doc.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { delete scriptCache[src]; reject(new Error('Nie udało się wczytać ' + src)); };
      doc.head.appendChild(s);
    });
    return scriptCache[src];
  }
  function loadCss(href) {
    if (doc.querySelector('link[data-iml-css="' + href + '"]')) return;
    doc.head.appendChild(h('link', { rel: 'stylesheet', href, 'data-iml-css': href }));
  }
  function ensureKatex() { loadCss(LIB.katexCss); return loadScript(LIB.katex, () => !!root.katex); }
  function ensureChart() { return loadScript(LIB.chart, () => !!root.Chart); }
  function ensureHljs() { loadCss(LIB.hljsCss); return loadScript(LIB.hljs, () => !!root.hljs); }
  function ensureMathLive() {
    return loadScript(LIB.mathlive, () => !!(root.customElements && customElements.get('math-field'))).then(() => {
      try { if (root.MathfieldElement) { root.MathfieldElement.soundsDirectory = null; root.MathfieldElement.plonkSound = null; } } catch (_) {}
    });
  }

  /* ----------------------------------------------------------- sanitizing */
  const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'NOSCRIPT', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'TITLE', 'BASE']);
  const RICH_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'BR', 'A', 'CODE', 'MARK', 'SPAN', 'P', 'DIV', 'UL', 'OL', 'LI', 'SMALL', 'FONT', 'BLOCKQUOTE', 'H3', 'H4']);
  const INLINE_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'BR', 'A', 'CODE', 'MARK', 'SPAN', 'SMALL', 'FONT']);
  const STYLE_PROPS = new Set(['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'text-decoration-line']);

  function safeUrl(url, kind) {
    const u = str(url).trim();
    if (!u) return '';
    if (/^data:/i.test(u)) {
      if (kind === 'image' && /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);/i.test(u)) return u;
      if (kind === 'audio' && /^data:audio\//i.test(u)) return u;
      if (kind === 'video' && /^data:video\//i.test(u)) return u;
      if (kind === 'file') return u;
      return '';
    }
    if (/^blob:/i.test(u)) return kind === 'link' ? '' : u;
    if (/^(https?:|mailto:|tel:)/i.test(u)) return (kind === 'embed' && !/^https:/i.test(u)) ? '' : u;
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ''; // javascript:, vbscript: itd.
    if (kind === 'embed') return '';
    return u; // ścieżki względne i kotwice
  }
  function cleanStyle(value) {
    return str(value).split(';').map(part => {
      const i = part.indexOf(':');
      if (i < 0) return '';
      const prop = part.slice(0, i).trim().toLowerCase();
      const val = part.slice(i + 1).trim();
      if (!STYLE_PROPS.has(prop) || !/^[#a-z0-9(),.\s%-]+$/i.test(val) || /url|expression/i.test(val)) return '';
      return prop + ':' + val;
    }).filter(Boolean).join(';');
  }
  function cleanTree(node, allowed) {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === 3) return;
      if (child.nodeType !== 1) { child.remove(); return; }
      const tag = child.tagName.toUpperCase();
      if (DROP.has(tag)) { child.remove(); return; }
      cleanTree(child, allowed);
      if (!allowed.has(tag)) {
        if (allowed === INLINE_TAGS && /^(P|DIV|LI|H\d|BLOCKQUOTE)$/.test(tag) && child.nextSibling) child.after(doc.createElement('br'));
        child.replaceWith.apply(child, Array.from(child.childNodes));
        return;
      }
      if (tag === 'FONT') {
        const span = doc.createElement('span');
        const color = child.getAttribute('color');
        if (color && /^#?[a-z0-9]+$/i.test(color)) span.style.color = color;
        span.append.apply(span, Array.from(child.childNodes));
        const st = cleanStyle(child.getAttribute('style'));
        if (st) span.setAttribute('style', (span.getAttribute('style') || '') + ';' + st);
        child.replaceWith(span);
        return;
      }
      Array.from(child.attributes).forEach(a => {
        const n = a.name.toLowerCase();
        if (tag === 'A' && n === 'href') { const u = safeUrl(a.value, 'link'); if (u) child.setAttribute('href', u); else child.removeAttribute('href'); return; }
        if (n === 'style') { const s = cleanStyle(a.value); if (s) child.setAttribute('style', s); else child.removeAttribute('style'); return; }
        if (n === 'class') { const c = a.value.split(/\s+/).filter(x => /^iml-[a-z0-9-]+$/.test(x)).join(' '); if (c) child.setAttribute('class', c); else child.removeAttribute('class'); return; }
        child.removeAttribute(a.name);
      });
      if (tag === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
    });
  }
  function sanitize(html, allowed) {
    const raw = str(html);
    if (!/[<&]/.test(raw)) return escapeHtml(raw);
    const tpl = doc.createElement('template');
    tpl.innerHTML = raw;
    cleanTree(tpl.content, allowed);
    return tpl.innerHTML;
  }
  const sanitizeHtml = html => sanitize(html, RICH_TAGS);
  const sanitizeInline = html => sanitize(html, INLINE_TAGS);
  function escapeHtml(s) { return str(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function htmlToText(html) { const t = doc.createElement('template'); t.innerHTML = sanitizeHtml(html); return (t.content.textContent || '').trim(); }

  /* --------------------------------------------------------------- math */
  const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$(?![\s$])((?:\\\$|[^$\n])+?)(?<![\s\\])\$/g;
  const hasMath = text => { MATH_RE.lastIndex = 0; return MATH_RE.test(str(text)); };

  function renderTexInto(el, latex, display) {
    try { root.katex.render(str(latex), el, { throwOnError: false, displayMode: !!display, strict: 'ignore', trust: false }); }
    catch (_) { el.textContent = latex; }
  }
  function typesetNode(container) {
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest('.katex, code, pre, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .iml-no-math')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.indexOf('$') >= 0 || n.nodeValue.indexOf('\\') >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(node => {
      const text = node.nodeValue;
      MATH_RE.lastIndex = 0;
      if (!MATH_RE.test(text)) return;
      MATH_RE.lastIndex = 0;
      const frag = doc.createDocumentFragment();
      let last = 0, m;
      while ((m = MATH_RE.exec(text))) {
        if (m.index > last) frag.append(text.slice(last, m.index));
        const display = m[1] != null || m[3] != null;
        const latex = m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] != null ? m[3] : m[4].replace(/\\\$/g, '$');
        const span = h('span', { class: display ? 'iml-math-display' : 'iml-math-inline', 'data-latex': latex });
        renderTexInto(span, latex, display);
        frag.append(span);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.append(text.slice(last));
      node.replaceWith(frag);
    });
  }
  function typeset(container) {
    if (!container) return Promise.resolve();
    const blocks = container.querySelectorAll('.iml-katex[data-latex]');
    const needsText = hasMath(container.textContent);
    if (!blocks.length && !needsText) return Promise.resolve();
    return ensureKatex().then(() => {
      blocks.forEach(el => { if (!el.dataset.done) { renderTexInto(el, el.dataset.latex, el.dataset.display !== 'inline'); el.dataset.done = '1'; } });
      const targets = container.matches && container.matches('.iml-tex') ? [container] : [];
      container.querySelectorAll('.iml-tex').forEach(el => targets.push(el));
      targets.forEach(typesetNode);
    }).catch(() => {});
  }

  /* -------------------------------------------------------------- icons */
  const ICONS = {
    bulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4 12 14l-3-3"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/><path d="M6.5 17A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    quiz: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
    help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
    right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    left: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6M18 9h1.5a2.5 2.5 0 0 0 0-5H18M4 22h16M10 14.7V17c0 .6-.5 1-1 1.2C7.9 18.8 7 20.2 7 22M14 14.7V17c0 .6.5 1 1 1.2 1.2.6 2 2 2 3.8M18 2H6v7a6 6 0 0 0 12 0V2z"/>'
  };
  function icon(name, cls) {
    const span = doc.createElement('span');
    span.className = 'iml-ico' + (cls ? ' ' + cls : '');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || ICONS.info) + '</svg>';
    return span;
  }

  /* ---------------------------------------------------------------- CSS */
  const CSS = `
.iml{--a:#1677e6;--a-ink:#0b4fa8;--a-soft:#eaf3ff;--ink:#0f172a;--muted:#55657a;--line:#e3e9f1;--bg:#f4f7fb;--card:#fff;--ok:#16a34a;--ok-soft:#eaf8ef;--bad:#dc2626;--bad-soft:#fdeeee;--r:14px;--font:"DM Sans",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--hfont:"Manrope","DM Sans",system-ui,sans-serif;
  display:block;box-sizing:border-box;width:100%;container-type:inline-size;background:var(--bg);color:var(--ink);font:16px/1.65 var(--font);text-align:left;letter-spacing:normal;word-spacing:normal;text-transform:none;overflow-wrap:break-word;-webkit-text-size-adjust:100%;color-scheme:light}
.iml *,.iml *::before,.iml *::after{box-sizing:border-box}
.iml.iml-view{display:flex;flex-direction:column;min-height:var(--iml-page-height,100dvh)}
.iml .iml-footer{flex:none;width:100%;margin-top:auto}
.iml.iml-view>.iml-doc{flex:none}
.iml.iml-view>.iml-progress{flex:none}
.iml [hidden]{display:none!important}
.iml.iml-font-system{--font:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--hfont:var(--font)}
.iml.iml-font-serif{--font:Georgia,"Times New Roman",serif;--hfont:Georgia,serif}
.iml.iml-font-rounded{--font:"Nunito","Quicksand","Segoe UI Rounded","Arial Rounded MT Bold",system-ui,sans-serif;--hfont:var(--font)}
.iml .iml-doc{width:100%;max-width:var(--maxw,1100px);margin:0 auto;padding:clamp(12px,3cqi,28px) clamp(10px,2.5cqi,24px)}
.iml .iml-section{position:relative;margin:0 0 18px;padding:clamp(18px,3.2cqi,32px);border-radius:18px}
.iml.iml-cards .iml-section{background:var(--card);border:1px solid var(--line);box-shadow:0 1px 2px #0f172a08,0 6px 24px #0f172a0a}
.iml.iml-flat .iml-section{padding-left:0;padding-right:0}
.iml .iml-slot{display:flow-root;min-height:4px}
.iml .iml-block{position:relative;margin:0 0 18px;min-width:0}
.iml .iml-slot>.iml-block:last-child{margin-bottom:0}
.iml .iml-block[data-align=center]{text-align:center}.iml .iml-block[data-align=right]{text-align:right}.iml .iml-block[data-align=justify]{text-align:justify}
.iml .iml-block.iml-has-fs .iml-h,.iml .iml-block.iml-has-fs .iml-rich{font-size:inherit}
.iml .iml-block.iml-has-color .iml-h,.iml .iml-block.iml-has-color .iml-sub,.iml .iml-block.iml-has-color .iml-rich{color:inherit}
.iml .iml-block.iml-boxed{border:1px solid var(--line)}
.iml .iml-block.iml-shadow{box-shadow:0 8px 26px #0f172a14}
.iml .iml-h,.iml .iml-rich,.iml .iml-sub,.iml .iml-list,.iml .iml-figure,.iml .iml-quote,.iml .iml-table{margin:0;padding:0;border:0;background:none;box-shadow:none;text-shadow:none;font-style:normal;text-transform:none;letter-spacing:normal}
.iml .iml-h{font-family:var(--hfont);color:var(--ink);font-weight:800;line-height:1.18;letter-spacing:-.02em}
.iml .iml-h1{font-size:clamp(28px,5.2cqi,46px)}.iml .iml-h2{font-size:clamp(23px,3.6cqi,30px);font-weight:750}.iml .iml-h3{font-size:clamp(19px,2.6cqi,22px);font-weight:750}
.iml .iml-sub{margin-top:10px;color:var(--muted);font-size:1.06em;line-height:1.6}
.iml .iml-rich{font-size:1em;color:#334155;line-height:1.7}
.iml .iml-rich p,.iml .iml-rich div{margin:0 0 .7em}.iml .iml-rich>:last-child{margin-bottom:0}
.iml .iml-rich ul,.iml .iml-rich ol{margin:.3em 0 .8em;padding-left:1.4em}
.iml .iml-rich ul{list-style:disc outside}.iml .iml-rich ol{list-style:decimal outside}
.iml .iml-rich li{display:list-item;list-style:inherit}
.iml .iml-rich a,.iml .iml-h a{color:var(--a);text-decoration:underline;text-underline-offset:2px}
.iml .iml-rich code,.iml .iml-h code{font:.9em/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;background:#eef2f7;padding:.1em .35em;border-radius:5px;color:#0f3a66}
.iml .iml-rich mark{background:#fff3b0;padding:0 .15em;border-radius:3px}
.iml .iml-math-display{display:block;margin:.6em 0;overflow-x:auto;overflow-y:hidden;text-align:center}
.iml .katex{font-size:1.08em}
.iml .iml-list{list-style:none;display:grid;gap:8px;color:#334155}
.iml .iml-list li{position:relative;padding-left:30px;margin:0;line-height:1.6;list-style:none;background:none}
.iml .iml-list li::before{content:"";position:absolute;left:8px;top:.62em;width:8px;height:8px;border-radius:50%;background:var(--a)}
.iml .iml-list-number{counter-reset:iml}.iml .iml-list-number li{counter-increment:iml}
.iml .iml-list-number li::before{content:counter(iml);left:0;top:.1em;width:22px;height:22px;border-radius:7px;background:var(--a-soft);color:var(--a-ink);font:700 12px/22px var(--font);text-align:center}
.iml .iml-list-check li::before{content:"";left:1px;top:.25em;width:20px;height:20px;border-radius:6px;background:var(--ok-soft) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2316a34a' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/13px no-repeat}
.iml .iml-list-arrow li::before{content:"→";left:2px;top:0;width:auto;height:auto;background:none;color:var(--a);font-weight:700}
.iml .iml-quote{position:relative;padding:18px 22px 18px 26px;border-left:4px solid var(--a);background:var(--a-soft);border-radius:0 var(--r) var(--r) 0;color:#1e293b}
.iml .iml-quote .iml-rich{font-size:1.1em;font-style:italic;color:#1e293b}
.iml .iml-quote cite{display:block;margin-top:10px;font-style:normal;font-weight:600;font-size:.92em;color:var(--muted)}
.iml .iml-quote cite:not(:empty)::before{content:"— "}
.iml .iml-btn{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:10px 20px;border-radius:10px;border:1px solid transparent;font:600 15px/1.2 var(--font);letter-spacing:normal;text-transform:none;text-decoration:none;cursor:pointer;transition:background .15s,border-color .15s,transform .1s,box-shadow .15s;box-shadow:none;width:auto;height:auto;margin:0}
.iml .iml-btn:active{transform:translateY(1px)}
.iml .iml-btn:focus-visible,.iml .iml-option:focus-within{outline:3px solid color-mix(in srgb,var(--a) 40%,transparent);outline-offset:2px}
.iml .iml-btn .iml-ico svg{width:18px;height:18px}
.iml .iml-btn-primary{background:var(--a);color:#fff}.iml .iml-btn-primary:hover{background:var(--a-ink);color:#fff}
.iml .iml-btn-outline{background:#fff;color:var(--a);border-color:var(--a)}.iml .iml-btn-outline:hover{background:var(--a-soft)}
.iml .iml-btn-soft{background:var(--a-soft);color:var(--a-ink)}.iml .iml-btn-soft:hover{filter:brightness(.97)}
.iml .iml-btn-ghost{background:transparent;color:var(--muted);border-color:var(--line)}.iml .iml-btn-ghost:hover{background:#f1f5f9;color:var(--ink)}
.iml .iml-btn[disabled]{opacity:.5;cursor:default}
.iml .iml-btn-lg{min-height:52px;padding:14px 26px;font-size:16px}.iml .iml-btn-sm{min-height:36px;padding:7px 13px;font-size:13.5px}
.iml .iml-btn-full{display:flex;width:100%}
.iml .iml-hr{display:block;height:0;border:0;border-top:1px solid var(--line);margin:6px 0;background:none}
.iml .iml-hr-dashed{border-top-style:dashed;border-top-width:2px}.iml .iml-hr-thick{border-top-width:4px;border-color:var(--a);width:72px;border-radius:4px}
.iml .iml-block[data-align=center] .iml-hr-thick{margin-inline:auto}.iml .iml-block[data-align=right] .iml-hr-thick{margin-left:auto}
.iml .iml-hr-dots{border:0;text-align:center;color:#94a3b8;letter-spacing:.8em;font-size:18px;line-height:1}.iml .iml-hr-dots::before{content:"•••"}
.iml .iml-figure{display:block;max-width:100%}
.iml .iml-block[data-align=center] .iml-figure{margin-inline:auto}.iml .iml-block[data-align=right] .iml-figure{margin-left:auto}
.iml .iml-figure img{display:block;width:100%;height:auto;max-width:100%;margin:0;padding:0;border:0;border-radius:var(--img-r,14px);box-shadow:none;background:#eef2f7}
.iml .iml-figure.iml-zoomable img{cursor:zoom-in}
.iml .iml-figure figcaption,.iml .iml-caption{margin-top:8px;font-size:.88em;color:var(--muted);text-align:center;line-height:1.5}
.iml .iml-figure figcaption:empty,.iml-view .iml-caption:empty{display:none}
.iml .iml-placeholder{display:grid;place-items:center;gap:6px;min-height:180px;padding:20px;border:2px dashed #cbd5e1;border-radius:var(--r);background:#f8fafc;color:#64748b;font-size:14px;text-align:center}
.iml .iml-placeholder .iml-ico svg{width:30px;height:30px;color:#94a3b8}
.iml .iml-ratio{position:relative;width:100%;aspect-ratio:16/9;border-radius:var(--r);overflow:hidden;background:#0f172a}
.iml .iml-ratio iframe,.iml .iml-ratio video{position:absolute;inset:0;width:100%;height:100%;border:0;margin:0;padding:0}
.iml-edit .iml-ratio::after,.iml-edit .iml-embed::after{content:"";position:absolute;inset:0;z-index:2}
.iml .iml-video-el{display:block;width:100%;border-radius:var(--r);background:#000}
.iml .iml-audio{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:var(--r);background:#fff}
.iml .iml-audio-ico{flex:none;display:grid;place-items:center;width:46px;height:46px;border-radius:12px;background:#fdecef;color:#e11d48}
.iml .iml-audio-main{flex:1;min-width:0}.iml .iml-audio-title{font-weight:650;margin-bottom:6px}.iml .iml-audio audio{display:block;width:100%;height:40px}
.iml .iml-card{padding:clamp(16px,3cqi,24px);border:1px solid var(--line);border-radius:var(--r);background:#fff;box-shadow:0 2px 10px #0f172a0a}
.iml .iml-card-soft{background:var(--a-soft);border-color:transparent;box-shadow:none}
.iml .iml-card-accent{border-top:4px solid var(--a)}
.iml .iml-cols{display:grid;gap:var(--gap,24px);align-items:var(--valign,start)}
@container (max-width:680px){.iml .iml-cols.iml-stack{grid-template-columns:1fr!important}.iml .iml-hide-mobile{display:none!important}}
.iml .iml-callout{display:flex;gap:14px;align-items:flex-start;padding:16px 18px;border-radius:12px;background:#eaf4ff;color:#163a63;border:1px solid #d5e7fb}
.iml .iml-callout .iml-ico{flex:none;margin-top:1px;color:#1677e6}.iml .iml-callout .iml-ico svg{width:26px;height:26px}
.iml .iml-callout-body{flex:1;min-width:0}
.iml .iml-callout-title{font-weight:700;margin-bottom:3px;color:inherit}
.iml .iml-callout .iml-rich{color:inherit;font-size:.96em}
.iml .iml-callout-info{background:#eef6ff;border-color:#d6e8fb;color:#16365c}.iml .iml-callout-info .iml-ico{color:#2563eb}
.iml .iml-callout-warning{background:#fff7e6;border-color:#fde7b8;color:#6b4206}.iml .iml-callout-warning .iml-ico{color:#d97706}
.iml .iml-callout-success{background:#ecfaf1;border-color:#c9efd7;color:#14532d}.iml .iml-callout-success .iml-ico{color:#16a34a}
.iml .iml-callout-note{background:#f5f1ff;border-color:#e5dcfe;color:#3b1d78}.iml .iml-callout-note .iml-ico{color:#7c3aed}
.iml .iml-callout-danger{background:#fdeeee;border-color:#f8d4d4;color:#7f1d1d}.iml .iml-callout-danger .iml-ico{color:#dc2626}
.iml .iml-quiz,.iml .iml-qcard,.iml .iml-blanks{border:1px solid var(--line);border-radius:var(--r);background:#fff;overflow:hidden}
.iml .iml-quiz-head{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f6f3ff;border-bottom:1px solid #ece6fd}
.iml .iml-quiz-badge{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;background:#7c3aed;color:#fff}.iml .iml-quiz-badge svg{width:18px;height:18px}
.iml .iml-quiz-title{flex:1;min-width:0;font-weight:700;color:#5b21b6}
.iml .iml-quiz-count{padding:3px 9px;border-radius:999px;background:#ede7fe;color:#5b21b6;font-size:12.5px;font-weight:700;white-space:nowrap}
.iml .iml-quiz-nav{display:flex;gap:4px}
.iml .iml-quiz-nav button{display:grid;place-items:center;width:28px;height:28px;padding:0;border:1px solid #e4dcfd;border-radius:8px;background:#fff;color:#5b21b6;cursor:pointer}
.iml .iml-quiz-nav button svg{width:16px;height:16px}
.iml .iml-quiz-body{padding:clamp(16px,2.8cqi,22px)}
.iml .iml-quiz-q{margin:0 0 4px;font:700 1.1em/1.45 var(--font);color:var(--ink)}
.iml .iml-quiz-hint{margin:0 0 12px;font-size:.85em;color:var(--muted)}
.iml .iml-options{display:grid;gap:9px}
.iml .iml-option{position:relative;display:flex;align-items:center;gap:12px;margin:0;padding:11px 14px;border:1px solid var(--line);border-radius:10px;background:#fff;cursor:pointer;transition:border-color .15s,background .15s;font-weight:400;line-height:1.5}
.iml .iml-option:hover{border-color:#b8cdea;background:#fafcff}
.iml .iml-option input{position:absolute;opacity:0;pointer-events:none}
.iml .iml-mark{flex:none;width:20px;height:20px;border:2px solid #94a3b8;border-radius:50%;background:#fff;display:grid;place-items:center;transition:all .15s}
.iml .iml-multi .iml-mark{border-radius:6px}
.iml .iml-option.iml-sel{border-color:var(--a);background:var(--a-soft)}
.iml .iml-option.iml-sel .iml-mark{border-color:var(--a);box-shadow:inset 0 0 0 4px #fff;background:var(--a)}
.iml .iml-option.iml-right{border-color:var(--ok);background:var(--ok-soft)}.iml .iml-option.iml-right .iml-mark{border-color:var(--ok);background:var(--ok);box-shadow:inset 0 0 0 4px #fff}
.iml .iml-option.iml-wrong{border-color:var(--bad);background:var(--bad-soft)}.iml .iml-option.iml-wrong .iml-mark{border-color:var(--bad);background:var(--bad);box-shadow:inset 0 0 0 4px #fff}
.iml .iml-locked .iml-option{cursor:default}
.iml .iml-opt-text{flex:1;min-width:0}
.iml .iml-feedback{margin-top:12px;padding:12px 14px;border-radius:10px;font-size:.95em}
.iml .iml-feedback.iml-ok{background:var(--ok-soft);color:#14532d}.iml .iml-feedback.iml-no{background:var(--bad-soft);color:#7f1d1d}
.iml .iml-feedback strong{display:block;margin-bottom:2px}
.iml .iml-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px;margin-top:16px}
.iml .iml-actions.iml-left{justify-content:flex-start}
.iml .iml-result{padding:28px 18px;text-align:center}
.iml .iml-result-score{font:800 44px/1 var(--hfont);color:var(--ink);margin:8px 0}
.iml .iml-result .iml-ico svg{width:42px;height:42px;color:#f59e0b}
.iml .iml-result p{margin:0 0 16px;color:var(--muted)}
.iml .iml-meter{height:8px;border-radius:9px;background:#eef2f7;overflow:hidden;max-width:280px;margin:0 auto 18px}.iml .iml-meter i{display:block;height:100%;background:var(--ok);border-radius:9px}
.iml .iml-qcard{padding:clamp(16px,2.8cqi,22px)}
.iml .iml-qcard-top{display:flex;gap:12px;align-items:flex-start}
.iml .iml-qcard-ico{flex:none;display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:#fff6e5;color:#d97706}.iml .iml-qcard-ico svg{width:20px;height:20px}
.iml .iml-qcard-q{flex:1;font-weight:700;font-size:1.06em;line-height:1.5;color:var(--ink)}
.iml .iml-answer{margin-top:14px;padding:14px 16px;border-radius:10px;background:var(--ok-soft);color:#14532d}
.iml .iml-answer-label{display:block;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;opacity:.75}
.iml-edit .iml-answer{border:1px dashed #86d6a6}
.iml .iml-input{width:100%;min-height:44px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:var(--ink);font:inherit;margin:0;box-shadow:none}
.iml .iml-input:focus{outline:none;border-color:var(--a);box-shadow:0 0 0 3px color-mix(in srgb,var(--a) 22%,transparent)}
.iml .iml-row{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}.iml .iml-row .iml-input{flex:1;min-width:180px}
.iml .iml-hintbox{margin-top:12px;padding:10px 14px;border-radius:10px;background:#fff7e6;color:#6b4206;font-size:.94em}
.iml .iml-timeline{position:relative;list-style:none;margin:0;padding:0 0 0 30px}
.iml .iml-timeline::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;background:var(--line)}
.iml .iml-timeline li{position:relative;margin:0 0 22px;padding:0;list-style:none}.iml .iml-timeline li:last-child{margin-bottom:0}
.iml .iml-timeline li::before{content:"";position:absolute;left:-27px;top:5px;width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid var(--a)}
.iml .iml-tl-date{display:inline-block;padding:2px 9px;margin-bottom:5px;border-radius:999px;background:var(--a-soft);color:var(--a-ink);font-size:12.5px;font-weight:700}
.iml .iml-tl-title{font-weight:700;font-size:1.05em;color:var(--ink)}
.iml .iml-tl-text{margin-top:3px;color:#475569;font-size:.96em}
.iml .iml-gallery{position:relative;border-radius:var(--r);overflow:hidden;background:#0f172a}
.iml .iml-gallery-track{display:flex;transition:transform .35s ease}
.iml .iml-slide{flex:0 0 100%;position:relative;height:var(--gh,380px);margin:0}
.iml .iml-slide img{width:100%;height:100%;object-fit:cover;display:block;margin:0;border:0;padding:0;border-radius:0;cursor:zoom-in}
.iml .iml-slide figcaption{position:absolute;left:0;right:0;bottom:0;padding:26px 16px 12px;background:linear-gradient(transparent,#0009);color:#fff;font-size:14px}
.iml .iml-slide figcaption:empty{display:none}
.iml .iml-gnav{position:absolute;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:40px;height:40px;padding:0;border:0;border-radius:50%;background:#fffe;color:#0f172a;cursor:pointer;box-shadow:0 2px 10px #0003;z-index:3}
.iml .iml-gnav svg{width:20px;height:20px}.iml .iml-gnav.iml-prev{left:10px}.iml .iml-gnav.iml-next{right:10px}
.iml .iml-dots{position:absolute;left:0;right:0;bottom:8px;display:flex;justify-content:center;gap:6px;z-index:3}
.iml .iml-dots button{width:8px;height:8px;min-height:0;padding:0;border:0;border-radius:9px;background:#fff8;cursor:pointer;transition:width .2s}
.iml .iml-dots button.iml-on{width:22px;background:#fff}
.iml .iml-file{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid var(--line);border-radius:var(--r);background:#fff;text-align:left}
.iml .iml-file-ico{flex:none;position:relative;display:grid;place-items:center;width:48px;height:54px;border-radius:10px;background:#eef4ff;color:#1d4ed8}
.iml .iml-file-ico svg{width:26px;height:26px}.iml .iml-file-ext{position:absolute;bottom:4px;font-size:9px;font-weight:800;letter-spacing:.04em}
.iml .iml-file-main{flex:1;min-width:0}.iml .iml-file-name{font-weight:700;color:var(--ink);word-break:break-word}.iml .iml-file-desc{font-size:.9em;color:var(--muted)}
.iml .iml-katex{display:block;padding:6px 0;overflow-x:auto;overflow-y:hidden;text-align:center;font-size:var(--msize,1.25em);color:var(--ink)}
.iml .iml-block[data-align=left] .iml-katex .katex-display{text-align:left}.iml .iml-block[data-align=left] .iml-katex .katex-display>.katex{text-align:left}
.iml .iml-chart{position:relative;width:100%;height:var(--ch,320px)}
.iml .iml-chart-title{font-weight:700;margin-bottom:8px;text-align:center}
.iml .iml-code{border-radius:12px;overflow:hidden;border:1px solid #1e293b;background:#0f172a;color:#e2e8f0;text-align:left}
.iml .iml-code-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1e293b;color:#94a3b8;font:600 12.5px/1.3 var(--font)}
.iml .iml-code-head span{flex:1}
.iml .iml-code-head button{display:inline-flex;align-items:center;gap:5px;min-height:0;padding:4px 8px;border:0;border-radius:6px;background:#334155;color:#e2e8f0;font:600 12px var(--font);cursor:pointer}
.iml .iml-code-head button svg{width:14px;height:14px}
.iml .iml-code pre{margin:0;padding:14px 16px;overflow:auto;background:none;border:0;max-height:560px}
.iml .iml-code code{display:block;font:13.5px/1.6 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;white-space:pre;color:#e2e8f0;background:none;padding:0;tab-size:4}
.iml .iml-code .hljs{background:none;color:#e2e8f0;padding:0}
.iml .iml-code .hljs-keyword,.iml .iml-code .hljs-built_in,.iml .iml-code .hljs-selector-tag{color:#c792ea}.iml .iml-code .hljs-string,.iml .iml-code .hljs-attr{color:#c3e88d}
.iml .iml-code .hljs-number,.iml .iml-code .hljs-literal{color:#f78c6c}.iml .iml-code .hljs-comment{color:#64748b;font-style:italic}
.iml .iml-code .hljs-title,.iml .iml-code .hljs-function{color:#82aaff}.iml .iml-code .hljs-params,.iml .iml-code .hljs-variable{color:#e2e8f0}
.iml .iml-table-wrap{position:relative;overflow-x:auto;overflow-y:hidden;border:1px solid var(--line);border-radius:12px;background:#fff}
.iml .iml-table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:.95em}
.iml .iml-table th,.iml .iml-table td{padding:10px 14px;border:0;border-bottom:1px solid var(--line);text-align:inherit;vertical-align:top;background:none;color:#334155;overflow-wrap:anywhere}
.iml .iml-table th:empty::after,.iml .iml-table td:empty::after{content:"\\200b"}
.iml .iml-table-auto{table-layout:auto;width:auto;max-width:100%}
.iml .iml-table-auto th,.iml .iml-table-auto td{overflow-wrap:normal;word-break:normal;min-width:4em}
.iml .iml-table-wrap.iml-table-wrap-auto{width:fit-content;max-width:100%}
.iml .iml-block[data-align=center] .iml-table-wrap-auto{margin-inline:auto}.iml .iml-block[data-align=right] .iml-table-wrap-auto{margin-left:auto}
.iml .iml-table-resizer{position:absolute;touch-action:none;z-index:2;padding:0;border:0;background:transparent}
.iml .iml-table-column-resizer{top:0;bottom:0;width:10px;transform:translateX(-50%);cursor:col-resize}
.iml .iml-table-row-resizer{left:0;right:0;height:8px;transform:translateY(-50%);cursor:row-resize}
.iml .iml-table-resizer::after{content:"";position:absolute;background:transparent}
.iml .iml-table-column-resizer::after{left:4px;top:0;bottom:0;width:1px}
.iml .iml-table-row-resizer::after{left:0;right:0;top:3px;height:1px}
.iml .iml-table-resizer:hover::after,.iml .iml-table-resizer:focus-visible::after{background:#94a3b8}
.iml-table-guide{position:fixed;pointer-events:none;z-index:2147483290}
.iml-table-guide-column{top:0;bottom:0;border-left:1px dashed #64748b}
.iml-table-guide-row{left:0;right:0;border-top:1px dashed #64748b}
.iml .iml-table th{background:#f6f9fc;font-weight:700;color:var(--ink)}
.iml .iml-table tr:last-child td{border-bottom:0}
.iml .iml-table.iml-striped tbody tr:nth-child(even) td{background:#fafcfe}
.iml .iml-table td+td,.iml .iml-table th+th{border-left:1px solid var(--line)}
.iml .iml-embed{position:relative;width:100%;height:var(--eh,480px);border-radius:var(--r);overflow:hidden;border:1px solid var(--line);background:#fff}
.iml .iml-embed iframe{position:absolute;left:0;top:0;display:block;width:100%;height:100%;border:0;margin:0}
.iml .iml-embed-frame{width:100%;min-width:0}
.iml .iml-embed-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:8px}
.iml .iml-embed-frame:fullscreen{display:flex;flex-direction:column;background:#fff;padding:12px}
.iml .iml-embed-frame:fullscreen .iml-embed{flex:1;min-height:0;height:auto!important;aspect-ratio:auto!important}

.iml .iml-blanks{padding:clamp(16px,2.8cqi,22px)}
.iml .iml-blanks-title{font-weight:700;margin-bottom:10px;color:var(--ink)}
.iml .iml-blanks-text{line-height:2.3;color:#334155}
.iml .iml-gap{display:inline-block;width:auto;min-width:3.5em;height:32px;margin:0 3px;padding:3px 8px;border:0;border-bottom:2px solid #94a3b8;border-radius:6px 6px 0 0;background:#f1f5f9;color:var(--ink);font:inherit;font-weight:600;text-align:center;vertical-align:baseline;box-shadow:none}
.iml .iml-gap:focus{outline:none;border-bottom-color:var(--a);background:var(--a-soft)}
.iml .iml-gap.iml-right{border-bottom-color:var(--ok);background:var(--ok-soft);color:#14532d}.iml .iml-gap.iml-wrong{border-bottom-color:var(--bad);background:var(--bad-soft);color:#7f1d1d}
.iml .iml-gap-chip{display:inline-block;margin:0 3px;padding:0 10px;border-bottom:2px solid var(--a);border-radius:6px 6px 0 0;background:var(--a-soft);color:var(--a-ink);font-weight:600;line-height:1.7}
.iml .iml-acc{border:1px solid var(--line);border-radius:12px;background:#fff;overflow:hidden}
.iml .iml-acc-sum{display:flex;align-items:center;gap:10px;padding:14px 16px;font-weight:700;color:var(--ink);cursor:pointer;list-style:none}
.iml .iml-acc-sum::-webkit-details-marker{display:none}
.iml .iml-acc-sum .iml-ico{margin-left:auto;transition:transform .2s;color:var(--muted)}.iml .iml-acc-sum .iml-ico svg{width:18px;height:18px}
.iml details[open]>.iml-acc-sum .iml-ico,.iml-edit .iml-acc-sum .iml-ico{transform:rotate(90deg)}
.iml .iml-acc-body{padding:0 16px 16px}
.iml-edit .iml-acc-sum{cursor:text}
.iml .iml-ico{display:inline-grid;place-items:center;line-height:0}.iml .iml-ico svg{width:20px;height:20px;display:block}
.iml .iml-progress{position:sticky;top:0;z-index:20;height:4px;background:#e2e8f0}.iml .iml-progress i{display:block;height:100%;width:0;background:var(--a);transition:width .3s}
.iml .iml-stepnav{display:flex;align-items:center;gap:12px;max-width:var(--maxw,1100px);margin:0 auto;padding:0 clamp(10px,2.5cqi,24px) 24px}
.iml .iml-stepnav .iml-steplabel{flex:1;text-align:center;color:var(--muted);font-size:14px;font-weight:600}
.iml .iml-finish{max-width:var(--maxw,1100px);margin:0 auto;padding:0 clamp(10px,2.5cqi,24px) 32px}
.iml .iml-finish-card{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:20px 22px;border-radius:18px;background:linear-gradient(135deg,var(--a-soft),#fff);border:1px solid var(--line)}
.iml .iml-finish-card .iml-ico{color:#f59e0b}.iml .iml-finish-card .iml-ico svg{width:34px;height:34px}
.iml .iml-finish-text{flex:1;min-width:200px}.iml .iml-finish-text strong{display:block;font-size:1.05em}.iml .iml-finish-text span{color:var(--muted);font-size:.93em}
.iml .iml-slot-empty{display:grid;place-items:center;min-height:84px;padding:14px;border:2px dashed #cbd5e1;border-radius:12px;color:#94a3b8;font-size:13.5px;text-align:center;background:#fbfcfe}
.iml-edit [data-edit]:empty::before{content:attr(data-ph);color:#a0aec0;pointer-events:none}
.iml-edit [data-edit]{outline:none;cursor:text}
.iml-edit a[data-edit]{cursor:text}
.iml-lightbox{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;background:#0f172ae6;cursor:zoom-out;animation:imlFade .2s}
.iml-lightbox img{max-width:100%;max-height:calc(100% - 50px);object-fit:contain;border-radius:8px;box-shadow:0 10px 40px #0008}
.iml-lightbox p{margin:0;color:#e2e8f0;font:15px/1.4 system-ui,sans-serif;text-align:center}
@keyframes imlFade{from{opacity:0}to{opacity:1}}
@keyframes imlPop{0%{transform:scale(.97);opacity:.6}100%{transform:none;opacity:1}}
.iml .iml-pop{animation:imlPop .25s ease}
@media print{.iml{background:#fff}.iml.iml-view{display:block;min-height:0}.iml .iml-section{box-shadow:none;break-inside:avoid-page}.iml .iml-progress,.iml .iml-stepnav,.iml .iml-finish,.iml .iml-gnav,.iml .iml-actions{display:none!important}.iml .iml-section[hidden]{display:block!important}}
@media (prefers-reduced-motion:reduce){.iml *{animation:none!important;transition:none!important}}
`;
  function injectCss() {
    if (doc.getElementById('iml-runtime-css')) return;
    const style = doc.createElement('style');
    style.id = 'iml-runtime-css';
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  /* ----------------------------------------------------------- normalize */
  function normBlock(b, depth) {
    if (!isObj(b) || typeof b.type !== 'string') return null;
    const out = { id: str(b.id) || uid('b'), type: b.type, props: isObj(b.props) ? b.props : {}, style: isObj(b.style) ? b.style : {} };
    const p = out.props;
    if (depth >= MAX_DEPTH) { if (p.blocks) p.blocks = []; if (p.columns) p.columns = []; return out; }
    if (Array.isArray(p.blocks)) p.blocks = p.blocks.map(x => normBlock(x, depth + 1)).filter(Boolean);
    if (Array.isArray(p.columns)) p.columns = p.columns.map(c => ({ blocks: arr(c && c.blocks).map(x => normBlock(x, depth + 1)).filter(Boolean) }));
    return out;
  }
  function normalize(input) {
    let lesson = input;
    if (typeof lesson === 'string') lesson = JSON.parse(lesson);
    if (isObj(lesson) && isObj(lesson.lesson) && !lesson.sections) lesson = lesson.lesson; // rekord biblioteki
    if (!isObj(lesson)) throw new Error('To nie jest plik lekcji InfoMatyki.');
    if (lesson.format && lesson.format !== FORMAT) throw new Error('Nieobsługiwany format pliku: ' + lesson.format);
    const out = {
      format: FORMAT,
      version: 1,
      id: str(lesson.id) || uid('lekcja'),
      title: str(lesson.title) || 'Lekcja bez tytułu',
      description: str(lesson.description),
      author: str(lesson.author),
      subject: str(lesson.subject),
      level: str(lesson.level),
      tags: arr(lesson.tags).map(str),
      createdAt: lesson.createdAt || new Date().toISOString(),
      updatedAt: lesson.updatedAt || new Date().toISOString(),
      theme: Object.assign({ accent: '#1677e6', bg: '#f4f7fb', font: 'dm', sections: 'cards', mode: 'scroll', maxWidth: 1100, progress: true, finish: true }, isObj(lesson.theme) ? lesson.theme : {}),
      sections: arr(lesson.sections).filter(isObj).map(s => ({
        id: str(s.id) || uid('s'),
        title: str(s.title),
        style: isObj(s.style) ? s.style : {},
        blocks: arr(s.blocks).map(b => normBlock(b, 0)).filter(Boolean)
      }))
    };
    if (!out.sections.length) out.sections.push({ id: uid('s'), title: 'Sekcja 1', style: {}, blocks: [] });
    return out;
  }

  /* --------------------------------------------------------- media helpers */
  function parseVideo(url) {
    const u = str(url).trim();
    if (!u) return null;
    let m = u.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i);
    if (m) {
      const t = u.match(/[?&](?:t|start)=(\d+)/);
      return { kind: 'iframe', src: 'https://www.youtube-nocookie.com/embed/' + m[1] + '?rel=0' + (t ? '&start=' + t[1] : '') };
    }
    m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
    if (m) return { kind: 'iframe', src: 'https://player.vimeo.com/video/' + m[1] };
    m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/i);
    if (m) return { kind: 'iframe', src: 'https://drive.google.com/file/d/' + m[1] + '/preview' };
    if (/^data:video\//i.test(u) || /\.(mp4|webm|ogg|mov)(\?|#|$)/i.test(u)) { const s = safeUrl(u, 'video'); return s ? { kind: 'video', src: s } : null; }
    const s = safeUrl(u, 'embed');
    return s ? { kind: 'iframe', src: s } : null;
  }
  function parseChartData(text) {
    const lines = str(text).split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { labels: [], series: [] };
    const sep = lines[0].indexOf('\t') >= 0 ? '\t' : lines[0].indexOf(';') >= 0 ? ';' : ',';
    const rows = lines.map(l => l.split(sep).map(c => c.trim()));
    const num = v => { const n = parseFloat(str(v).replace(/\s/g, '').replace(sep === ',' ? /$^/ : ',', '.')); return isFinite(n) ? n : null; };
    let header = rows[0];
    let body = rows.slice(1);
    if (header.slice(1).length && header.slice(1).every(c => num(c) !== null)) { body = rows; header = ['', ...rows[0].slice(1).map((_, i) => 'Seria ' + (i + 1))]; }
    const series = header.slice(1).map((name, i) => ({ name: name || 'Seria ' + (i + 1), values: body.map(r => num(r[i + 1])) }));
    return { labels: body.map(r => r[0]), series };
  }
  const PALETTE = ['#1677e6', '#22b07d', '#f59e0b', '#7c3aed', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#64748b', '#f97316'];

  function openLightbox(src, caption) {
    const box = h('div', { class: 'iml-lightbox', role: 'dialog', 'aria-label': 'Podgląd obrazu' }, h('img', { src, alt: caption || '' }), caption ? h('p', { text: caption }) : null);
    const close = () => { box.remove(); doc.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    box.addEventListener('click', close);
    doc.addEventListener('keydown', onKey);
    doc.body.appendChild(box);
  }

  function setPath(obj, path, value) {
    const keys = str(path).split('.');
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
      o = o[k];
    }
    o[keys[keys.length - 1]] = value;
  }
  function getPath(obj, path) {
    return str(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  /* ------------------------------------------------------------ renderers */
  function ed(ctx, path, kind, ph) {
    return ctx.edit ? { 'data-edit': path, 'data-kind': kind || 'inline', 'data-ph': ph || 'Wpisz tekst…' } : {};
  }
  function attrs(base, extra) { return Object.assign(base, extra); }

  function report(ctx, activity) {
    if (ctx.edit) return;
    const lesson = ctx.lesson;
    const detail = Object.assign({ lessonId: lesson.id, lessonTitle: lesson.title }, activity);
    try { ctx.rootEl.dispatchEvent(new CustomEvent('infomatyka-lesson:activity', { bubbles: true, detail })); } catch (_) {}
    try {
      const sdk = root.InfoMatykaSDK;
      if (sdk && typeof sdk.registerActivity === 'function') {
        sdk.registerActivity({ type: activity.type, name: activity.name, score: activity.score, maxScore: activity.maxScore, materialId: 'lekcja:' + lesson.id });
      }
    } catch (_) {}
  }

  const R = {};

  R.heading = (b, ctx) => {
    const p = b.props;
    const lvl = [1, 2, 3].indexOf(+p.level) >= 0 ? +p.level : 1;
    return [
      h('h' + lvl, attrs({ class: 'iml-h iml-h' + lvl + ' iml-tex', html: sanitizeInline(p.text) }, ed(ctx, 'text', 'inline', 'Nagłówek'))),
      (p.subtitle || (ctx.edit && p.showSubtitle)) ? h('p', attrs({ class: 'iml-sub iml-tex', html: sanitizeInline(p.subtitle) }, ed(ctx, 'subtitle', 'inline', 'Podtytuł'))) : null
    ];
  };

  R.text = (b, ctx) => h('div', attrs({ class: 'iml-rich iml-tex', html: sanitizeHtml(b.props.html) }, ed(ctx, 'html', 'rich', 'Zacznij pisać…')));

  R.list = (b, ctx) => {
    const p = b.props;
    const style = ['bullet', 'number', 'check', 'arrow'].indexOf(p.style) >= 0 ? p.style : 'bullet';
    const items = arr(p.items).length ? arr(p.items) : [''];
    return h(style === 'number' ? 'ol' : 'ul', { class: 'iml-list iml-list-' + style },
      items.map((it, i) => h('li', attrs({ class: 'iml-tex', html: sanitizeInline(it) }, ed(ctx, 'items.' + i, 'inline', 'Element listy'))))
    );
  };

  R.quote = (b, ctx) => h('blockquote', { class: 'iml-quote' },
    h('div', attrs({ class: 'iml-rich iml-tex', html: sanitizeHtml(b.props.html) }, ed(ctx, 'html', 'rich', 'Treść cytatu'))),
    (b.props.author || ctx.edit) ? h('cite', attrs({ text: str(b.props.author) }, ed(ctx, 'author', 'plain', 'Autor'))) : null
  );

  R.button = (b, ctx) => {
    const p = b.props;
    const variant = ['primary', 'outline', 'soft', 'ghost'].indexOf(p.variant) >= 0 ? p.variant : 'primary';
    const size = p.size === 'lg' ? ' iml-btn-lg' : p.size === 'sm' ? ' iml-btn-sm' : '';
    const href = safeUrl(p.url, 'link');
    const a = h('a', attrs({ class: 'iml-btn iml-btn-' + variant + size + (p.full ? ' iml-btn-full' : ''), href: href || null, role: href ? null : 'button' },
      ctx.edit ? {} : (p.newTab !== false && /^https?:/i.test(href) ? { target: '_blank', rel: 'noopener noreferrer' } : {})));
    a.append(h('span', attrs({ text: str(p.label) || (ctx.edit ? '' : 'Przycisk') }, ed(ctx, 'label', 'plain', 'Tekst przycisku'))));
    if (p.arrow) a.append(icon('right'));
    return a;
  };

  R.divider = b => {
    const v = b.props.variant || 'line';
    if (v === 'space') return h('div', { style: { height: (+b.props.size || 24) + 'px' } });
    return h('hr', { class: 'iml-hr iml-hr-' + v });
  };

  R.image = (b, ctx) => {
    const p = b.props;
    const src = safeUrl(p.src, 'image');
    if (!src) return ctx.edit ? h('div', { class: 'iml-placeholder' }, icon('image'), h('div', { text: 'Kliknij, aby dodać obraz (plik lub link)' })) : null;
    const img = h('img', { src, alt: str(p.alt), loading: 'lazy', decoding: 'async', style: { height: p.height ? p.height + 'px' : null, objectFit: p.height ? (p.fit || 'cover') : null } });
    const fig = h('figure', { class: 'iml-figure' + (p.zoom !== false && !ctx.edit ? ' iml-zoomable' : ''), style: { maxWidth: p.width ? p.width + '%' : null, '--img-r': p.radius != null && p.radius !== '' ? p.radius + 'px' : null } });
    const link = safeUrl(p.link, 'link');
    if (link && !ctx.edit) fig.append(h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, img));
    else fig.append(img);
    if (p.caption || ctx.edit) fig.append(h('figcaption', attrs({ class: 'iml-tex', html: sanitizeInline(p.caption) }, ed(ctx, 'caption', 'inline', 'Podpis (opcjonalnie)'))));
    if (!ctx.edit && !link && p.zoom !== false) img.addEventListener('click', () => openLightbox(src, htmlToText(p.caption)));
    return fig;
  };

  R.video = (b, ctx) => {
    const v = parseVideo(b.props.url);
    if (!v) return ctx.edit ? h('div', { class: 'iml-placeholder' }, icon('eye'), h('div', { text: 'Wklej link do YouTube, Vimeo, Google Drive lub pliku MP4' })) : null;
    const media = v.kind === 'video'
      ? h('video', { class: 'iml-video-el', src: v.src, controls: true, preload: 'metadata', playsinline: true })
      : h('div', { class: 'iml-ratio' }, h('iframe', { src: v.src, title: str(b.props.caption) || 'Wideo', loading: 'lazy', allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin' }));
    return [media, (b.props.caption || ctx.edit) ? h('div', attrs({ class: 'iml-caption iml-tex', html: sanitizeInline(b.props.caption) }, ed(ctx, 'caption', 'inline', 'Podpis (opcjonalnie)'))) : null];
  };

  R.audio = (b, ctx) => {
    const src = safeUrl(b.props.src, 'audio');
    return h('div', { class: 'iml-audio' },
      h('div', { class: 'iml-audio-ico' }, icon('music')),
      h('div', { class: 'iml-audio-main' },
        h('div', attrs({ class: 'iml-audio-title', text: str(b.props.title) }, ed(ctx, 'title', 'plain', 'Tytuł nagrania'))),
        src ? h('audio', { controls: true, preload: 'metadata', src }) : h('div', { class: 'iml-file-desc', text: ctx.edit ? 'Dodaj plik audio lub link w panelu po prawej' : 'Brak nagrania' })
      )
    );
  };

  function normCorrect(q) {
    const c = q && q.correct;
    if (Array.isArray(c)) return c.map(Number).filter(n => isFinite(n));
    if (c != null && c !== '' && isFinite(+c)) return [+c];
    return [0];
  }

  R.quiz = (b, ctx) => {
    const p = b.props;
    const qs = arr(p.questions).length ? arr(p.questions) : [{ q: '', options: ['', ''], correct: [0] }];
    const st = ctx.state(b.id, () => ({ i: 0, sel: {}, checked: {}, score: 0, done: false, reported: false }));
    const wrap = h('div', { class: 'iml-quiz' });

    function draw(anim) {
      wrap.replaceChildren();
      st.i = clamp(st.i, 0, qs.length - 1);
      const head = h('div', { class: 'iml-quiz-head' },
        h('span', { class: 'iml-quiz-badge' }, icon('quiz')),
        h('span', attrs({ class: 'iml-quiz-title', text: str(p.title) || (ctx.edit ? '' : 'Quiz') }, ed(ctx, 'title', 'plain', 'Quiz')))
      );
      if (ctx.edit && qs.length > 1) {
        head.append(h('span', { class: 'iml-quiz-nav' },
          h('button', { type: 'button', title: 'Poprzednie pytanie', 'data-ui': '1', onclick: () => { st.i = (st.i - 1 + qs.length) % qs.length; draw(); } }, icon('chevL')),
          h('button', { type: 'button', title: 'Następne pytanie', 'data-ui': '1', onclick: () => { st.i = (st.i + 1) % qs.length; draw(); } }, icon('chevR'))
        ));
      }
      head.append(h('span', { class: 'iml-quiz-count', text: st.done && !ctx.edit ? 'Wynik' : (st.i + 1) + ' z ' + qs.length }));
      wrap.append(head);

      if (st.done && !ctx.edit) {
        const ratio = qs.length ? st.score / qs.length : 0;
        const msg = ratio === 1 ? 'Perfekcyjnie! Wszystkie odpowiedzi poprawne.' : ratio >= .7 ? 'Świetna robota!' : ratio >= .4 ? 'Nieźle — warto jeszcze powtórzyć materiał.' : 'Spróbuj jeszcze raz — dasz radę!';
        wrap.append(h('div', { class: 'iml-result iml-pop' },
          icon('trophy'),
          h('div', { class: 'iml-result-score', text: st.score + ' / ' + qs.length }),
          h('div', { class: 'iml-meter' }, h('i', { style: { width: Math.round(ratio * 100) + '%' } })),
          h('p', { text: msg }),
          h('button', { type: 'button', class: 'iml-btn iml-btn-soft', onclick: () => { Object.assign(st, { i: 0, sel: {}, checked: {}, score: 0, done: false }); draw(true); } }, 'Spróbuj ponownie')
        ));
        if (!st.reported) {
          st.reported = true;
          report(ctx, { type: 'quiz', name: (str(p.title) || 'Quiz') + ' — ' + ctx.lesson.title, score: st.score, maxScore: qs.length, blockId: b.id });
        }
        return;
      }

      const qi = st.i;
      const q = qs[qi] || {};
      const multi = !!q.multiple;
      const correct = normCorrect(q);
      const opts = arr(q.options).length ? arr(q.options) : ['', ''];
      const checked = !!st.checked[qi];
      const sel = st.sel[qi] || [];
      const body = h('div', { class: 'iml-quiz-body' + (anim ? ' iml-pop' : '') });
      body.append(h('div', attrs({ class: 'iml-quiz-q iml-tex', html: sanitizeInline(q.q) }, ed(ctx, 'questions.' + qi + '.q', 'inline', 'Treść pytania'))));
      body.append(h('div', { class: 'iml-quiz-hint', text: ctx.edit ? (multi ? 'Kliknij kwadraty, aby zaznaczyć poprawne odpowiedzi.' : 'Kliknij kółko, aby wskazać poprawną odpowiedź.') : (multi ? 'Zaznacz wszystkie poprawne odpowiedzi.' : 'Wybierz jedną odpowiedź.') }));
      const list = h('div', { class: 'iml-options' + (multi ? ' iml-multi' : '') + (checked ? ' iml-locked' : ''), role: multi ? 'group' : 'radiogroup' });
      opts.forEach((opt, j) => {
        let cls = 'iml-option';
        if (ctx.edit) { if (correct.indexOf(j) >= 0) cls += ' iml-right'; }
        else if (checked) { if (correct.indexOf(j) >= 0) cls += ' iml-right'; else if (sel.indexOf(j) >= 0) cls += ' iml-wrong'; }
        else if (sel.indexOf(j) >= 0) cls += ' iml-sel';
        const text = h('span', attrs({ class: 'iml-opt-text iml-tex', html: sanitizeInline(opt) }, ed(ctx, 'questions.' + qi + '.options.' + j, 'inline', 'Odpowiedź ' + String.fromCharCode(65 + j))));
        if (ctx.edit) {
          const mark = h('span', { class: 'iml-mark', title: 'Oznacz jako poprawną', 'data-ui': '1', style: { cursor: 'pointer' } });
          mark.addEventListener('click', e => {
            e.stopPropagation();
            let next = multi ? (correct.indexOf(j) >= 0 ? correct.filter(x => x !== j) : correct.concat(j).sort()) : [j];
            if (!next.length) next = [j];
            ctx.change(b.id, 'questions.' + qi + '.correct', next);
          });
          list.append(h('div', { class: cls }, mark, text));
        } else {
          const input = h('input', { type: multi ? 'checkbox' : 'radio', name: b.id + '-' + qi, disabled: checked || null });
          if (sel.indexOf(j) >= 0) input.checked = true;
          input.addEventListener('change', () => {
            if (st.checked[qi]) return;
            let cur = st.sel[qi] || [];
            cur = multi ? (input.checked ? cur.concat(j) : cur.filter(x => x !== j)) : [j];
            st.sel[qi] = cur;
            draw();
            const again = wrap.querySelectorAll('.iml-option input')[j]; if (again) again.focus();
          });
          list.append(h('label', { class: cls }, input, h('span', { class: 'iml-mark' }), text));
        }
      });
      if (ctx.edit) {
        list.append(h('button', { type: 'button', class: 'iml-btn iml-btn-ghost iml-btn-sm', 'data-ui': '1', style: { justifySelf: 'start' }, onclick: () => ctx.change(b.id, 'questions.' + qi + '.options', opts.concat('')) }, '+ Dodaj odpowiedź'));
      }
      body.append(list);

      if (checked && !ctx.edit) {
        const ok = sel.length === correct.length && sel.every(x => correct.indexOf(x) >= 0);
        const fb = h('div', { class: 'iml-feedback iml-pop ' + (ok ? 'iml-ok' : 'iml-no') }, h('strong', { text: ok ? 'Brawo! To poprawna odpowiedź.' : 'Niestety, to nie jest poprawna odpowiedź.' }));
        if (q.explanation) fb.append(h('div', { class: 'iml-rich iml-tex', html: sanitizeHtml(q.explanation) }));
        body.append(fb);
      }
      const actions = h('div', { class: 'iml-actions' });
      if (ctx.edit) {
        actions.append(h('span', { class: 'iml-btn iml-btn-primary', 'data-ui': '1' }, h('span', { text: 'Sprawdź odpowiedź' }), icon('right')));
      } else if (!checked) {
        actions.append(h('button', { type: 'button', class: 'iml-btn iml-btn-primary', disabled: sel.length ? null : true, onclick: () => {
          st.checked[qi] = true;
          const ok = sel.length === correct.length && sel.every(x => correct.indexOf(x) >= 0);
          if (ok) st.score++;
          draw();
        } }, h('span', { text: 'Sprawdź odpowiedź' }), icon('right')));
      } else {
        const last = qi >= qs.length - 1;
        actions.append(h('button', { type: 'button', class: 'iml-btn iml-btn-primary', onclick: () => { if (last) st.done = true; else st.i++; draw(true); } }, h('span', { text: last ? 'Zobacz wynik' : 'Następne pytanie' }), icon('right')));
      }
      body.append(actions);
      wrap.append(body);
      typeset(wrap);
    }
    draw();
    return wrap;
  };

  function normAnswer(s) {
    return str(s).toLowerCase().replace(/\s+/g, ' ').replace(/,/g, '.').replace(/[.\s]+$/, '').trim();
  }

  R.question = (b, ctx) => {
    const p = b.props;
    const st = ctx.state(b.id, () => ({ open: false, hint: false, result: null, value: '' }));
    const card = h('div', { class: 'iml-qcard' });
    function draw() {
      card.replaceChildren(h('div', { class: 'iml-qcard-top' },
        h('span', { class: 'iml-qcard-ico' }, icon('help')),
        h('div', attrs({ class: 'iml-qcard-q iml-tex', html: sanitizeInline(p.q) }, ed(ctx, 'q', 'inline', 'Treść pytania')))
      ));
      if (ctx.edit) {
        card.append(h('div', { class: 'iml-answer' }, h('span', { class: 'iml-answer-label', text: p.mode === 'check' ? 'Poprawna odpowiedź (uczeń wpisuje ją w pole)' : 'Odpowiedź (pokazywana po kliknięciu)' }),
          h('div', attrs({ class: 'iml-rich iml-tex', html: sanitizeHtml(p.answer) }, ed(ctx, 'answer', p.mode === 'check' ? 'plain' : 'rich', 'Wpisz odpowiedź…')))));
        if (p.hint) card.append(h('div', { class: 'iml-hintbox' }, h('strong', { text: 'Podpowiedź: ' }), h('span', { class: 'iml-tex', html: sanitizeInline(p.hint) })));
        typeset(card);
        return;
      }
      if (p.mode === 'check') {
        const input = h('input', { class: 'iml-input', type: 'text', placeholder: 'Twoja odpowiedź…', 'aria-label': 'Twoja odpowiedź' });
        input.value = st.value;
        input.addEventListener('input', () => { st.value = input.value; });
        const check = () => {
          const accepted = [htmlToText(p.answer)].concat(str(p.accepted).split(';')).map(normAnswer).filter(Boolean);
          st.result = accepted.indexOf(normAnswer(st.value)) >= 0;
          if (st.result && !st.reported) { st.reported = true; report(ctx, { type: 'quiz', name: htmlToText(p.q).slice(0, 80) || 'Pytanie', score: 1, maxScore: 1, blockId: b.id }); }
          draw();
          const again = card.querySelector('.iml-input'); if (again) again.focus();
        };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
        card.append(h('div', { class: 'iml-row' }, input, h('button', { type: 'button', class: 'iml-btn iml-btn-primary', onclick: check }, 'Sprawdź')));
        if (st.result != null) {
          const fb = h('div', { class: 'iml-feedback iml-pop ' + (st.result ? 'iml-ok' : 'iml-no') }, h('strong', { text: st.result ? 'Dobrze!' : 'Jeszcze nie — spróbuj ponownie.' }));
          if (st.result && p.explain) fb.append(h('div', { class: 'iml-rich iml-tex', html: sanitizeHtml(p.explain) }));
          card.append(fb);
        }
      }
      const actions = h('div', { class: 'iml-actions iml-left' });
      if (p.hint) actions.append(h('button', { type: 'button', class: 'iml-btn iml-btn-ghost iml-btn-sm', onclick: () => { st.hint = !st.hint; draw(); } }, st.hint ? 'Ukryj podpowiedź' : 'Podpowiedź'));
      if (p.mode !== 'check' || st.result === false || st.open) {
        actions.append(h('button', { type: 'button', class: 'iml-btn ' + (p.mode === 'check' ? 'iml-btn-ghost iml-btn-sm' : 'iml-btn-soft'), onclick: () => { st.open = !st.open; draw(); } }, icon('eye'), st.open ? 'Ukryj odpowiedź' : 'Pokaż odpowiedź'));
      }
      if (actions.childNodes.length) card.append(actions);
      if (st.hint && p.hint) card.append(h('div', { class: 'iml-hintbox iml-pop' }, h('span', { class: 'iml-tex', html: sanitizeInline(p.hint) })));
      if (st.open) card.append(h('div', { class: 'iml-answer iml-pop' }, h('span', { class: 'iml-answer-label', text: 'Odpowiedź' }), h('div', { class: 'iml-rich iml-tex', html: sanitizeHtml(p.answer) })));
      typeset(card);
    }
    draw();
    return card;
  };

  R.timeline = (b, ctx) => {
    const items = arr(b.props.items).length ? arr(b.props.items) : [{ date: '', title: '', text: '' }];
    return h('ol', { class: 'iml-timeline' }, items.map((it, i) => h('li', null,
      (it.date || ctx.edit) ? h('span', attrs({ class: 'iml-tl-date', text: str(it.date) }, ed(ctx, 'items.' + i + '.date', 'plain', 'Data'))) : null,
      h('div', attrs({ class: 'iml-tl-title iml-tex', html: sanitizeInline(it.title) }, ed(ctx, 'items.' + i + '.title', 'inline', 'Wydarzenie'))),
      (it.text || ctx.edit) ? h('div', attrs({ class: 'iml-tl-text iml-tex', html: sanitizeInline(it.text) }, ed(ctx, 'items.' + i + '.text', 'inline', 'Opis (opcjonalnie)'))) : null
    )));
  };

  R.gallery = (b, ctx) => {
    const imgs = arr(b.props.images).map(x => ({ src: safeUrl(x && x.src, 'image'), caption: str(x && x.caption) })).filter(x => x.src);
    if (!imgs.length) return ctx.edit ? h('div', { class: 'iml-placeholder' }, icon('image'), h('div', { text: 'Dodaj zdjęcia do galerii w panelu po prawej' })) : null;
    const st = ctx.state(b.id, () => ({ i: 0 }));
    st.i = clamp(st.i, 0, imgs.length - 1);
    const track = h('div', { class: 'iml-gallery-track' });
    const dots = h('div', { class: 'iml-dots' });
    imgs.forEach((im, j) => {
      const img = h('img', { src: im.src, alt: im.caption, loading: 'lazy' });
      if (!ctx.edit) img.addEventListener('click', () => openLightbox(im.src, im.caption));
      track.append(h('figure', { class: 'iml-slide' }, img, h('figcaption', { text: im.caption })));
      dots.append(h('button', { type: 'button', 'aria-label': 'Zdjęcie ' + (j + 1), 'data-ui': '1', onclick: () => go(j) }));
    });
    function go(n) {
      st.i = (n + imgs.length) % imgs.length;
      track.style.transform = 'translateX(' + (-100 * st.i) + '%)';
      Array.from(dots.children).forEach((d, j) => d.classList.toggle('iml-on', j === st.i));
    }
    const g = h('div', { class: 'iml-gallery', style: { '--gh': (+b.props.height || 380) + 'px' } }, track);
    if (imgs.length > 1) {
      g.append(h('button', { type: 'button', class: 'iml-gnav iml-prev', 'aria-label': 'Poprzednie', 'data-ui': '1', onclick: () => go(st.i - 1) }, icon('chevL')));
      g.append(h('button', { type: 'button', class: 'iml-gnav iml-next', 'aria-label': 'Następne', 'data-ui': '1', onclick: () => go(st.i + 1) }, icon('chevR')));
      g.append(dots);
      let x0 = null;
      g.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
      g.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) go(st.i + (dx < 0 ? 1 : -1)); x0 = null; });
    }
    go(st.i);
    return g;
  };

  function fmtSize(n) { n = +n; if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0).replace('.', ',') + ' ' + u[i]; }
  R.file = (b, ctx) => {
    const p = b.props;
    const href = safeUrl(p.url, 'file');
    const name = str(p.name) || 'Plik';
    const ext = (str(p.fileName || p.name).match(/\.([a-z0-9]{1,5})$/i) || str(p.url).match(/\.([a-z0-9]{1,5})(?:\?|#|$)/i) || [])[1] || '';
    const meta = [str(p.description), fmtSize(p.size)].filter(Boolean).join(' · ');
    const btn = h('a', attrs({ class: 'iml-btn iml-btn-primary iml-btn-sm', href: href || null, download: /^data:|^blob:/i.test(href) ? (str(p.fileName) || name) : null }, (!ctx.edit && /^https?:/i.test(href)) ? { target: '_blank', rel: 'noopener noreferrer' } : {}), icon('download'), 'Pobierz');
    if (!href) btn.setAttribute('aria-disabled', 'true');
    return h('div', { class: 'iml-file' },
      h('div', { class: 'iml-file-ico' }, icon('file'), ext ? h('span', { class: 'iml-file-ext', text: ext.toUpperCase() }) : null),
      h('div', { class: 'iml-file-main' },
        h('div', attrs({ class: 'iml-file-name', text: name }, ed(ctx, 'name', 'plain', 'Nazwa pliku'))),
        h('div', { class: 'iml-file-desc', text: meta || (ctx.edit && !href ? 'Dodaj plik lub link w panelu po prawej' : '') })
      ),
      btn
    );
  };

  function slot(ctx, blocks, slotId, depth, emptyText) {
    const el = h('div', { class: 'iml-slot', 'data-slot': slotId });
    arr(blocks).forEach(b => { const n = renderBlock(b, ctx, depth + 1); if (n) el.append(n); });
    if (ctx.edit && !arr(blocks).length) el.append(h('div', { class: 'iml-slot-empty', text: emptyText || 'Przeciągnij tutaj element z lewego panelu' }));
    return el;
  }

  function ratioParts(ratio) {
    const parts = str(ratio || '1-1').split('-').map(Number).filter(n => n > 0);
    return parts.length ? parts.slice(0, 4) : [1, 1];
  }
  R.columns = (b, ctx, depth) => {
    const p = b.props;
    const parts = ratioParts(p.ratio);
    const cols = arr(p.columns);
    const grid = h('div', { class: 'iml-cols' + (p.stack === false ? '' : ' iml-stack'), style: { gridTemplateColumns: parts.map(n => 'minmax(0,' + n + 'fr)').join(' '), '--gap': (p.gap != null && p.gap !== '' ? +p.gap : 24) + 'px', '--valign': p.valign || 'start' } });
    parts.forEach((_, i) => grid.append(slot(ctx, cols[i] && cols[i].blocks, b.id + ':' + i, depth, 'Kolumna ' + (i + 1) + ' — przeciągnij tu element')));
    return grid;
  };
  R.card = (b, ctx, depth) => h('div', { class: 'iml-card iml-card-' + (b.props.variant || 'default') }, slot(ctx, b.props.blocks, b.id + ':0', depth, 'Karta — przeciągnij tu elementy'));
  R.container = (b, ctx, depth) => slot(ctx, b.props.blocks, b.id + ':0', depth, 'Kontener — przeciągnij tu elementy');

  const CALLOUT_ICON = { tip: 'bulb', info: 'info', warning: 'alert', success: 'check', note: 'book', danger: 'alert' };
  R.callout = (b, ctx) => {
    const v = CALLOUT_ICON[b.props.variant] ? b.props.variant : 'tip';
    return h('div', { class: 'iml-callout iml-callout-' + v },
      icon(CALLOUT_ICON[v]),
      h('div', { class: 'iml-callout-body' },
        (b.props.title || (ctx.edit && b.props.showTitle)) ? h('div', attrs({ class: 'iml-callout-title iml-tex', html: sanitizeInline(b.props.title) }, ed(ctx, 'title', 'inline', 'Tytuł'))) : null,
        h('div', attrs({ class: 'iml-rich iml-tex', html: sanitizeHtml(b.props.html) }, ed(ctx, 'html', 'rich', 'Treść wskazówki')))
      )
    );
  };

  R.math = (b, ctx) => {
    const latex = str(b.props.latex);
    if (!latex.trim()) return ctx.edit ? h('div', { class: 'iml-placeholder', style: { minHeight: '90px' } }, h('div', { text: 'Wpisz wzór w panelu po prawej (edytor MathLive)' })) : null;
    return h('div', { class: 'iml-katex', 'data-latex': latex, style: { '--msize': b.props.size ? b.props.size + 'em' : null }, text: latex });
  };

  R.chart = (b, ctx) => {
    const p = b.props;
    const wrap = h('div', null);
    if (p.title) wrap.append(h('div', { class: 'iml-chart-title', text: str(p.title) }));
    const canvas = h('canvas', { role: 'img', 'aria-label': str(p.title) || 'Wykres' });
    wrap.append(h('div', { class: 'iml-chart', style: { '--ch': (+p.height || 320) + 'px' } }, canvas));
    const data = parseChartData(p.data);
    const type = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'hbar'].indexOf(p.chartType) >= 0 ? p.chartType : 'bar';
    ensureChart().then(() => {
      requestAnimationFrame(() => {
        if (!root.Chart) return;
        const round = type === 'pie' || type === 'doughnut' || type === 'polarArea';
        const colors = str(p.colors).split(/[\s,;]+/).filter(c => /^#[0-9a-f]{3,8}$/i.test(c));
        const pal = colors.length ? colors : PALETTE;
        const pointColors = arr(p.pointColors);
        const perPoint = round || data.series.length === 1 && (type === 'bar' || type === 'hbar');
        const pointColor = j => /^#[0-9a-f]{6}$/i.test(pointColors[j] || '') ? pointColors[j] : pal[j % pal.length];
        const chart = new root.Chart(canvas, {
          type: type === 'hbar' ? 'bar' : type,
          data: {
            labels: data.labels,
            datasets: data.series.map((s, i) => ({
              label: s.name, data: s.values,
              backgroundColor: perPoint ? data.labels.map((_, j) => pointColor(j)) : (type === 'line' || type === 'radar' ? pal[i % pal.length] + '33' : pal[i % pal.length]),
              borderColor: round ? '#fff' : perPoint ? data.labels.map((_, j) => pointColor(j)) : pal[i % pal.length], borderWidth: 2, tension: .35, fill: type === 'radar', borderRadius: type === 'bar' || type === 'hbar' ? 6 : 0, pointRadius: 3
            }))
          },
          options: {
            responsive: true, maintainAspectRatio: false, indexAxis: type === 'hbar' ? 'y' : 'x', animation: ctx.edit ? false : undefined,
            plugins: { legend: { display: p.legend !== false && (round || data.series.length > 1), position: 'bottom' } },
            scales: round || type === 'radar' ? undefined : { y: { beginAtZero: true, grid: { color: '#eef2f7' } }, x: { grid: { display: false } } }
          }
        });
        canvas._imlChart = chart;
      });
    }).catch(() => { wrap.append(h('div', { class: 'iml-file-desc', text: 'Nie udało się wczytać biblioteki wykresów.' })); });
    return wrap;
  };

  R.code = (b, ctx) => {
    const p = b.props;
    const lang = str(p.language).toLowerCase().replace(/[^a-z0-9+#-]/g, '');
    const code = h('code', attrs({ class: lang ? 'language-' + lang : '', text: str(p.code) }, ed(ctx, 'code', 'code', 'Wpisz kod…')));
    const copyBtn = h('button', { type: 'button', 'data-ui': '1', onclick: () => {
      const done = () => { copyBtn.lastChild.textContent = 'Skopiowano'; setTimeout(() => { copyBtn.lastChild.textContent = 'Kopiuj'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(str(p.code)).then(done, () => {}); } }, icon('copy'), h('span', { text: 'Kopiuj' }));
    const box = h('div', { class: 'iml-code iml-no-math' },
      h('div', { class: 'iml-code-head' }, h('span', { text: str(p.title) || LANGS[lang] || lang || 'Kod' }), ctx.edit ? null : copyBtn),
      h('pre', null, code)
    );
    if (lang && lang !== 'text' && str(p.code).trim()) ensureHljs().then(() => { if (root.hljs && code.getAttribute('contenteditable') == null) { try { root.hljs.highlightElement(code); } catch (_) {} } }).catch(() => {});
    return box;
  };
  const LANGS = { python: 'Python', javascript: 'JavaScript', html: 'HTML', css: 'CSS', cpp: 'C++', c: 'C', java: 'Java', csharp: 'C#', pascal: 'Pascal', sql: 'SQL', bash: 'Bash', json: 'JSON', php: 'PHP', text: 'Tekst' };

  function tableColumnWidths(widths, count) {
    const values = Array.from({ length: count }, (_, i) => +arr(widths)[i]);
    if (values.some(value => !Number.isFinite(value) || value <= 0)) return values.map(() => 100 / count);
    const total = values.reduce((sum, value) => sum + value, 0);
    return values.map(value => value * 100 / total);
  }
  function tableResizers(wrap, table, onChange) {
    const handles = [];
    const rows = Array.from(table.rows);
    const count = rows[0].cells.length;
    let drag = null;
    function measurements() {
      const rect = table.getBoundingClientRect();
      const scale = rect.width / Math.max(1, table.offsetWidth);
      return {
        rect, scale,
        widths: Array.from(rows[0].cells, cell => cell.getBoundingClientRect().width / Math.max(1, rect.width) * 100),
        heights: rows.map(row => row.getBoundingClientRect().height / Math.max(.01, scale))
      };
    }
    function position() {
      if (!table.isConnected || drag) return;
      const m = measurements(), wrapRect = wrap.getBoundingClientRect();
      let offset = 0;
      handles.filter(item => item.axis === 'column').forEach(item => {
        offset += m.widths[item.index]; item.handle.style.left = offset + '%';
        item.handle.setAttribute('aria-valuenow', String(Math.round(m.widths[item.index])));
      });
      handles.filter(item => item.axis === 'row').forEach(item => {
        item.handle.style.top = (rows[item.index].getBoundingClientRect().bottom - wrapRect.top) / Math.max(.01, m.scale) - wrap.clientTop + 'px';
        item.handle.setAttribute('aria-valuenow', String(Math.round(m.heights[item.index])));
      });
    }
    function update(axis, index, original, delta, m) {
      const values = original.slice();
      if (axis === 'column') {
        const total = original[index] + original[index + 1];
        const min = Math.min(48 / Math.max(1, m.rect.width) * 100, total / 4);
        values[index] = Math.max(min, Math.min(total - min, original[index] + delta));
        values[index + 1] = total - values[index];
      } else values[index] = clamp(original[index] + delta, 32, 2000);
      return values;
    }
    function addHandle(axis, index) {
      const column = axis === 'column';
      const handle = h('button', { class: 'iml-table-resizer iml-table-' + axis + '-resizer', type: 'button', 'data-le': '1', ['data-' + axis + '-index']: index,
        role: 'separator', 'aria-orientation': column ? 'vertical' : 'horizontal', 'aria-valuemin': column ? 0 : 32, 'aria-valuemax': column ? 100 : 2000,
        'aria-label': (column ? 'Szerokość kolumny ' : 'Wysokość wiersza ') + (index + 1), title: column ? 'Przeciągnij granicę kolumny' : 'Przeciągnij granicę wiersza' });
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        const m = measurements(), original = column ? m.widths : m.heights;
        const guide = h('div', { class: 'iml-table-guide iml-table-guide-' + axis, 'aria-hidden': 'true' });
        doc.body.append(guide);
        const boundary = column ? rows[0].cells[index].getBoundingClientRect().right : rows[index].getBoundingClientRect().bottom;
        guide.style[column ? 'left' : 'top'] = boundary + 'px';
        drag = { pointerId: event.pointerId, axis, index, m, original, values: original.slice(), start: column ? event.clientX : event.clientY, boundary, guide };
        handle.setPointerCapture(event.pointerId); handle.classList.add('iml-resizing');
      });
      handle.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const delta = column ? (event.clientX - drag.start) * 100 / Math.max(1, drag.m.rect.width) : (event.clientY - drag.start) / Math.max(.01, drag.m.scale);
        drag.values = update(axis, index, drag.original, delta, drag.m);
        const distance = drag.values[index] - drag.original[index];
        drag.guide.style[column ? 'left' : 'top'] = drag.boundary + distance * (column ? drag.m.rect.width / 100 : drag.m.scale) + 'px';
      });
      function finish(event) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const result = drag; drag = null;
        result.guide.remove(); handle.classList.remove('iml-resizing');
        if (event.type === 'pointerup' && result.values.some((value, i) => Math.abs(value - result.original[i]) > .001)) onChange(axis, result.values);
        else position();
      }
      handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish); handle.addEventListener('lostpointercapture', finish);
      handle.addEventListener('keydown', event => {
        const backward = column ? 'ArrowLeft' : 'ArrowUp', forward = column ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== backward && event.key !== forward) return;
        event.preventDefault(); event.stopPropagation();
        const m = measurements(), original = column ? m.widths : m.heights;
        onChange(axis, update(axis, index, original, (event.key === forward ? 1 : -1) * (event.shiftKey ? 5 : 1), m), index);
      });
      handles.push({ axis, index, handle }); wrap.append(handle);
    }
    for (let i = 0; i < count - 1; i++) addHandle('column', i);
    rows.forEach((_, i) => addHandle('row', i));
    const observer = root.ResizeObserver ? new ResizeObserver(position) : null;
    if (observer) { observer.observe(table); Array.from(rows[0].cells).forEach(cell => observer.observe(cell)); }
    const frame = requestAnimationFrame(position);
    wrap.setAttribute('data-iml-managed', '1');
    wrap._imlDispose = () => { if (observer) observer.disconnect(); cancelAnimationFrame(frame); if (drag) drag.guide.remove(); drag = null; };
  }
  R.table = (b, ctx) => {
    const p = b.props;
    const rows = arr(p.rows).length ? arr(p.rows) : [['', ''], ['', '']];
    const ncol = Math.max.apply(null, rows.map(r => arr(r).length).concat(1));
    const table = h('table', { class: 'iml-table' + (p.autoFit ? ' iml-table-auto' : '') + (p.striped !== false ? ' iml-striped' : '') });
    const widths = tableColumnWidths(p.columnWidths, ncol);
    table.append(h('colgroup', null, widths.map(width => h('col', { style: { width: p.autoFit ? null : width + '%' } }))));
    const mk = (tag, ri, ci) => {
      const style = getPath(p, 'cellStyles.' + ri + '.' + ci) || {};
      return h(tag, attrs({ class: 'iml-tex', html: sanitizeInline(arr(rows[ri])[ci]), style: {
        textAlign: ['left', 'center', 'right', 'justify'].includes(style.textAlign) ? style.textAlign : null,
        verticalAlign: ['top', 'middle', 'bottom'].includes(style.verticalAlign) ? style.verticalAlign : null
      } }, ed(ctx, 'rows.' + ri + '.' + ci, 'inline', ' ')));
    };
    let start = 0;
    if (p.header !== false) {
      table.append(h('thead', null, h('tr', { style: { height: +arr(p.rowHeights)[0] > 0 ? clamp(+p.rowHeights[0], 32, 2000) + 'px' : null } }, Array.from({ length: ncol }, (_, ci) => mk('th', 0, ci)))));
      start = 1;
    }
    const tbody = h('tbody');
    for (let ri = start; ri < rows.length; ri++) tbody.append(h('tr', { style: { height: +arr(p.rowHeights)[ri] > 0 ? clamp(+p.rowHeights[ri], 32, 2000) + 'px' : null } }, Array.from({ length: ncol }, (_, ci) => mk('td', ri, ci))));
    table.append(tbody);
    const wrap = h('div', { class: 'iml-table-wrap' + (p.autoFit ? ' iml-table-wrap-auto' : '') }, table);
    if (ctx.edit) tableResizers(wrap, table, (axis, value, focusIndex) => {
      if (axis === 'column') p.autoFit = false;
      ctx.change(b.id, axis === 'column' ? 'columnWidths' : 'rowHeights', value);
      if (focusIndex != null) requestAnimationFrame(() => {
        const block = Array.from(ctx.rootEl.querySelectorAll('[data-block-id]')).find(el => el.getAttribute('data-block-id') === b.id);
        const handle = block && block.querySelector('[data-' + axis + '-index="' + focusIndex + '"]');
        if (handle) handle.focus();
      });
    });
    return [wrap, (p.caption || ctx.edit) ? h('div', attrs({ class: 'iml-caption', text: str(p.caption) }, ed(ctx, 'caption', 'plain', 'Podpis tabeli (opcjonalnie)'))) : null];
  };

  function parseEmbed(value, props) {
    let url = str(value).trim(), width = 0, height = 0;
    if (/<iframe\b/i.test(url)) {
      const template = doc.createElement('template'); template.innerHTML = url;
      const frame = template.content.querySelector('iframe');
      if (!frame) return null;
      url = frame.getAttribute('src') || '';
      width = +frame.getAttribute('width'); height = +frame.getAttribute('height');
    }
    const src = safeUrl(url, 'embed'); if (!src) return null;
    let address; try { address = new URL(src); } catch (_) { return null; }
    const host = address.hostname.toLowerCase();
    const ratio = ['16/9', '4/3', '1/1'].includes(props.ratio) ? props.ratio.split('/').map(Number) : null;
    if (host === 'canva.com' || host === 'www.canva.com') {
      if (!/^\/design\/[a-z0-9_-]{6,64}(?:\/[^/]+)?\/(?:view|edit)\/?$/i.test(address.pathname)) return null;
      address.protocol = 'https:'; address.port = ''; address.pathname = address.pathname.replace(/\/edit\/?$/, '/view'); address.search = '?embed'; address.hash = '';
      return { kind: 'canva', src: address.href, link: address.href.replace('?embed', ''), ratio: ratio ? ratio[0] / ratio[1] : width > 0 && height > 0 ? width / height : 16 / 9 };
    }
    if (host === 'geogebra.org' || host === 'www.geogebra.org') {
      const match = address.pathname.match(/\/(?:m|classic)\/([a-z0-9]+)(?:\/|$)/i) || address.pathname.match(/\/material\/iframe\/id\/([a-z0-9]+)(?:\/|$)/i);
      if (match) {
        const embeddedWidth = address.pathname.match(/\/width\/(\d+)/), embeddedHeight = address.pathname.match(/\/height\/(\d+)/);
        const baseWidth = clamp(width || embeddedWidth && +embeddedWidth[1] || 1100, 320, 4000);
        const baseHeight = clamp(ratio ? baseWidth * ratio[1] / ratio[0] : height || embeddedHeight && +embeddedHeight[1] || +props.height || 600, 180, 2400);
        return { kind: 'geogebra', width: baseWidth, height: baseHeight, ratio: baseWidth / baseHeight,
          link: 'https://www.geogebra.org/m/' + match[1],
          src: 'https://www.geogebra.org/material/iframe/id/' + match[1] + '/width/' + Math.round(baseWidth) + '/height/' + Math.round(baseHeight) + '/border/FFFFFF/rc/true/ai/false/sdz/true/smb/false/stb/false/stbh/false/ld/false/sri/false/ctl/false/sfsb/true/szb/true' };
      }
    }
    return { kind: 'web', src, link: src, ratio: ratio ? ratio[0] / ratio[1] : null };
  }
  R.embed = (b, ctx) => {
    const p = b.props, source = parseEmbed(p.url, p);
    if (!source) return ctx.edit ? h('div', { class: 'iml-placeholder' }, icon('eye'), h('div', { text: 'Wklej link do apletu GeoGebra, Smart Embed Link z Canvy lub kod iframe.' })) : null;
    const viewport = h('div', { class: 'iml-embed', style: { '--eh': (+p.height || 480) + 'px', aspectRatio: source.ratio || null, height: source.ratio ? 'auto' : null } });
    const frame = h('iframe', { src: source.src, title: str(p.title) || (source.kind === 'canva' ? 'Prezentacja Canva' : source.kind === 'geogebra' ? 'GeoGebra' : 'Osadzona treść'), loading: 'lazy',
      allow: 'fullscreen; clipboard-write; autoplay; encrypted-media; picture-in-picture', allowfullscreen: true, referrerpolicy: 'strict-origin-when-cross-origin',
      sandbox: 'allow-scripts allow-same-origin allow-popups allow-forms allow-presentation allow-downloads' + (source.kind === 'canva' ? ' allow-popups-to-escape-sandbox allow-storage-access-by-user-activation' : '') });
    viewport.append(frame);
    const shell = h('div', { class: 'iml-embed-frame', 'data-embed-provider': source.kind }, viewport);
    const fullscreen = h('button', { type: 'button', class: 'iml-btn iml-btn-ghost iml-btn-sm', 'data-ui': '1', onclick: () => {
      if (doc.fullscreenElement === shell) { if (doc.exitFullscreen) doc.exitFullscreen(); }
      else if (shell.requestFullscreen) shell.requestFullscreen().catch(() => {});
    } }, 'Pełny ekran');
    shell.append(h('div', { class: 'iml-embed-actions' }, h('a', { class: 'iml-btn iml-btn-ghost iml-btn-sm', href: source.link, target: '_blank', rel: 'noopener', 'data-ui': '1' }, 'Otwórz w nowej karcie'), fullscreen));
    if (source.kind === 'geogebra') {
      Object.assign(frame.style, { width: source.width + 'px', height: source.height + 'px', maxWidth: 'none', position: 'absolute', transformOrigin: '0 0' });
      function resize() {
        if (!viewport.isConnected || !viewport.clientWidth) return;
        const scale = Math.min(viewport.clientWidth / source.width, viewport.clientHeight / source.height);
        frame.style.transform = 'scale(' + scale + ')';
        frame.style.left = (viewport.clientWidth - source.width * scale) / 2 + 'px';
        frame.style.top = (viewport.clientHeight - source.height * scale) / 2 + 'px';
      }
      const observer = root.ResizeObserver ? new ResizeObserver(resize) : null;
      if (observer) observer.observe(viewport);
      const animation = requestAnimationFrame(resize);
      shell.setAttribute('data-iml-managed', '1');
      shell._imlDispose = () => { if (observer) observer.disconnect(); cancelAnimationFrame(animation); };
    }
    return shell;
  };

  function parseBlanks(text) {
    const parts = [];
    const re = /\[([^\]]+)\]/g;
    let last = 0, m;
    const t = str(text);
    while ((m = re.exec(t))) {
      if (m.index > last) parts.push({ text: t.slice(last, m.index) });
      parts.push({ gap: m[1].split('|').map(s => s.trim()).filter(Boolean) });
      last = m.index + m[0].length;
    }
    if (last < t.length) parts.push({ text: t.slice(last) });
    return parts;
  }
  R.blanks = (b, ctx) => {
    const p = b.props;
    if (ctx.edit) {
      return h('div', { class: 'iml-blanks' },
        h('div', attrs({ class: 'iml-blanks-title iml-tex', html: sanitizeInline(p.title) }, ed(ctx, 'title', 'inline', 'Polecenie'))),
        h('div', attrs({ class: 'iml-blanks-text iml-rich iml-tex', html: sanitizeHtml(p.text) }, ed(ctx, 'text', 'rich', 'Tekst z lukami, np. [Warszawa]'))));
    }
    const st = ctx.state(b.id, () => ({ values: {}, checked: false, reported: false }));
    const box = h('div', { class: 'iml-blanks' });
    function draw() {
      box.replaceChildren();
      if (p.title) box.append(h('div', { class: 'iml-blanks-title iml-tex', html: sanitizeInline(p.title) }));
      const textEl = h('div', { class: 'iml-blanks-text iml-rich iml-tex', html: sanitizeHtml(p.text) });
      const walker = doc.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);
      let gi = 0;
      const inputs = [];
      textNodes.forEach(node => {
        const fragment = doc.createDocumentFragment();
        parseBlanks(node.textContent).forEach(part => {
          if (part.text != null) { fragment.append(part.text); return; }
          const idx = gi++;
          const longest = part.gap.reduce((a, s) => Math.max(a, s.length), 3);
          const input = h('input', { class: 'iml-gap', type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Luka ' + (idx + 1), style: { width: (longest + 3) + 'ch' } });
          input.value = st.values[idx] || '';
          input.addEventListener('input', () => { st.values[idx] = input.value; if (st.checked) { st.checked = false; input.classList.remove('iml-right', 'iml-wrong'); } });
          if (st.checked) {
            const v = p.caseSensitive ? str(input.value).trim() : normAnswer(input.value);
            const ok = part.gap.some(g => (p.caseSensitive ? g.trim() : normAnswer(g)) === v);
            input.classList.add(ok ? 'iml-right' : 'iml-wrong');
          }
          inputs.push({ input, part });
          fragment.append(input);
        });
        node.replaceWith(fragment);
      });
      box.append(textEl);
      if (st.checked) {
        const good = box.querySelectorAll('.iml-gap.iml-right').length;
        box.append(h('div', { class: 'iml-feedback iml-pop ' + (good === inputs.length ? 'iml-ok' : 'iml-no') }, h('strong', { text: 'Poprawne: ' + good + ' z ' + inputs.length })));
        if (!st.reported && good === inputs.length) { st.reported = true; report(ctx, { type: 'quiz', name: (str(p.title) || 'Uzupełnij luki') + ' — ' + ctx.lesson.title, score: good, maxScore: inputs.length, blockId: b.id }); }
      }
      box.append(h('div', { class: 'iml-actions' },
        h('button', { type: 'button', class: 'iml-btn iml-btn-ghost', onclick: () => { inputs.forEach((x, i) => { st.values[i] = x.part.gap[0]; }); st.checked = true; draw(); } }, 'Pokaż odpowiedzi'),
        h('button', { type: 'button', class: 'iml-btn iml-btn-primary', onclick: () => { st.checked = true; draw(); } }, h('span', { text: 'Sprawdź' }), icon('right'))
      ));
    }
    draw();
    return box;
  };

  R.accordion = (b, ctx) => {
    const p = b.props;
    const sum = h(ctx.edit ? 'div' : 'summary', { class: 'iml-acc-sum' }, h('span', attrs({ class: 'iml-tex', html: sanitizeInline(p.title) }, ed(ctx, 'title', 'inline', 'Tytuł (kliknij, aby rozwinąć)'))), icon('chevR'));
    const body = h('div', { class: 'iml-acc-body' }, h('div', attrs({ class: 'iml-rich iml-tex', html: sanitizeHtml(p.html) }, ed(ctx, 'html', 'rich', 'Ukryta treść…'))));
    if (ctx.edit) return h('div', { class: 'iml-acc' }, sum, body);
    return h('details', { class: 'iml-acc', open: p.open ? true : null }, sum, body);
  };

  /* --------------------------------------------------------- block/section */
  function applyStyle(el, s, type) {
    if (!isObj(s)) return;
    if (s.align) el.setAttribute('data-align', s.align);
    if (s.color) { el.style.color = s.color; el.classList.add('iml-has-color'); }
    if (s.fontSize) { el.style.fontSize = (+s.fontSize) + 'px'; el.classList.add('iml-has-fs'); }
    if (s.fontWeight) el.style.fontWeight = s.fontWeight;
    if (s.bg) el.style.background = s.bg;
    if (s.pad != null && s.pad !== '') el.style.padding = (+s.pad) + 'px';
    if (s.radius != null && s.radius !== '') el.style.borderRadius = (+s.radius) + 'px';
    if (s.border) el.classList.add('iml-boxed');
    if (s.shadow) el.classList.add('iml-shadow');
    if (s.mt != null && s.mt !== '') el.style.marginTop = (+s.mt) + 'px';
    if (s.mb != null && s.mb !== '') el.style.marginBottom = (+s.mb) + 'px';
    if (s.maxWidth) {
      el.style.maxWidth = (+s.maxWidth) + 'px';
      if (s.align === 'center') el.style.marginLeft = el.style.marginRight = 'auto';
      else if (s.align === 'right') el.style.marginLeft = 'auto';
    }
    if (s.hideMobile) el.classList.add('iml-hide-mobile');
    if (s.anchor && /^[a-z0-9-]+$/i.test(s.anchor)) el.id = 'iml-' + s.anchor;
    if (s.className) str(s.className).split(/\s+/).filter(c => /^iml-u-[a-z0-9-]+$/.test(c)).forEach(c => el.classList.add(c));
  }

  function renderBlock(b, ctx, depth) {
    depth = depth || 0;
    const fn = R[b.type];
    const el = h('div', { class: 'iml-block iml-b-' + str(b.type).replace(/[^a-z0-9-]/gi, ''), 'data-block-id': b.id, 'data-type': b.type });
    if (!fn) {
      if (!ctx.edit) return null;
      el.append(h('div', { class: 'iml-placeholder', style: { minHeight: '60px' }, text: 'Nieznany element: ' + b.type }));
      return el;
    }
    let content;
    try { content = fn(b, ctx, depth); }
    catch (err) {
      if (root.console) console.warn('[InfoMatykaLesson] Błąd renderowania bloku', b, err);
      content = ctx.edit ? h('div', { class: 'iml-placeholder', style: { minHeight: '60px' }, text: 'Nie udało się wyświetlić elementu' }) : null;
    }
    if (content == null || (Array.isArray(content) && !content.filter(Boolean).length)) { if (!ctx.edit) return null; }
    append(el, content);
    applyStyle(el, b.style, b.type);
    return el;
  }

  function renderSection(s, ctx, index) {
    const el = h('section', { class: 'iml-section', 'data-section-id': s.id, id: 'iml-sekcja-' + (index + 1), 'aria-label': s.title || ('Sekcja ' + (index + 1)) });
    const st = s.style || {};
    if (st.bg) el.style.background = st.bg;
    if (st.pad != null && st.pad !== '') el.style.padding = (+st.pad) + 'px';
    if (st.color) el.style.color = st.color;
    el.append(slot(ctx, s.blocks, 'section:' + s.id, -1, 'Pusta sekcja — przeciągnij tutaj elementy z lewego panelu'));
    return el;
  }

  function cleanup(el) {
    if (!el || !el.querySelectorAll) return;
    [el, ...el.querySelectorAll('[data-iml-managed]')].forEach(node => { if (node._imlDispose) { node._imlDispose(); node._imlDispose = null; } });
    el.querySelectorAll('canvas').forEach(c => { if (c._imlChart) { try { c._imlChart.destroy(); } catch (_) {} c._imlChart = null; } });
  }

  function applyTheme(el, theme) {
    const t = theme || {};
    const accent = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : '#1677e6';
    el.style.setProperty('--a', accent);
    el.style.setProperty('--a-ink', `color-mix(in srgb, ${accent} 78%, #000)`);
    el.style.setProperty('--a-soft', `color-mix(in srgb, ${accent} 10%, #fff)`);
    if (t.bg) el.style.setProperty('--bg', t.bg);
    if (t.maxWidth) el.style.setProperty('--maxw', (+t.maxWidth) + 'px');
    el.classList.toggle('iml-cards', t.sections !== 'flat');
    el.classList.toggle('iml-flat', t.sections === 'flat');
    ['system', 'serif', 'rounded'].forEach(f => el.classList.toggle('iml-font-' + f, t.font === f));
    if (!t.font || t.font === 'dm') loadCss(LIB.fonts);
  }

  /** Renderuje lekcję do elementu. opts: { mode:'view'|'edit', ui:Map, change(blockId,path,value) } */
  function render(target, input, opts) {
    injectCss();
    opts = opts || {};
    const lesson = normalize(input);
    const edit = opts.mode === 'edit';
    cleanup(target);
    const rootEl = h('div', { class: 'iml tex2jax_ignore mathjax_ignore ' + (edit ? 'iml-edit' : 'iml-view'), 'data-lesson-id': lesson.id, lang: 'pl' });
    applyTheme(rootEl, lesson.theme);
    const ui = opts.ui || new Map();
    const ctx = {
      edit, lesson, rootEl,
      state(id, init) { if (!ui.has(id)) ui.set(id, init()); return ui.get(id); },
      change: opts.change || function () {}
    };
    const docEl = h('div', { class: 'iml-doc' });
    const sections = lesson.sections.map((s, i) => renderSection(s, ctx, i));
    sections.forEach(s => docEl.append(s));

    const steps = !edit && lesson.theme.mode === 'steps' && sections.length > 1;
    const footer = h('div', { class: 'iml-footer' });
    let bar = null, stepIndex = 0, stepLabel = null, prevBtn = null, nextBtn = null;
    if (!edit && lesson.theme.progress !== false && sections.length > 1) {
      bar = h('i');
      rootEl.append(h('div', { class: 'iml-progress', role: 'progressbar', 'aria-label': 'Postęp lekcji' }, bar));
    }
    rootEl.append(docEl);

    function setProgress(frac) { if (bar) bar.style.width = Math.round(clamp(frac, 0, 1) * 100) + '%'; }
    function goTo(i, scroll) {
      if (!steps) { const s = sections[i]; if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      stepIndex = clamp(i, 0, sections.length - 1);
      sections.forEach((s, j) => { s.hidden = j !== stepIndex; });
      sections[stepIndex].classList.remove('iml-pop'); void sections[stepIndex].offsetWidth; sections[stepIndex].classList.add('iml-pop');
      stepLabel.textContent = 'Krok ' + (stepIndex + 1) + ' z ' + sections.length;
      prevBtn.disabled = stepIndex === 0;
      nextBtn.hidden = stepIndex === sections.length - 1;
      if (finishEl) finishEl.hidden = stepIndex !== sections.length - 1;
      setProgress((stepIndex + 1) / sections.length);
      if (scroll !== false) rootEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    let finishEl = null;
    if (!edit && lesson.theme.finish !== false) {
      const doneKey = 'infomatyka-lesson-completed';
      let done = false;
      try { done = !!(JSON.parse(root.localStorage.getItem(doneKey) || '{}') || {})[lesson.id]; } catch (_) {}
      const btn = h('button', { type: 'button', class: 'iml-btn iml-btn-primary' }, icon('check'), h('span', { text: done ? 'Ukończono ✓' : 'Oznacz jako ukończoną' }));
      if (done) btn.disabled = true;
      btn.addEventListener('click', () => {
        btn.disabled = true; btn.lastChild.textContent = 'Ukończono ✓';
        try { const all = JSON.parse(root.localStorage.getItem(doneKey) || '{}') || {}; all[lesson.id] = Date.now(); root.localStorage.setItem(doneKey, JSON.stringify(all)); } catch (_) {}
        report(ctx, { type: 'lekcja', name: lesson.title });
        setProgress(1);
      });
      finishEl = h('div', { class: 'iml-finish' }, h('div', { class: 'iml-finish-card' }, icon('flag'), h('div', { class: 'iml-finish-text' }, h('strong', { text: 'To już koniec lekcji!' }), h('span', { text: 'Przejrzyj jeszcze raz trudniejsze fragmenty albo oznacz lekcję jako ukończoną.' })), btn));
    }

    if (steps) {
      prevBtn = h('button', { type: 'button', class: 'iml-btn iml-btn-ghost', onclick: () => { goTo(stepIndex - 1); rootEl.focus({ preventScroll: true }); } }, icon('left'), 'Wstecz');
      nextBtn = h('button', { type: 'button', class: 'iml-btn iml-btn-primary', onclick: () => { goTo(stepIndex + 1); rootEl.focus({ preventScroll: true }); } }, h('span', { text: 'Dalej' }), icon('right'));
      stepLabel = h('span', { class: 'iml-steplabel', 'aria-live': 'polite' });
      footer.append(h('div', { class: 'iml-stepnav', role: 'navigation', 'aria-label': 'Nawigacja lekcji' }, prevBtn, stepLabel, nextBtn));
      rootEl.tabIndex = 0;
      rootEl.setAttribute('aria-keyshortcuts', 'Space ArrowDown ArrowRight ArrowUp ArrowLeft');
      rootEl.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
        const controls = 'input,textarea,select,button,a,[contenteditable],math-field,[role="button"],audio,video,iframe';
        if (event.composedPath().some(node => node.matches && node.matches(controls))) return;
        const forward = event.key === ' ' || event.key === 'Spacebar' || event.key === 'ArrowDown' || event.key === 'ArrowRight';
        const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
        if (!forward && !backward) return;
        event.preventDefault();
        if (!event.repeat) goTo(stepIndex + (forward ? 1 : -1));
      });
    }
    if (finishEl) footer.append(finishEl);
    if (steps || finishEl) rootEl.append(footer);
    if (steps) goTo(0, false);
    else if (bar && 'IntersectionObserver' in root) {
      let seen = 0;
      const io = new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) seen = Math.max(seen, sections.indexOf(e.target) + 1); });
        setProgress(seen / sections.length);
      }, { threshold: 0.35 });
      sections.forEach(s => io.observe(s));
    }

    target.replaceChildren(rootEl);
    typeset(rootEl);
    return { el: rootEl, lesson, goTo, ctx };
  }

  /** Renderuje pojedynczy blok (używane przez edytor do szybkiego odświeżania). */
  function renderOne(block, lesson, opts) {
    injectCss();
    const rootEl = opts && opts.rootEl;
    const ui = (opts && opts.ui) || new Map();
    const ctx = { edit: opts && opts.mode === 'edit', lesson, rootEl, state(id, init) { if (!ui.has(id)) ui.set(id, init()); return ui.get(id); }, change: (opts && opts.change) || function () {} };
    const el = renderBlock(block, ctx, (opts && opts.depth) || 0);
    if (el) typeset(el);
    return el;
  }

  /* ------------------------------------------------------------- sharing */
  function b64urlFromBytes(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function bytesFromB64url(s) {
    const bin = atob(str(s).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function encodeShare(lesson) {
    const json = JSON.stringify(lesson);
    if (root.CompressionStream) {
      const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return 'z' + b64urlFromBytes(new Uint8Array(await new Response(stream).arrayBuffer()));
    }
    return 'j' + b64urlFromBytes(new TextEncoder().encode(json));
  }
  async function decodeShare(code) {
    const c = str(code).trim();
    const kind = c[0];
    const bytes = bytesFromB64url(c.slice(1));
    let json;
    if (kind === 'z') {
      if (!root.DecompressionStream) throw new Error('Ta przeglądarka nie potrafi otworzyć skompresowanego linku.');
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      json = await new Response(stream).text();
    } else json = new TextDecoder().decode(bytes);
    return normalize(JSON.parse(json));
  }
  function normalizeRemoteUrl(url) {
    let u = str(url).trim();
    const gh = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
    if (gh) u = 'https://raw.githubusercontent.com/' + gh[1] + '/' + gh[2] + '/' + gh[3];
    const gist = u.match(/^https:\/\/gist\.github\.com\/([^/]+)\/([0-9a-f]+)\/?$/i);
    if (gist) u = 'https://gist.githubusercontent.com/' + gist[1] + '/' + gist[2] + '/raw';
    return u;
  }
  async function fetchLesson(url) {
    const u = normalizeRemoteUrl(url);
    if (!/^https:\/\//i.test(u) && !/^\.?\//.test(u)) throw new Error('Adres lekcji musi zaczynać się od https://');
    const res = await fetch(u, { credentials: 'omit' });
    if (!res.ok) throw new Error('Nie udało się pobrać lekcji (' + res.status + ').');
    return normalize(await res.json());
  }

  /* ------------------------------------------------------------- library */
  const DB_NAME = 'infomatyka-lessons', STORE = 'lessons', LS_KEY = 'infomatyka-lessons-fallback';
  let dbPromise = null;
  function openDb() {
    if (!root.indexedDB) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise(resolve => {
        let req;
        try { req = root.indexedDB.open(DB_NAME, 1); } catch (_) { resolve(null); return; }
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
    }
    return dbPromise;
  }
  function lsAll() { try { return JSON.parse(root.localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { return {}; } }
  function idb(mode, fn) {
    return openDb().then(db => {
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Zapis przerwany (brak miejsca?)'));
      });
    });
  }
  function countBlocks(lesson) {
    let n = 0;
    const walk = list => arr(list).forEach(b => { n++; walk(b.props && b.props.blocks); arr(b.props && b.props.columns).forEach(c => walk(c.blocks)); });
    arr(lesson.sections).forEach(s => walk(s.blocks));
    return n;
  }
  const library = {
    async list() {
      const rows = await idb('readonly', s => s.getAll()).catch(() => null);
      const list = rows || Object.values(lsAll());
      return list.map(r => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, createdAt: r.createdAt, blocks: r.blocks, sections: r.sections, subject: r.subject, size: r.size }))
        .sort((a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)));
    },
    async get(id) {
      const row = await idb('readonly', s => s.get(id)).catch(() => null);
      const rec = row || lsAll()[id];
      return rec ? normalize(rec.lesson) : null;
    },
    async put(lesson) {
      const json = JSON.stringify(lesson);
      const rec = { id: lesson.id, title: lesson.title, subject: lesson.subject, createdAt: lesson.createdAt, updatedAt: lesson.updatedAt, blocks: countBlocks(lesson), sections: arr(lesson.sections).length, size: json.length, lesson: JSON.parse(json) };
      if (await openDb()) { await idb('readwrite', s => s.put(rec)); return rec; }
      const all = lsAll(); all[rec.id] = rec; root.localStorage.setItem(LS_KEY, JSON.stringify(all));
      return rec;
    },
    async remove(id) {
      await idb('readwrite', s => s.delete(id)).catch(() => null);
      const all = lsAll(); if (all[id]) { delete all[id]; try { root.localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch (_) {} }
    }
  };

  async function loadFromLocation(loc) {
    loc = loc || root.location;
    const hash = new URLSearchParams(str(loc.hash).replace(/^#/, ''));
    const query = new URLSearchParams(str(loc.search));
    if (hash.get('lekcja')) return decodeShare(hash.get('lekcja'));
    const src = query.get('lekcja') || query.get('src');
    if (src) return fetchLesson(src);
    const id = query.get('id');
    if (id) { const l = await library.get(id); if (!l) throw new Error('Nie znaleziono tej lekcji w bibliotece na tym urządzeniu.'); return l; }
    return null;
  }

  /* ------------------------------------------------------------ auto mount */
  function showError(el, msg) {
    injectCss();
    el.replaceChildren(h('div', { class: 'iml iml-view' }, h('div', { class: 'iml-doc' }, h('div', { class: 'iml-callout iml-callout-danger' }, icon('alert'), h('div', { class: 'iml-callout-body' }, h('div', { class: 'iml-callout-title', text: 'Nie udało się wyświetlić lekcji' }), h('div', { class: 'iml-rich', text: msg }))))));
  }
  function mount(el) {
    if (el.dataset.imlMounted) return;
    el.dataset.imlMounted = '1';
    let target = el, job;
    if (el.tagName === 'SCRIPT') {
      target = h('div', { class: 'infomatyka-lesson-host' });
      el.after(target);
      job = Promise.resolve().then(() => normalize(el.textContent));
    } else if (el.dataset.src) job = fetchLesson(el.dataset.src);
    else if (el.hasAttribute('data-from-location')) job = loadFromLocation();
    else return;
    job.then(lesson => { if (lesson) render(target, lesson, { mode: 'view' }); })
      .catch(err => showError(target, err && err.message ? err.message : String(err)));
  }
  function mountAll(scope) {
    (scope || doc).querySelectorAll('.infomatyka-lesson, [data-infomatyka-lesson]').forEach(mount);
  }
  if (!(root.InfoMatykaLessonConfig && root.InfoMatykaLessonConfig.autoMount === false)) {
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => mountAll());
    else setTimeout(() => mountAll(), 0);
  }

  root.InfoMatykaLesson = Object.freeze({
    VERSION, FORMAT, VIEWER_URL, LIB,
    render, renderBlock: renderOne, normalize, cleanup, typeset, injectCss,
    sanitizeHtml, sanitizeInline, escapeHtml, htmlToText, safeUrl, hasMath,
    ensureKatex, ensureChart, ensureMathLive, loadScript, loadCss,
    parseVideo, parseEmbed, parseChartData, parseBlanks, ratioParts, setPath, getPath, uid, icon, countBlocks,
    encodeShare, decodeShare, fetchLesson, loadFromLocation, library, mountAll, openLightbox
  });
})(typeof window !== 'undefined' ? window : this);
