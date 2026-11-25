/*
 * OpenAlgo floating trading bar.
 *
 * Security model: this script never sees the API key and never talks to the
 * OpenAlgo server. It renders buttons inside a *closed* shadow root (page
 * scripts cannot reach in), ignores synthetic (untrusted) clicks, refuses to
 * fire when the page has covered the bar, and asks the service worker to place
 * a fixed, named action. The page cannot trigger an order or read settings.
 */
(() => {
  'use strict';
  if (window.top !== window) return;

  // A previous copy (e.g. before an extension update) may still be here.
  const prev = window.__openalgoBar;
  if (prev && prev.alive()) return;
  if (prev) prev.destroy();

  // The host is a plain <div>, never a custom-element name: a page could
  // pre-register such a name and read the closed shadow root through
  // ElementInternals.shadowRoot.
  const MARK = 'data-openalgo-bar';
  const HOST_ATTRS = new Set(['style', 'popover', MARK]);
  // v1 injected its bar straight into the page; drop it if this tab still has one.
  for (const id of ['openalgo-controls']) document.getElementById(id)?.remove();
  for (const n of document.querySelectorAll('.openalgo-notification')) n.remove();
  const HOSTNAME = location.hostname;
  const S = {
    cfg: { ...OA.CONFIG_DEFAULTS },
    server: null,
    live: null,
    quote: null,
    busy: false,
    armed: null,
    armedAt: 0,
    armTimer: 0,
    covered: false, // IntersectionObserver v2 says something is painted over the buttons
    blockUntil: 0, // clicks refused until then (the page just moved/covered the bar)
    down: null, // { action, at } of the last trusted pointerdown on a trade button
    hostStyle: '', // the host's style attribute as we last set it
  };
  let host = null;
  let root = null;
  let ui = {};
  let port = null;
  let observer = null;
  let visObserver = null;
  let sizeObserver = null;
  let hostObserver = null;
  let reattach = { n: 0, since: 0 };
  let dead = false;

  const alive = () => {
    try {
      return !dead && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };
  window.__openalgoBar = { alive, destroy };

  // ------------------------------------------------------------ bootstrap --

  chrome.storage.sync.get(OA.CONFIG_DEFAULTS).then((cfg) => {
    S.cfg = cfg;
    update();
  }).catch(() => {});

  chrome.storage.onChanged.addListener(onStorage);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onFullscreen);
  document.addEventListener('toggle', onPageToggle, true);

  function onStorage(changes, area) {
    if (!alive()) return destroy();
    if (area !== 'sync') return;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in OA.CONFIG_DEFAULTS) S.cfg[k] = newValue === undefined ? OA.CONFIG_DEFAULTS[k] : newValue;
    }
    if (changes.mode || changes.symbol || changes.exchange || changes.optUnderlying || changes.optExchange) S.quote = null;
    update();
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') connectPort();
    else disconnectPort();
  }

  function update() {
    if (!alive()) return destroy();
    const show = OA.barVisible(S.cfg, HOSTNAME);
    if (show && !host) mount();
    if (!show && host) unmount();
    if (host) {
      render();
      place();
      connectPort();
    }
  }

  // ---------------------------------------------------------------- mount --

  function mount() {
    host = document.createElement('div');
    host.setAttribute(MARK, '');
    // Inline !important beats any page stylesheet, so the page cannot restyle,
    // move or hide the bar by accident.
    const hostStyle = {
      all: 'initial', position: 'fixed', 'z-index': '2147483647', inset: 'auto', left: '20px', top: '100px',
      margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'visible', display: 'block',
      width: 'auto', height: 'auto', 'max-width': 'none', 'max-height': 'none', transform: 'none',
      visibility: 'visible', opacity: '1', 'pointer-events': 'auto', contain: 'layout style',
    };
    for (const [k, v] of Object.entries(hostStyle)) host.style.setProperty(k, v, 'important');
    host.setAttribute('popover', 'manual');
    S.hostStyle = host.getAttribute('style');

    root = host.attachShadow({ mode: 'closed' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', { text: CSS }));
    }

    ui.bar = h('div', { class: 'bar', role: 'toolbar', 'aria-label': 'OpenAlgo trading buttons' });
    ui.dot = h('span', { class: 'dot' });
    ui.sym = h('span', { class: 'sym' });
    ui.tag = h('span', { class: 'tag' });
    ui.meta = h('span', { class: 'meta' });
    ui.ctx = h('button', { class: 'ctx', type: 'button', title: 'Open OpenAlgo settings', onclick: trusted(openSettings) },
      h('span', { class: 'line' }, ui.sym), ui.meta);
    ui.ltp = h('span', { class: 'ltp' });
    ui.chg = h('span', { class: 'chg' });
    ui.px = h('span', { class: 'px', 'aria-live': 'off' }, ui.ltp, ui.chg);
    ui.mode = h('button', { class: 'mode', type: 'button', onclick: trusted(toggleMode) });
    ui.more = h('button', { class: 'icon', type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: trusted(openSettings) }, dotsIcon());
    ui.min = h('button', { class: 'icon', type: 'button', onclick: trusted(toggleCollapsed) }, minusIcon());
    ui.logo = h('button', { class: 'logo', type: 'button', title: 'Expand OpenAlgo bar', onclick: trusted(toggleCollapsed) }, 'OA');
    ui.head = h('div', { class: 'head' }, gripIcon(), ui.dot, ui.logo, ui.ctx, ui.px, ui.mode, ui.more, ui.min);
    ui.actions = h('div', { class: 'actions' });
    // Transparent, static layer over the buttons. Only the page can cover it,
    // so the visibility check is not confused by our own hover/loading styles.
    ui.guard = h('div', { class: 'guard', 'aria-hidden': 'true' });
    ui.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    ui.bar.append(ui.tag, ui.head, h('div', { class: 'actwrap' }, ui.actions, ui.guard), ui.toasts);
    root.append(ui.bar);

    ui.head.addEventListener('pointerdown', startDrag);
    ui.actions.addEventListener('pointerdown', (e) => {
      const b = e.isTrusted && e.composedPath().find((n) => n.dataset?.action);
      S.down = b ? { action: b.dataset.action, at: Date.now() } : null;
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') disarm();
    });
    // Keep our clicks and keystrokes from reaching page handlers (chart
    // hotkeys, "click outside" menus, drag-selection).
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu', 'keydown', 'keyup', 'wheel']) {
      root.addEventListener(t, (e) => e.stopPropagation());
    }

    // Clickjacking guard: IntersectionObserver v2 reports whether the buttons
    // are actually visible (not covered, faded or transformed by the page).
    try {
      visObserver = new IntersectionObserver((entries) => {
        const e = entries[entries.length - 1];
        if (typeof e.isVisible === 'boolean') S.covered = !e.isVisible;
      }, { trackVisibility: true, delay: 100 });
      visObserver.observe(ui.guard);
    } catch {
      visObserver = null;
    }

    sizeObserver = new ResizeObserver(() => place());
    sizeObserver.observe(ui.bar);

    // Anti-clickjacking: if the page moves, restyles or hides the host, undo
    // it and refuse clicks for a moment (the user may be aiming at a decoy).
    hostObserver = new MutationObserver(checkHost);
    hostObserver.observe(host, { attributes: true });
    host.addEventListener('toggle', (e) => {
      if (e.newState === 'closed' && host && !host.matches(':popover-open')) suspect();
    });

    attach();
    observer = new MutationObserver(() => {
      if (!alive()) return destroy();
      if (host && !host.isConnected) attach();
    });
    observer.observe(document.documentElement, { childList: true });
  }

  /** Put the host on <html> (survives SPA <body> swaps) and into the top layer. */
  function attach() {
    const now = Date.now();
    if (now - reattach.since > 10000) reattach = { n: 0, since: now };
    if (++reattach.n > 20) return; // the page keeps removing us; give up quietly
    const fs = document.fullscreenElement;
    (fs && !/^(VIDEO|CANVAS|IFRAME|IMG|EMBED|OBJECT|svg)$/i.test(fs.tagName) ? fs : document.documentElement).append(host);
    raise();
  }

  /**
   * Chrome makes everything outside a fullscreen element inert (drawn, but not
   * clickable), so while a chart is fullscreen the bar lives inside it.
   */
  function onFullscreen() {
    if (!host) return;
    const fs = document.fullscreenElement;
    const parent = fs && !/^(VIDEO|CANVAS|IFRAME|IMG|EMBED|OBJECT|svg)$/i.test(fs.tagName) ? fs : document.documentElement;
    if (host.parentNode !== parent) parent.append(host);
    suspect();
    place();
  }

  function checkHost() {
    if (!host) return;
    const extra = [...host.attributes].filter((a) => !HOST_ATTRS.has(a.name));
    if (!extra.length && host.getAttribute('style') === S.hostStyle && host.getAttribute('popover') === 'manual') return;
    for (const a of extra) host.removeAttribute(a.name);
    host.setAttribute('popover', 'manual');
    host.setAttribute('style', S.hostStyle);
    suspect();
  }

  /** The page opened a popover/dialog: stay above it; pause clicks if it overlaps us. */
  function onPageToggle(e) {
    if (!host || e.target === host || e.newState !== 'open') return;
    raise();
    const a = e.target.getBoundingClientRect?.();
    const b = host.getBoundingClientRect();
    if (a && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) suspect();
  }

  function suspect() {
    S.blockUntil = Date.now() + 1000;
    raise();
  }

  /** Re-enter the top layer so the bar stays above fullscreen charts and modals. */
  function raise() {
    if (!host || !host.isConnected || typeof host.showPopover !== 'function') return;
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch {
      /* falls back to z-index */
    }
  }

  function unmount() {
    disconnectPort();
    observer?.disconnect();
    visObserver?.disconnect();
    sizeObserver?.disconnect();
    hostObserver?.disconnect();
    host?.remove();
    host = root = null;
    ui = {};
  }

  function destroy() {
    dead = true;
    unmount();
    clearTimeout(S.armTimer);
    try {
      chrome.storage.onChanged.removeListener(onStorage);
    } catch {
      /* context gone */
    }
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('fullscreenchange', onFullscreen);
    document.removeEventListener('toggle', onPageToggle, true);
  }

  // --------------------------------------------------------------- render --

  function theme() {
    if (S.cfg.theme === 'light' || S.cfg.theme === 'dark') return S.cfg.theme;
    const lum = (el) => {
      if (!el) return null;
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (!m || (m.length > 3 && Number(m[3]) === 0)) return null;
      return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
    };
    const l = lum(document.body) ?? lum(document.documentElement);
    if (l !== null) return l < 0.45 ? 'dark' : 'light';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function render() {
    if (!ui.bar) return;
    const cfg = S.cfg;
    ui.bar.dataset.theme = theme();
    ui.bar.classList.toggle('collapsed', !!cfg.barCollapsed);
    ui.min.title = 'Minimise';
    ui.min.setAttribute('aria-label', 'Minimise');

    const sum = OA.summary(cfg);
    const setup = OA.missing(cfg).length > 0 || S.server?.state === 'setup';
    ui.sym.textContent = setup ? 'Setup needed' : sum.title;
    ui.meta.textContent = setup ? 'Click to open settings' : sum.meta;
    ui.ctx.classList.toggle('warn', setup);
    ui.ctx.title = setup ? 'Open OpenAlgo settings' : `${sum.title} · ${sum.meta}. Click for settings`;

    const an = S.server?.analyze;
    ui.tag.textContent = an === true ? 'SANDBOX' : an === false ? 'LIVE' : '';
    ui.tag.className = `tag ${an === true ? 'sandbox' : an === false ? 'live' : ''}`;
    ui.tag.title = an === true ? 'Analyzer mode: orders are simulated' : an === false ? 'Live mode: real orders' : '';
    ui.bar.dataset.env = an === true ? 'sandbox' : an === false ? 'live' : '';
    ui.logo.title = `Expand OpenAlgo bar${an === true ? ' (sandbox)' : an === false ? ' (LIVE)' : ''}`;

    const opt = cfg.mode === 'options';
    ui.mode.textContent = opt ? 'OPT' : 'EQ';
    ui.mode.title = opt ? 'Options mode. Click for equity / futures' : 'Equity / futures mode. Click for options';

    renderDot();
    renderQuote();

    const acts = OA.actionsFor(cfg);
    const sig = acts.map((a) => `${a.id}:${a.sub}`).join();
    if (ui.actions.dataset.sig !== sig) {
      ui.actions.dataset.sig = sig;
      ui.actions.replaceChildren(...acts.map((a) => h('button', {
        class: `t ${a.tone}`, type: 'button', title: a.title, 'aria-label': `${a.title}`, 'data-action': a.id,
        onclick: (e) => onTrade(e, a.id),
      }, h('b', { text: a.label }), h('small', { text: a.sub }))));
    }
    for (const b of ui.actions.children) {
      b.disabled = S.busy;
      b.classList.toggle('armed', S.armed === b.dataset.action);
      if (S.armed === b.dataset.action) b.lastChild.textContent = 'SURE?';
      else b.lastChild.textContent = acts.find((a) => a.id === b.dataset.action)?.sub || '';
    }
  }

  function renderDot() {
    const st = S.live?.state;
    const srv = S.server?.state;
    let cls = 'off';
    let title = 'Live data off';
    if (srv === 'error') [cls, title] = ['bad', S.server.error || 'OpenAlgo unreachable'];
    else if (st === 'live') [cls, title] = ['ok', `Live${S.server?.broker ? ` · ${S.server.broker}` : ''}`];
    else if (st === 'connecting') [cls, title] = ['wait', 'Connecting to live data…'];
    else if (st === 'error') [cls, title] = ['bad', S.live.error || 'Live data unavailable'];
    else if (srv === 'ok') [cls, title] = ['idle', `Connected${S.server.broker ? ` · ${S.server.broker}` : ''}`];
    ui.dot.className = `dot ${cls}`;
    ui.dot.title = title;
  }

  function renderQuote() {
    const inst = OA.liveInstrument(S.cfg);
    const q = S.quote;
    const okQuote = q && inst && q.symbol === inst.symbol && q.exchange === inst.exchange && Number.isFinite(q.ltp);
    ui.px.hidden = !okQuote || !S.cfg.liveData;
    if (!okQuote) return;
    ui.ltp.textContent = OA.fmtPrice(q.ltp);
    if (q.close) {
      const pct = ((q.ltp - q.close) / q.close) * 100;
      ui.chg.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      ui.chg.className = `chg ${pct >= 0 ? 'up' : 'down'}`;
    } else {
      ui.chg.textContent = '';
    }
  }

  // --------------------------------------------------------------- trades --

  function trusted(fn) {
    return (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      fn(e);
    };
  }

  async function onTrade(e, action) {
    if (!e.isTrusted || S.busy) return; // page scripts cannot click for the user
    e.stopPropagation();
    const now = Date.now();
    // A mouse click must also have *started* on this button, so a bar slid
    // under the cursor mid-click does not fire. (detail 0 = keyboard.)
    const down = S.down;
    S.down = null;
    if (e.detail > 0 && (down?.action !== action || now - down.at > 3000)) return;
    if (S.covered || now < S.blockUntil) {
      toast('warn', 'The page just moved or covered the OpenAlgo bar.', 'Check the bar is clear, then click again.');
      return;
    }
    if (S.cfg.confirmOrders) {
      if (S.armed !== action) return arm(action);
      // A double-click (or a lure asking for one) must not confirm.
      if (e.detail > 1 || now - S.armedAt < 350) return;
    }
    disarm();
    S.busy = true;
    const btn = [...ui.actions.children].find((b) => b.dataset.action === action);
    btn?.classList.add('loading');
    render();
    const res = await send({ type: 'trade', action },
      'No answer from the OpenAlgo extension. The order may have been placed. Check the order book before retrying.');
    S.busy = false;
    btn?.classList.remove('loading');
    render();
    if (!res) return;
    toast(res.level || (res.ok ? 'success' : 'error'), res.message, res.detail, {
      sandbox: res.sandbox,
      onclick: res.kind === 'config' ? openSettings : null,
      hint: res.kind === 'config' ? 'Click to open settings' : '',
    });
  }

  function arm(action) {
    S.armed = action;
    S.armedAt = Date.now();
    clearTimeout(S.armTimer);
    S.armTimer = setTimeout(disarm, 3000);
    render();
  }

  function disarm() {
    if (!S.armed) return;
    S.armed = null;
    clearTimeout(S.armTimer);
    render();
  }

  async function send(msg, failText = 'OpenAlgo extension is not responding. Reload the page.') {
    if (!alive()) return invalidated();
    try {
      return (await chrome.runtime.sendMessage(msg)) || { ok: false, level: 'warn', message: failText };
    } catch {
      if (!alive()) return invalidated();
      return { ok: false, level: 'warn', message: failText };
    }
  }

  function invalidated() {
    toast('warn', 'OpenAlgo was updated or disabled.', 'Reload this page to use the buttons.');
    setTimeout(destroy, 4000);
    dead = true;
    return null;
  }

  function openSettings() {
    send({ type: 'openSettings' });
  }

  function toggleMode() {
    chrome.storage.sync.set({ mode: S.cfg.mode === 'options' ? 'equity' : 'options' });
  }

  function toggleCollapsed() {
    chrome.storage.sync.set({ barCollapsed: !S.cfg.barCollapsed });
  }

  // ---------------------------------------------------------------- toast --

  function toast(level, message, detail = '', opts = {}) {
    if (!ui.toasts) return;
    const el = h('div', { class: `toast ${level}` },
      h('span', { class: 'tdot' }),
      h('div', {},
        h('b', { text: message || '' }),
        detail || opts.sandbox ? h('small', {}, opts.sandbox ? h('span', { class: 'chip', text: 'SANDBOX' }) : null, detail || '') : null,
        opts.hint ? h('small', { class: 'hint', text: opts.hint }) : null));
    el.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      el.remove();
      opts.onclick?.();
    });
    ui.toasts.prepend(el);
    while (ui.toasts.children.length > 3) ui.toasts.lastChild.remove();
    setTimeout(() => el.remove(), level === 'error' || level === 'warn' ? 8000 : 4500);
  }

  function orderToast(m) {
    const st = m.status.toLowerCase();
    const what = [m.action, m.filled || m.quantity, m.symbol].filter(Boolean).join(' ');
    if (st === 'complete') toast('success', `Filled: ${what}`, m.price ? `Avg ${OA.fmtPrice(m.price)} · Order ${m.orderid}` : `Order ${m.orderid}`, { sandbox: m.sandbox });
    else if (st === 'rejected') toast('error', `Rejected: ${m.symbol || m.label}`, m.reason || `Order ${m.orderid}`, { sandbox: m.sandbox });
    else if (st === 'cancelled') toast('warn', `Cancelled: ${m.symbol || m.label}`, `Order ${m.orderid}`, { sandbox: m.sandbox });
  }

  // ----------------------------------------------------------------- live --

  function connectPort() {
    if (port || !host || document.visibilityState !== 'visible' || !alive()) return;
    try {
      port = chrome.runtime.connect({ name: 'oa-live' });
    } catch {
      return void invalidated();
    }
    port.onMessage.addListener((m) => {
      if (m.type === 'status') {
        S.server = m.server;
        S.live = m.live;
        render();
      } else if (m.type === 'quote') {
        S.quote = m;
        if (ui.px) renderQuote();
      } else if (m.type === 'order') {
        orderToast(m);
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      if (!alive()) return destroy(); // extension disabled or removed
      // The worker went idle. Reconnect if live data should keep streaming.
      if (S.cfg.liveData && host) setTimeout(connectPort, 1500);
    });
  }

  function disconnectPort() {
    const p = port;
    port = null;
    try {
      p?.disconnect();
    } catch {
      /* already gone */
    }
  }

  // ----------------------------------------------------- drag & position --

  // The saved position is anchored to the nearest viewport edges, so a bar
  // parked on the right stays on the right when the window or bar resizes.
  function place() {
    if (!host || ui.bar?.classList.contains('dragging')) return;
    const r = host.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
    const pos = S.cfg.barPos;
    let x = 20;
    let y = 100;
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      x = pos.ax === 'r' ? vw - r.width - pos.x : pos.x;
      y = pos.ay === 'b' ? vh - r.height - pos.y : pos.y;
    }
    move(x, y);
  }

  function move(x, y) {
    const r = host.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
    x = Math.round(Math.min(Math.max(4, x), Math.max(4, vw - r.width - 4)));
    y = Math.round(Math.min(Math.max(4, y), Math.max(4, vh - r.height - 4)));
    host.style.setProperty('left', `${x}px`, 'important');
    host.style.setProperty('top', `${y}px`, 'important');
    S.hostStyle = host.getAttribute('style');
    ui.bar?.classList.toggle('up', y > vh / 2);
    ui.bar?.classList.toggle('right', x + r.width / 2 > vw / 2);
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(place, 100);
  }

  // Drag from anywhere on the header except the small icon buttons. Movement
  // is tracked on the window (fast flicks leave the header) and only counts as
  // a drag after 4px, so a plain click on the symbol still opens settings.
  function startDrag(e) {
    if (e.button !== 0 || !e.isTrusted) return;
    if (e.composedPath().some((n) => n.classList?.contains('icon') || n.classList?.contains('mode'))) return;
    const r = host.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    const onMove = (ev) => {
      if (!ev.isTrusted) return;
      if (ev.buttons === 0) return onUp();
      if (!dragging) {
        if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
        dragging = true;
        try {
          ui.head.setPointerCapture(ev.pointerId);
        } catch {
          /* pointer already released */
        }
        ui.bar.classList.add('dragging');
      }
      move(r.left + ev.clientX - sx, r.top + ev.clientY - sy);
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove, true);
      removeEventListener('pointerup', onUp, true);
      removeEventListener('pointercancel', onUp, true);
      if (!dragging || !host) return;
      ui.bar.classList.remove('dragging');
      const nr = host.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || innerWidth;
      const ax = nr.left + nr.width / 2 > vw / 2 ? 'r' : 'l';
      const ay = nr.top + nr.height / 2 > innerHeight / 2 ? 'b' : 't';
      const barPos = {
        ax, ay,
        x: Math.round(ax === 'r' ? vw - nr.right : nr.left),
        y: Math.round(ay === 'b' ? innerHeight - nr.bottom : nr.top),
      };
      chrome.storage.sync.set({ barPos }).catch(() => {});
    };
    addEventListener('pointermove', onMove, true);
    addEventListener('pointerup', onUp, true);
    addEventListener('pointercancel', onUp, true);
  }

  // ---------------------------------------------------------------- utils --

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  function svg(w, hgt, build) {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
    s.setAttribute('width', w);
    s.setAttribute('height', hgt);
    s.setAttribute('aria-hidden', 'true');
    build((name, attrs) => {
      const n = document.createElementNS(NS, name);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      s.append(n);
    });
    return s;
  }

  const gripIcon = () => {
    const s = svg(8, 14, (add) => {
      for (const y of [2, 7, 12]) for (const x of [2, 6]) add('circle', { cx: x, cy: y, r: 1.2, fill: 'currentColor' });
    });
    s.setAttribute('class', 'grip');
    return s;
  };
  const dotsIcon = () => svg(16, 16, (add) => {
    for (const y of [3.5, 8, 12.5]) add('circle', { cx: 8, cy: y, r: 1.4, fill: 'currentColor' });
  });
  const minusIcon = () => svg(16, 16, (add) => add('path', { d: 'M4 8h8', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round' }));

  const CSS = `
:host { all: initial; }
.bar {
  --bg: #ffffff; --fg: #0f172a; --muted: #64748b; --line: rgba(15,23,42,.10); --chip: #f1f5f9;
  --shadow: 0 10px 30px rgba(15,23,42,.18), 0 1px 3px rgba(15,23,42,.10);
  --le: #15803d; --lx: #b45309; --se: #dc2626; --sx: #2563eb; --up: #15803d; --down: #dc2626;
  position: relative; box-sizing: border-box; width: max-content; min-width: 264px; max-width: 340px; padding: 5px 6px 6px;
  font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--shadow); user-select: none; -webkit-user-select: none; -webkit-font-smoothing: antialiased;
  text-align: left; letter-spacing: normal; text-transform: none;
}
.bar[data-theme=dark] {
  --bg: #111827; --fg: #e5e7eb; --muted: #9ca3af; --line: rgba(255,255,255,.10); --chip: #1f2937;
  --shadow: 0 10px 30px rgba(0,0,0,.55), 0 1px 3px rgba(0,0,0,.4);
  --le: #16a34a; --lx: #b45309; --se: #dc2626; --sx: #2563eb; --up: #22c55e; --down: #f87171;
}
.bar *, .bar *::before, .bar *::after { box-sizing: border-box; font: inherit; color: inherit; margin: 0; }
button { appearance: none; border: 0; background: none; padding: 0; cursor: pointer; }
button:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
.head { display: flex; align-items: center; gap: 4px; min-height: 34px; cursor: grab; touch-action: none; }
.dragging .head { cursor: grabbing; }
.grip { flex: none; color: var(--muted); opacity: .7; margin: 0 1px 0 2px; }
.dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #9ca3af; }
.dot.ok { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.18); }
.dot.idle { background: #22c55e; }
.dot.wait { background: #f59e0b; }
.dot.bad { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.18); }
.ctx { flex: 1; min-width: 0; padding: 3px 4px; border-radius: 7px; text-align: left; }
.ctx:hover { background: var(--chip); }
.line { display: flex; align-items: center; gap: 5px; min-width: 0; }
.sym { font-weight: 700; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ctx.warn .sym { color: #d97706; }
.meta { display: block; font-size: 10.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tag {
  position: absolute; top: -8px; right: 14px; font-weight: 800; font-size: 8.5px; line-height: 1; letter-spacing: .07em;
  padding: 3px 5px; border-radius: 5px; box-shadow: 0 0 0 2px var(--bg); pointer-events: none;
}
.tag:empty { display: none; }
.tag.sandbox { background: #fef3c7; color: #92400e; }
.tag.live { background: #fee2e2; color: #b91c1c; }
.px { flex: none; text-align: right; font-variant-numeric: tabular-nums; padding-right: 2px; }
.px[hidden] { display: none; }
.ltp { display: block; font-weight: 700; font-size: 12.5px; }
.chg { display: block; font-size: 10.5px; color: var(--muted); }
.chg.up { color: var(--up); } .chg.down { color: var(--down); }
.mode { flex: none; font-weight: 800; font-size: 9.5px; letter-spacing: .05em; padding: 5px 6px; border-radius: 6px; background: var(--chip); }
.mode:hover { filter: brightness(.96); }
.icon { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border-radius: 7px; color: var(--muted); }
.icon:hover { background: var(--chip); color: var(--fg); }
.logo { display: none; font-weight: 800; font-size: 11px; letter-spacing: .04em; padding: 4px 6px; border-radius: 6px; background: var(--chip); }
.actwrap { position: relative; z-index: 2; margin-top: 2px; } /* above our own toasts' shadows */
.actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.guard { position: absolute; inset: 0; pointer-events: none; }
.t {
  --tone: var(--le); position: relative; height: 40px; border-radius: 9px; color: #fff; background: var(--tone);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  box-shadow: inset 0 -2px 0 rgba(0,0,0,.14); transition: filter .12s, transform .06s;
}
.t.lx { --tone: var(--lx); } .t.se { --tone: var(--se); } .t.sx { --tone: var(--sx); }
.t b { font-weight: 800; font-size: 13px; line-height: 1; letter-spacing: .02em; }
.t small { font-weight: 700; font-size: 8.5px; line-height: 1; letter-spacing: .09em; opacity: .9; }
.t:hover { filter: brightness(1.08); }
.t:active { transform: translateY(1px); }
.t[disabled] { opacity: .5; cursor: progress; }
.t.armed { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--tone); animation: pulse 1s ease-in-out infinite; }
.t.loading b { opacity: 0; }
.t.loading::after {
  content: ""; position: absolute; top: 8px; left: 50%; width: 14px; height: 14px; margin-left: -7px;
  border: 2px solid rgba(255,255,255,.45); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite;
}
.collapsed { width: auto; min-width: 0; padding: 3px 4px; border-radius: 10px; }
.collapsed .head { min-height: 28px; gap: 5px; }
.collapsed .actwrap, .collapsed .ctx, .collapsed .mode, .collapsed .more, .collapsed .icon { display: none; }
.collapsed .logo { display: block; }
.collapsed .tag { display: none; }
.collapsed[data-env=sandbox] .logo { background: #fef3c7; color: #92400e; }
.collapsed[data-env=live] .logo { background: #fee2e2; color: #b91c1c; }
.toasts { position: absolute; z-index: 1; left: 0; top: calc(100% + 8px); width: max(100%, 264px); display: flex; flex-direction: column; gap: 6px; pointer-events: none; }
.up .toasts { top: auto; bottom: calc(100% + 8px); flex-direction: column-reverse; }
.right .toasts { left: auto; right: 0; }
.toast {
  --tc: #2563eb; pointer-events: auto; display: flex; gap: 8px; align-items: flex-start; padding: 9px 11px;
  border-radius: 10px; background: var(--bg); border: 1px solid var(--line); box-shadow: 0 6px 16px -6px rgba(15,23,42,.35);
  font-size: 12px; cursor: pointer; animation: tin .16s ease-out; user-select: text; -webkit-user-select: text;
}
.toast.success { --tc: #16a34a; } .toast.error { --tc: #dc2626; } .toast.warn { --tc: #d97706; }
.tdot { flex: none; width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; background: var(--tc); }
.toast b { display: block; font-weight: 650; line-height: 1.35; word-break: break-word; }
.toast small { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; word-break: break-word; }
.toast .hint { color: #6366f1; }
.chip { display: inline-block; margin-right: 6px; padding: 1px 4px; border-radius: 4px; background: #fef3c7; color: #92400e; font-size: 8.5px; font-weight: 800; letter-spacing: .06em; vertical-align: 1px; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { filter: brightness(1.18); } }
@keyframes tin { from { opacity: 0; transform: translateY(-4px); } }
@media (prefers-reduced-motion: reduce) { .t, .toast, .t.armed { animation: none; transition: none; } }
`;
})();
