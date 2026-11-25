/* OpenAlgo popup / settings page. Settings save automatically as you type. */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const TEXT = ['symbol', 'quantity', 'optUnderlying', 'optQuantity'];
  const SELECTS = ['exchange', 'product', 'optExchange', 'optExpiry', 'optOffset', 'optSide', 'optProduct', 'barMode', 'theme'];
  const TOGGLES = ['confirmOrders', 'liveData'];

  let cfg = { ...OA.CONFIG_DEFAULTS };
  let conn = { ...OA.CONN_DEFAULTS };
  let site = '';
  let busy = false;
  let armed = null;
  let armTimer = 0;
  let quote = null;
  let server = null;
  let live = null;
  let position = null;

  init();

  async function init() {
    $('version').textContent = `v${chrome.runtime.getManifest().version}`;
    chrome.tabs.getCurrent().then((t) => t && document.body.classList.add('page')).catch(() => {});

    fill('exchange', OA.EXCHANGES);
    fill('product', OA.PRODUCTS);
    fill('optExchange', OA.OPT_EXCHANGES, (v) => v.replace('_', ' '));
    fill('optProduct', OA.OPT_PRODUCTS);
    fill('optOffset', OA.OFFSETS, (v) => (v === 'ATM' ? 'ATM' : v.replace(/(\D+)(\d+)/, '$1 $2')));

    await send({ type: 'ready' }); // lets the worker finish migrating v1 settings
    const [c, k, tabs] = await Promise.all([
      chrome.storage.sync.get(OA.CONFIG_DEFAULTS),
      chrome.storage.local.get(OA.CONN_DEFAULTS),
      chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
    ]);
    cfg = c;
    conn = { ...OA.CONN_DEFAULTS, ...k };
    try {
      const u = new URL(tabs[0]?.url || '');
      if (/^https?:$/.test(u.protocol)) site = u.hostname;
    } catch {
      /* chrome:// or no tab */
    }

    populate();
    bind();
    chrome.storage.onChanged.addListener(onStorageChanged);
    selectTab(conn.apiKey ? remembered() : 'settings');
    renderActions();
    renderStatus();
    connectPort();
    send({ type: 'status' }).then((r) => {
      if (r?.ok) {
        server = r.server;
        live = r.live;
        renderStatus();
      }
    });
    refreshPosition();
    refreshTracked();
    if (cfg.mode === 'options') loadOptionInfo();
  }

  // ------------------------------------------------------------- populate --

  function fill(id, values, label = (v) => v) {
    $(id).replaceChildren(...values.map((v) => new Option(label(v), v)));
  }

  function populate() {
    for (const id of TEXT) $(id).value = cfg[id] ?? '';
    for (const id of SELECTS) {
      if (id === 'optExpiry') ensureExpiryOption(cfg.optExpiry);
      $(id).value = cfg[id] ?? '';
    }
    for (const id of TOGGLES) $(id).checked = !!cfg[id];
    $('hostUrl').value = conn.hostUrl;
    $('apiKey').value = conn.apiKey;
    $('wsUrl').value = conn.wsUrl;
    $('wsUrl').placeholder = OA.deriveWsUrl(conn.hostUrl) || 'ws://127.0.0.1:8765';
    renderMode();
    renderSite();
    renderHostWarn();
  }

  function ensureExpiryOption(v) {
    if (v && ![...$('optExpiry').options].some((o) => o.value === v)) $('optExpiry').append(new Option(v, v));
  }

  // ----------------------------------------------------------------- bind --

  function bind() {
    for (const b of document.querySelectorAll('[role=tab]')) b.addEventListener('click', () => selectTab(b.id.slice(4)));
    for (const b of document.querySelectorAll('[data-goto]')) b.addEventListener('click', () => selectTab(b.dataset.goto));

    for (const b of document.querySelectorAll('.seg button')) {
      b.addEventListener('click', () => {
        save({ mode: b.dataset.mode });
        renderMode();
        renderActions();
        renderQuote();
        if (cfg.mode === 'options') loadOptionInfo();
        else refreshPosition();
      });
    }

    for (const id of TEXT) {
      $(id).addEventListener('input', () => {
        const el = $(id);
        if (/quantity/i.test(id)) el.setAttribute('aria-invalid', String(el.value !== '' && !OA.posInt(el.value)));
        clearTimeout(pending.get(id));
        pending.set(id, setTimeout(() => commitText(id), 350));
      });
      $(id).addEventListener('change', () => commitText(id));
    }

    for (const id of SELECTS) {
      $(id).addEventListener('change', () => {
        save({ [id]: $(id).value });
        if (id === 'barMode') renderSite();
        if (id === 'optSide') renderActions();
        if (id === 'optExchange') resetExpiry();
        if (id === 'exchange' || id === 'product') refreshPosition();
        if (id.startsWith('opt')) loadOptionInfo();
        renderQuote();
      });
    }
    for (const id of TOGGLES) $(id).addEventListener('change', () => {
      save({ [id]: $(id).checked });
      renderQuote();
    });

    $('siteOn').addEventListener('change', () => {
      const rules = { ...(cfg.siteRules || {}) };
      const on = $('siteOn').checked;
      if (cfg.barMode === 'selected') {
        if (on) rules[site] = true;
        else delete rules[site];
      } else if (on) delete rules[site];
      else rules[site] = false;
      save({ siteRules: rules });
    });
    $('resetPos').addEventListener('click', () => {
      save({ barPos: null, barCollapsed: false });
    });

    for (const id of ['hostUrl', 'apiKey', 'wsUrl']) {
      $(id).addEventListener('change', saveConn);
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') testConnection();
      });
    }
    $('hostUrl').addEventListener('input', renderHostWarn);
    $('toggleKey').addEventListener('click', () => {
      const show = $('apiKey').type === 'password';
      $('apiKey').type = show ? 'text' : 'password';
      $('toggleKey').setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
    });
    $('test').addEventListener('click', testConnection);

    $('loadExpiries').addEventListener('click', loadExpiries);
    $('forget').addEventListener('click', async () => {
      await send({ type: 'forgetTracked' });
      refreshTracked();
    });
    for (const id of ['closeAll', 'cancelAll']) $(id).addEventListener('click', () => accountAction(id));
  }

  // ------------------------------------------------------------------ tabs --

  function remembered() {
    try {
      return localStorage.getItem('oa-tab') === 'settings' ? 'settings' : 'trade';
    } catch {
      return 'trade';
    }
  }

  function selectTab(name) {
    for (const b of document.querySelectorAll('[role=tab]')) b.setAttribute('aria-selected', String(b.id === `tab-${name}`));
    $('panel-trade').hidden = name !== 'trade';
    $('panel-settings').hidden = name !== 'settings';
    try {
      localStorage.setItem('oa-tab', name);
    } catch {
      /* storage blocked */
    }
  }

  // ---------------------------------------------------------------- saving --

  let savedTimer = 0;
  function flashSaved(text = 'Saved') {
    $('saved').textContent = text;
    $('saved').classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => $('saved').classList.remove('show'), 1200);
  }

  const pending = new Map(); // text field id -> debounce timer
  const inflight = new Set(); // storage writes not yet confirmed

  /** Saves to chrome.storage.sync; resolves true/false (never rejects). */
  function save(patch) {
    Object.assign(cfg, patch);
    const p = chrome.storage.sync.set(patch).then(() => {
      flashSaved();
      return true;
    }, (e) => {
      flashSaved(`Not saved: ${e.message}`);
      return false;
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  }

  function commitText(id) {
    clearTimeout(pending.get(id));
    pending.delete(id);
    const el = $(id);
    const v = /symbol|underlying/i.test(id) ? el.value.trim().toUpperCase() : el.value.trim();
    if (cfg[id] === v) return Promise.resolve(true);
    const p = save({ [id]: v });
    renderQuote();
    if (id === 'symbol') refreshPosition();
    if (id === 'optUnderlying') resetExpiry();
    if (id.startsWith('opt')) loadOptionInfo();
    return p;
  }

  /** Commits half-typed fields so an order never uses stale settings. */
  async function flushPending() {
    const results = await Promise.all([...[...pending.keys()].map(commitText), ...inflight]);
    return results.every((r) => r !== false);
  }

  /** Keeps the popup in step with changes made from the bar or another device. */
  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.optPositions) refreshTracked();
    if (area !== 'sync') return;
    let changed = false;
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (!(k in OA.CONFIG_DEFAULTS)) continue;
      const v = newValue === undefined ? OA.CONFIG_DEFAULTS[k] : newValue;
      if (JSON.stringify(cfg[k]) === JSON.stringify(v)) continue; // our own write
      cfg[k] = v;
      changed = true;
      const el = $(k);
      if (!el || document.activeElement === el || pending.has(k)) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else {
        if (k === 'optExpiry') ensureExpiryOption(v);
        el.value = v ?? '';
      }
    }
    if (!changed) return;
    renderMode();
    renderActions();
    renderSite();
    renderQuote();
  }

  async function saveConn() {
    const host = OA.normalizeHost($('hostUrl').value);
    const ws = OA.normalizeWs($('wsUrl').value);
    $('hostUrl').setAttribute('aria-invalid', String(host === null));
    $('wsUrl').setAttribute('aria-invalid', String(ws === null));
    if (host === null || ws === null) {
      renderHostWarn();
      return false;
    }
    const next = { hostUrl: host || OA.CONN_DEFAULTS.hostUrl, apiKey: $('apiKey').value.trim(), wsUrl: ws };
    $('hostUrl').value = next.hostUrl;
    $('wsUrl').placeholder = OA.deriveWsUrl(next.hostUrl);
    if (next.hostUrl === conn.hostUrl && next.apiKey === conn.apiKey && next.wsUrl === conn.wsUrl) return true;
    conn = next;
    await chrome.storage.local.set(next);
    flashSaved();
    renderHostWarn();
    return true;
  }

  async function testConnection() {
    if (!(await saveConn())) return;
    const out = $('testResult');
    out.className = 'test-result';
    out.textContent = 'Testing…';
    $('test').disabled = true;
    const r = await send({ type: 'status', force: true });
    $('test').disabled = false;
    if (r?.ok) {
      server = r.server;
      live = r.live;
      renderStatus();
    }
    const s = r?.server;
    if (s?.state === 'ok') {
      out.className = 'test-result ok';
      out.textContent = `✓ Connected to ${s.broker || 'OpenAlgo'}${s.analyze === true ? ' · Sandbox' : s.analyze === false ? ' · Live' : ''}`;
      refreshPosition();
    } else {
      out.className = 'test-result bad';
      out.textContent = s?.error || r?.message || 'Connection failed';
    }
  }

  // ---------------------------------------------------------------- render --

  function renderMode() {
    for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-checked', String(b.dataset.mode === cfg.mode));
    $('equity').hidden = cfg.mode === 'options';
    $('options').hidden = cfg.mode !== 'options';
    refreshTracked();
  }

  function renderSite() {
    $('siteRow').hidden = !site || cfg.barMode === 'off';
    $('siteName').textContent = site;
    $('siteOn').checked = OA.barVisible(cfg, site);
  }

  function renderHostWarn() {
    const raw = $('hostUrl').value;
    const host = OA.normalizeHost(raw);
    const w = $('hostWarn');
    if (host === null) {
      w.textContent = 'Enter a valid http:// or https:// address.';
      w.hidden = false;
    } else if (host && OA.insecureRemote(host)) {
      w.textContent = 'This server is reached over plain http://, so your API key travels unencrypted. Use https:// for remote servers.';
      w.hidden = false;
    } else {
      w.hidden = true;
    }
  }

  function renderStatus() {
    const pill = $('conn');
    const label = pill.querySelector('span');
    let cls = 'pill';
    let text = 'Checking…';
    let title = '';
    if (!conn.apiKey || server?.state === 'setup') {
      text = 'Not set up';
    } else if (server?.state === 'error') {
      cls += ' bad';
      text = 'Offline';
      title = server.error;
    } else if (server?.state === 'ok') {
      cls += server.analyze === true ? ' ok sandbox' : server.analyze === false ? ' ok live' : ' ok';
      text = `${server.analyze === true ? 'Sandbox' : server.analyze === false ? 'Live' : 'Connected'}${server.broker ? ` · ${server.broker}` : ''}`;
      title = server.analyze === true ? 'Analyzer mode: orders are simulated' : server.analyze === false ? 'Live mode: orders go to your broker' : '';
    }
    pill.className = cls;
    label.textContent = text;
    pill.title = title;
    $('setup').hidden = !!conn.apiKey && server?.state !== 'setup';
    renderQuote();
  }

  function renderQuote() {
    const inst = OA.liveInstrument(cfg);
    $('qsym').textContent = inst ? `${inst.symbol} · ${inst.exchange.replace('_', ' ')}` : 'No symbol set';
    const ok = quote && inst && quote.symbol === inst.symbol && quote.exchange === inst.exchange && Number.isFinite(quote.ltp);
    $('qltp').textContent = ok ? OA.fmtPrice(quote.ltp) : '';
    if (ok && quote.close) {
      const pct = ((quote.ltp - quote.close) / quote.close) * 100;
      $('qchg').textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      $('qchg').className = `qchg ${pct >= 0 ? 'up' : 'down'}`;
    } else {
      $('qchg').textContent = !inst || ok ? '' : !cfg.liveData ? 'Live data off' : live?.state === 'live' ? 'Waiting for ticks…' : live?.state === 'error' ? 'Live data unavailable' : '';
      $('qchg').className = 'qchg';
      $('qchg').title = live?.error || '';
    }
    const showPos = cfg.mode === 'equity' && position !== null;
    $('qpos').textContent = showPos ? `Pos ${position > 0 ? '+' : ''}${position}` : '';
    $('qpos').className = `qpos ${showPos && position > 0 ? 'long' : showPos && position < 0 ? 'short' : ''}`;
  }

  function renderActions() {
    const acts = OA.actionsFor(cfg);
    $('actions').replaceChildren(...acts.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `t ${a.tone}${armed === a.id ? ' armed' : ''}${busy === a.id ? ' loading' : ''}`;
      b.title = a.title;
      b.disabled = !!busy;
      const big = document.createElement('b');
      big.textContent = a.label;
      const small = document.createElement('small');
      small.textContent = armed === a.id ? 'SURE?' : a.sub;
      b.append(big, small);
      b.addEventListener('click', () => onTrade(a.id));
      return b;
    }));
  }

  function showResult(res) {
    const el = $('result');
    el.className = `result ${res.level || (res.ok ? 'success' : 'error')}`;
    const b = document.createElement('div');
    b.textContent = res.message || '';
    if (res.sandbox) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = 'SANDBOX';
      b.append(chip);
    }
    el.replaceChildren(b);
    if (res.detail) {
      const s = document.createElement('small');
      s.textContent = res.detail;
      el.append(s);
    }
  }

  // ---------------------------------------------------------------- trading --

  async function onTrade(action) {
    if (busy) return;
    if (cfg.confirmOrders && armed !== action) {
      armed = action;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = null;
        renderActions();
      }, 3000);
      renderActions();
      return;
    }
    armed = null;
    busy = action;
    renderActions();
    if (!(await flushPending())) {
      busy = false;
      renderActions();
      showResult({ ok: false, level: 'error', message: 'Settings could not be saved, so no order was sent.' });
      return;
    }
    const res = await send({ type: 'trade', action });
    busy = false;
    renderActions();
    showResult(res || { ok: false, message: 'No response from the extension.' });
    if (res?.kind === 'config' && !conn.apiKey) selectTab('settings');
    refreshPosition();
    refreshTracked();
  }

  async function accountAction(id) {
    const btn = $(id);
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.dataset.label = btn.textContent;
      btn.textContent = 'Click again to confirm';
      setTimeout(() => {
        btn.classList.remove('armed');
        if (btn.dataset.label) btn.textContent = btn.dataset.label;
      }, 4000);
      return;
    }
    btn.classList.remove('armed');
    btn.textContent = btn.dataset.label;
    btn.disabled = true;
    const res = await send({ type: id });
    btn.disabled = false;
    showResult(res || { ok: false, message: 'No response from the extension.' });
    refreshPosition();
    refreshTracked();
  }

  let posSeq = 0;
  async function refreshPosition() {
    const seq = ++posSeq;
    if (cfg.mode !== 'equity' || !conn.apiKey || !cfg.symbol) {
      position = null;
      renderQuote();
      return;
    }
    const r = await send({ type: 'position' });
    if (seq !== posSeq) return;
    position = r?.ok ? r.quantity : null;
    renderQuote();
  }

  async function refreshTracked() {
    if (cfg.mode !== 'options') {
      $('tracked').hidden = true;
      return;
    }
    const r = await send({ type: 'tracked' });
    const legs = r?.ok ? [...r.tracked.CE, ...r.tracked.PE] : [];
    $('tracked').hidden = !legs.length;
    $('trackedList').replaceChildren(...legs.map((l) => {
      const li = document.createElement('li');
      const a = document.createElement('span');
      a.textContent = l.symbol;
      const b = document.createElement('span');
      b.textContent = `${l.side} · ${l.product}`;
      li.append(a, b);
      return li;
    }));
  }

  function resetExpiry() {
    $('optExpiry').replaceChildren(new Option('Nearest expiry (auto)', ''));
    if (cfg.optExpiry) save({ optExpiry: '' });
  }

  async function loadExpiries() {
    const btn = $('loadExpiries');
    btn.disabled = true;
    const r = await send({ type: 'expiries' });
    btn.disabled = false;
    if (!r?.ok) {
      $('optInfo').textContent = r?.message || 'Could not load expiries.';
      return;
    }
    const sel = $('optExpiry');
    const keep = cfg.optExpiry;
    sel.replaceChildren(new Option('Nearest expiry (auto)', ''), ...r.list.slice(0, 24).map((e) => new Option(e, e)));
    if (keep && r.list.includes(keep)) sel.value = keep;
    else if (keep) save({ optExpiry: '' });
    $('optInfo').textContent = r.list.length ? `${r.list.length} upcoming expiries loaded.` : 'No upcoming expiries found.';
    loadOptionInfo();
  }

  let infoTimer = 0;
  function loadOptionInfo() {
    clearTimeout(infoTimer);
    infoTimer = setTimeout(async () => {
      if (cfg.mode !== 'options' || !conn.apiKey || !cfg.optUnderlying) return;
      const r = await send({ type: 'optionInfo' });
      if (!r?.ok) {
        $('optInfo').textContent = r?.message || '';
        return;
      }
      const lots = OA.posInt(cfg.optQuantity) && r.lotsize ? OA.posInt(cfg.optQuantity) / r.lotsize : null;
      const lotText = lots ? (Number.isInteger(lots) ? ` · ${lots} lot${lots === 1 ? '' : 's'}` : ' · not a whole lot!') : '';
      $('optInfo').textContent = `Lot size ${r.lotsize}${lotText} · ${cfg.optOffset} CE right now: ${r.symbol}`;
    }, 300);
  }

  // ------------------------------------------------------------------ live --

  // Live data only while this page is visible (the settings page can sit in a
  // background tab; it should not keep the WebSocket open there).
  let port = null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') connectPort();
    else {
      port?.disconnect();
      port = null;
    }
  });

  function connectPort() {
    if (port || document.visibilityState !== 'visible') return;
    try {
      port = chrome.runtime.connect({ name: 'oa-live' });
    } catch {
      return;
    }
    port.onMessage.addListener((m) => {
      if (m.type === 'status') {
        server = m.server;
        live = m.live;
        renderStatus();
      } else if (m.type === 'quote') {
        quote = m;
        renderQuote();
      } else if (m.type === 'order') {
        const st = String(m.status).toLowerCase();
        if (st === 'complete') showResult({ ok: true, level: 'success', message: `Filled: ${m.action} ${m.filled || m.quantity} ${m.symbol}`, detail: m.price ? `Avg ${OA.fmtPrice(m.price)} · Order ${m.orderid}` : '', sandbox: m.sandbox });
        else if (st === 'rejected') showResult({ ok: false, level: 'error', message: `Rejected: ${m.symbol}`, detail: m.reason, sandbox: m.sandbox });
        refreshPosition();
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 1000);
    });
  }

  async function send(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { ok: false, level: 'error', message: e.message };
    }
  }
})();
