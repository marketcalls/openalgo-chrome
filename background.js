/*
 * OpenAlgo service worker.
 *
 * Every REST and WebSocket call to OpenAlgo happens here, never in the web
 * page. Requests from the extension origin are allowed by host_permissions, so
 * they are not blocked by the page's CORS policy, mixed-content rules or CSP
 * (v1 fetched from the content script and failed with "Failed to fetch" on
 * every site except the OpenAlgo dashboard). The API key never leaves
 * extension-only storage.
 */
'use strict';
importScripts('shared.js');

const ORDER_TIMEOUT_MS = 15000;
const API_TIMEOUT_MS = 8000;
const WS_KEEPALIVE_MS = 20000;
const WS_IDLE_CLOSE_MS = 30000;
const WS_BACKOFF_S = [1, 2, 5, 10, 30, 60];

// Keep the API key away from content scripts (defence in depth: a compromised
// page renderer cannot read chrome.storage.local).
const restricted = chrome.storage.local.setAccessLevel
  ? chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})
  : Promise.resolve();
const ready = restricted.then(migrateV1).catch(() => {});

// ---------------------------------------------------------------- storage --

/** v1 kept hostUrl + apiKey in chrome.storage.sync (synced to the Google account). */
async function migrateV1() {
  const old = await chrome.storage.sync.get(['hostUrl', 'apiKey']);
  if (old.hostUrl === undefined && old.apiKey === undefined) return;
  const cur = await chrome.storage.local.get(['hostUrl', 'apiKey']);
  const patch = {};
  if (old.hostUrl && !cur.hostUrl) patch.hostUrl = OA.normalizeHost(old.hostUrl) || OA.CONN_DEFAULTS.hostUrl;
  if (old.apiKey && !cur.apiKey) patch.apiKey = String(old.apiKey).trim();
  await chrome.storage.local.set(patch);
  await chrome.storage.sync.remove(['hostUrl', 'apiKey']);
}

async function getConn() {
  await ready;
  return { ...OA.CONN_DEFAULTS, ...(await chrome.storage.local.get(OA.CONN_DEFAULTS)) };
}

const getConfig = () => chrome.storage.sync.get(OA.CONFIG_DEFAULTS);

// -------------------------------------------------------------------- api --

class OAError extends Error {
  constructor(message, kind = 'api') {
    super(message);
    this.kind = kind; // config | network | uncertain | api
  }
}

function errorText(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg === 'object') {
    return Object.entries(msg).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('; ');
  }
  return String(msg);
}

const CHECK_BOOK = 'The order may have been placed. Check the order book before retrying.';

/**
 * POST /api/v1/<path>. Resolves with the JSON body when status == "success".
 *
 * `order: true` marks requests that may reach the broker. For those, only a
 * JSON 4xx reply (or 429) proves nothing was placed; any other failure (lost
 * connection, timeout, 5xx, proxy error page) is reported as "uncertain" so the
 * trader checks the order book instead of clicking again and doubling up.
 */
async function api(path, body = {}, { order = false, conn } = {}) {
  conn = conn || (await getConn());
  if (!conn.hostUrl) throw new OAError('Set your OpenAlgo host URL in Settings.', 'config');
  if (!conn.apiKey) throw new OAError('Add your OpenAlgo API key in Settings.', 'config');

  const timeout = order ? ORDER_TIMEOUT_MS : API_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout); // also covers a stalled body
  let res;
  let data = null;
  try {
    try {
      res = await fetch(`${conn.hostUrl}/api/v1/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apikey: conn.apiKey, ...body }),
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      if (ctrl.signal.aborted) {
        throw new OAError(order ? `No reply in ${timeout / 1000}s. ${CHECK_BOOK}` : `OpenAlgo did not respond in ${timeout / 1000}s.`, order ? 'uncertain' : 'network');
      }
      // Connection refused (server down) and connection lost mid-request look
      // the same here. If the server answers a ping now, the request may well
      // have arrived.
      if (order && (await reachable(conn))) throw new OAError(`Connection to OpenAlgo dropped. ${CHECK_BOOK}`, 'uncertain');
      throw new OAError(`Cannot reach OpenAlgo at ${conn.hostUrl}. Is the server running?`, 'network');
    }
    try {
      data = await res.json();
    } catch {
      if (ctrl.signal.aborted && order) throw new OAError(`Reply interrupted. ${CHECK_BOOK}`, 'uncertain');
    }
  } finally {
    clearTimeout(timer);
  }

  const definitive = res.status >= 400 && res.status < 500;
  if (!data || typeof data !== 'object') {
    if (order && !definitive) throw new OAError(`OpenAlgo replied HTTP ${res.status} without details. ${CHECK_BOOK}`, 'uncertain');
    throw new OAError(`OpenAlgo replied HTTP ${res.status} without JSON. Check the host URL.`, 'api');
  }
  if (data.status !== 'success') {
    const text = errorText(data.message) || `Request failed (HTTP ${res.status}).`;
    if (res.status === 429) throw new OAError(`Rate limited: ${text}`, 'api');
    if (order && !definitive) throw new OAError(`${/[.!?]$/.test(text) ? text : `${text}.`} ${CHECK_BOOK}`, 'uncertain');
    throw new OAError(text, 'api');
  }
  return data;
}

async function reachable(conn) {
  try {
    const r = await fetch(`${conn.hostUrl}/api/v1/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: conn.apiKey }),
      signal: AbortSignal.timeout(4000),
      credentials: 'omit',
      cache: 'no-store',
    });
    return r.status > 0;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- orders --

const recentOrders = new Map(); // orderid -> label, for matching WebSocket order updates
const earlyUpdates = new Map(); // orderid -> [order_update], seen before the REST reply
let busy = false;

/**
 * Remembers an order so its WebSocket updates are shown. Fast fills (sandbox,
 * some brokers) reach the WebSocket before the REST reply names the order;
 * those are returned so the caller can fold them into one result message
 * instead of showing "Filled" before "Order sent". With merge=false they are
 * broadcast as separate alerts.
 */
function rememberOrder(data, label, merge = true) {
  const ids = data.orderid ? [data.orderid] : (data.results || []).map((r) => r.orderid).filter(Boolean);
  const early = [];
  for (const raw of ids) {
    const id = String(raw);
    recentOrders.set(id, label);
    for (const m of earlyUpdates.get(id) || []) {
      if (merge) {
        markSeen(m);
        early.push(m);
      } else {
        emitOrderUpdate(m, label);
      }
    }
    earlyUpdates.delete(id);
  }
  while (recentOrders.size > 100) recentOrders.delete(recentOrders.keys().next().value);
  return early;
}

function outcome(data, text, early = []) {
  if (data.mode === 'semi_auto') {
    return { ok: true, level: 'info', message: `${text}: queued for approval in Action Center.` };
  }
  const isNoop = /no action|already matched/i.test(errorText(data.message));
  const sandbox = data.mode === 'analyze';
  const order = data.orderid ? `Order ${data.orderid}` : '';
  const last = early[early.length - 1];
  const st = String(last?.order_status || '').toLowerCase();
  if (st === 'rejected') {
    return { ok: false, level: 'error', message: `Rejected: ${text}`, detail: last.rejection_reason || order, sandbox };
  }
  if (st === 'cancelled') return { ok: false, level: 'warn', message: `Cancelled: ${text}`, detail: order, sandbox };
  const px = Number(last?.average_price) || Number(last?.price);
  return {
    ok: true,
    level: isNoop ? 'info' : 'success',
    message: isNoop ? 'Position already matches. No order sent.' : text,
    detail: st === 'complete' ? `Filled${px ? ` @ ${OA.fmtPrice(px)}` : ''} · ${order}` : order,
    sandbox,
  };
}

async function trade(action) {
  const def = Object.hasOwn(OA.ACTIONS, action) ? OA.ACTIONS[action] : null;
  if (!def) throw new OAError('Unknown action.');
  if (busy) return { ok: false, level: 'warn', message: 'Previous order is still processing.' };
  busy = true;
  try {
    const cfg = await getConfig();
    if (cfg.mode !== def.mode) throw new OAError(`Switch to ${def.mode} mode first.`, 'config');
    const miss = OA.missing(cfg);
    if (miss.length) throw new OAError(`Set ${miss.join(' and ')} in OpenAlgo settings first.`, 'config');
    return def.mode === 'options' ? await optionsTrade(def, cfg) : await equityTrade(action, cfg);
  } finally {
    busy = false;
  }
}

async function equityTrade(action, cfg) {
  const inst = { symbol: cfg.symbol.trim().toUpperCase(), exchange: cfg.exchange, product: cfg.product };
  const qty = OA.posInt(cfg.quantity);

  if (action === 'LE' || action === 'SE') {
    const side = action === 'LE' ? 'BUY' : 'SELL';
    const data = await api('placeorder', {
      strategy: OA.STRATEGY, ...inst, action: side, pricetype: 'MARKET', quantity: String(qty),
    }, { order: true });
    const early = rememberOrder(data, `${action} ${inst.symbol}`);
    return outcome(data, `${action === 'LE' ? 'Long' : 'Short'} entry: ${side} ${qty} ${inst.symbol}`, early);
  }

  // LX / SX: only close the side the button names. A plain smart order with
  // position_size 0 would also flatten the opposite side (v1 behaviour).
  const pos = Number((await api('openposition', { strategy: OA.STRATEGY, ...inst })).quantity) || 0;
  const long = action === 'LX';
  if (pos === 0) return { ok: true, level: 'info', message: `No open ${inst.product} position in ${inst.symbol}.` };
  if (long ? pos < 0 : pos > 0) {
    return { ok: true, level: 'info', message: `No ${long ? 'long' : 'short'} position. ${inst.symbol} is ${pos > 0 ? 'long' : 'short'} ${Math.abs(pos)}.` };
  }
  const side = long ? 'SELL' : 'BUY';
  const data = await api('placesmartorder', {
    strategy: OA.STRATEGY, ...inst, action: side, pricetype: 'MARKET', quantity: '0', position_size: '0',
  }, { order: true });
  const early = rememberOrder(data, `${action} ${inst.symbol}`);
  return outcome(data, `${long ? 'Long' : 'Short'} exit: ${side} ${Math.abs(pos)} ${inst.symbol}`, early);
}

// Option entries resolve a strike from the live price, so exits must target the
// exact contract that was bought or sold, not "ATM" again. Those contracts are
// tracked in chrome.storage.local.optPositions = { CE: [...], PE: [...] }.

async function getTracked() {
  const { optPositions } = await chrome.storage.local.get('optPositions');
  return { CE: [], PE: [], ...(optPositions || {}) };
}

async function optionsTrade(def, cfg) {
  const type = def.type;
  const product = cfg.optProduct;

  if (!def.exit) {
    const side = cfg.optSide === 'SELL' ? 'SELL' : 'BUY';
    const underlying = cfg.optUnderlying.trim().toUpperCase();
    const qty = OA.posInt(cfg.optQuantity);
    const expiry = cfg.optExpiry || (await nearestExpiry(underlying, cfg.optExchange));
    const data = await api('optionsorder', {
      strategy: OA.STRATEGY, underlying, exchange: cfg.optExchange, expiry_date: expiry,
      offset: cfg.optOffset || 'ATM', option_type: type, action: side, quantity: String(qty),
      pricetype: 'MARKET', product, splitsize: '0',
    }, { order: true });
    if (data.symbol) {
      const tracked = await getTracked();
      const legs = tracked[type].filter((l) => !(l.symbol === data.symbol && l.product === product));
      legs.push({ symbol: data.symbol, exchange: data.exchange || OA.derivExchange(cfg.optExchange), product, side, ts: Date.now() });
      tracked[type] = legs.slice(-20);
      await chrome.storage.local.set({ optPositions: tracked });
    }
    const early = rememberOrder(data, `${type} ${data.symbol || ''}`);
    return outcome(data, `${side} ${qty} ${data.symbol || `${underlying} ${cfg.optOffset} ${type}`}`, early);
  }

  const tracked = await getTracked();
  const legs = tracked[type];
  if (!legs.length) {
    return { ok: true, level: 'info', message: `No ${type} position opened from this extension. Use Close all positions or your broker.` };
  }
  // Each leg is checked and saved on its own, so a failure part-way through
  // never forgets legs that were closed or keeps ones that were. Retrying an
  // exit is safe: the position check runs again first.
  const key = (l) => `${l.symbol}|${l.product}`;
  const untrack = async (leg) => {
    const latest = await getTracked();
    latest[type] = latest[type].filter((l) => key(l) !== key(leg));
    await chrome.storage.local.set({ optPositions: latest });
  };
  const sent = [];
  const notes = [];
  let level = 'success';
  let sandbox = false;
  for (const leg of legs) {
    const inst = { symbol: leg.symbol, exchange: leg.exchange, product: leg.product };
    try {
      const pos = Number((await api('openposition', { strategy: OA.STRATEGY, ...inst })).quantity) || 0;
      if (pos === 0) {
        await untrack(leg);
        notes.push(`${leg.symbol} already flat`);
        continue;
      }
      if (Math.sign(pos) !== (leg.side === 'SELL' ? -1 : 1)) {
        // Reversed outside the extension; closing it would exit someone else's position.
        await untrack(leg);
        notes.push(`${leg.symbol} is now ${pos > 0 ? 'long' : 'short'} ${Math.abs(pos)}; left open`);
        level = 'warn';
        continue;
      }
      const side = pos > 0 ? 'SELL' : 'BUY';
      const data = await api('placesmartorder', {
        strategy: OA.STRATEGY, ...inst, action: side, pricetype: 'MARKET', quantity: '0', position_size: '0',
      }, { order: true });
      sandbox ||= data.mode === 'analyze';
      if (data.mode === 'semi_auto') {
        notes.push(`${leg.symbol} queued for approval`); // stays tracked until it is really closed
        if (level === 'success') level = 'info';
        continue;
      }
      rememberOrder(data, `${type} exit ${leg.symbol}`, false);
      await untrack(leg);
      sent.push(`${side} ${Math.abs(pos)} ${leg.symbol}`);
    } catch (e) {
      notes.push(`${leg.symbol}: ${e.message}`); // stays tracked
      level = e.kind === 'uncertain' ? 'warn' : 'error';
      if (e.kind === 'config' || e.kind === 'network') break;
    }
  }
  const message = sent.length ? `${type} exit sent: ${sent.join(', ')}` : `${type} exit: nothing sent`;
  if (!sent.length && level === 'success') level = 'info';
  return { ok: level !== 'error', level, message, detail: notes.join(' · '), sandbox };
}

const expiryCache = new Map(); // "NIFTY|NFO" -> { at, list }

async function listExpiries(underlying, exchange) {
  const fx = OA.derivExchange(exchange);
  const key = `${underlying}|${fx}`;
  const hit = expiryCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.list;
  const data = await api('expiry', { symbol: underlying, exchange: fx, instrumenttype: 'options' });
  const today = OA.todayIST();
  const list = (data.data || [])
    .map(OA.compactExpiry)
    .filter((e) => OA.expiryTime(e) >= today)
    .sort((a, b) => OA.expiryTime(a) - OA.expiryTime(b));
  expiryCache.set(key, { at: Date.now(), list });
  return list;
}

async function nearestExpiry(underlying, exchange) {
  const list = await listExpiries(underlying, exchange);
  if (!list.length) throw new OAError(`No upcoming option expiry found for ${underlying}.`);
  return list[0];
}

// ------------------------------------------------------------ server info --

let serverInfo = { state: 'unknown', broker: '', analyze: null, error: '', at: 0 };

async function refreshServerInfo(force = false) {
  if (!force && Date.now() - serverInfo.at < 60000) return serverInfo;
  try {
    const conn = await getConn();
    const [ping, an] = await Promise.all([
      api('ping', {}, { conn }),
      api('analyzer', {}, { conn }).catch(() => null),
    ]);
    serverInfo = { state: 'ok', broker: ping.data?.broker || '', analyze: an ? !!an.data?.analyze_mode : null, error: '', at: Date.now() };
  } catch (e) {
    serverInfo = { state: e.kind === 'config' ? 'setup' : 'error', broker: '', analyze: null, error: e.message, at: Date.now() };
  }
  broadcast(statusMsg());
  return serverInfo;
}

// ------------------------------------------------------------- live data --

const live = {
  ws: null,
  state: 'off', // off | setup | connecting | live | error
  error: '',
  ports: new Set(),
  sub: null, // { symbol, exchange } currently subscribed
  quote: null,
  retry: 0,
  retryTimer: 0,
  idleTimer: 0,
  pingTimer: 0,
  lastPush: 0,
  pushTimer: 0,
  seen: new Set(),
};

const statusMsg = () => ({ type: 'status', server: serverInfo, live: { state: live.state, error: live.error } });

function broadcast(msg) {
  for (const p of live.ports) {
    try {
      p.postMessage(msg);
    } catch {
      live.ports.delete(p);
    }
  }
}

function setLive(state, error = '') {
  live.state = state;
  live.error = error;
  broadcast(statusMsg());
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'oa-live' || port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  live.ports.add(port);
  clearTimeout(live.idleTimer);
  port.onDisconnect.addListener(() => {
    live.ports.delete(port);
    if (!live.ports.size) live.idleTimer = setTimeout(stopLive, WS_IDLE_CLOSE_MS);
  });
  port.postMessage(statusMsg());
  if (live.quote) port.postMessage({ type: 'quote', ...live.quote });
  refreshServerInfo();
  syncLive();
});

async function syncLive() {
  const cfg = await getConfig();
  if (!cfg.liveData || !live.ports.size) return stopLive();
  if (!live.ws) return connectLive();
  if (live.state === 'live') subscribe(OA.liveInstrument(cfg));
}

function stopLive() {
  clearTimeout(live.retryTimer);
  clearInterval(live.pingTimer);
  const ws = live.ws;
  live.ws = null;
  live.sub = null;
  live.quote = null;
  if (ws) {
    try {
      ws.close(1000);
    } catch {
      /* already closed */
    }
  }
  setLive('off');
}

async function connectLive() {
  clearTimeout(live.retryTimer);
  const conn = await getConn();
  if (live.ws) return;
  if (!conn.hostUrl || !conn.apiKey) return setLive('setup', 'Add host and API key');
  const url = conn.wsUrl || OA.deriveWsUrl(conn.hostUrl);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    return setLive('error', `Invalid WebSocket URL: ${url}`);
  }
  live.ws = ws;
  live.sub = null;
  setLive('connecting');

  ws.onopen = () => ws.send(JSON.stringify({ action: 'authenticate', api_key: conn.apiKey }));
  ws.onmessage = (ev) => {
    if (live.ws === ws) onLiveMessage(ws, ev.data);
  };
  ws.onclose = () => {
    if (live.ws !== ws) return;
    clearInterval(live.pingTimer);
    live.ws = null;
    live.sub = null;
    if (!live.ports.size) return setLive('off');
    if (live.state !== 'error') setLive('error', `WebSocket closed (${url})`);
    const delay = WS_BACKOFF_S[Math.min(live.retry++, WS_BACKOFF_S.length - 1)];
    live.retryTimer = setTimeout(syncLive, delay * 1000);
  };
}

async function onLiveMessage(ws, raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (m.type === 'auth') {
    if (m.status !== 'success') {
      live.retry = WS_BACKOFF_S.length - 1; // bad key: back off to the slowest retry
      setLive('error', errorText(m.message) || 'WebSocket authentication failed');
      ws.close();
      return;
    }
    live.retry = 0;
    setLive('live');
    ws.send(JSON.stringify({ action: 'subscribe_orders' }));
    clearInterval(live.pingTimer);
    // Application-level traffic keeps the MV3 service worker alive while a bar is visible.
    live.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'ping' }));
    }, WS_KEEPALIVE_MS);
    subscribe(OA.liveInstrument(await getConfig()));
  } else if (m.type === 'market_data') {
    const s = live.sub;
    if (!s || m.symbol !== s.symbol || m.exchange !== s.exchange) return;
    const d = m.data || {};
    const ltp = Number(d.ltp);
    if (!Number.isFinite(ltp)) return;
    const close = Number(d.close ?? d.prev_close);
    live.quote = {
      symbol: s.symbol,
      exchange: s.exchange,
      ltp,
      close: Number.isFinite(close) && close > 0 ? close : live.quote?.close ?? null,
      at: Date.now(),
    };
    pushQuote();
  } else if (m.type === 'order_update') {
    const id = String(m.orderid);
    const label = recentOrders.get(id);
    if (label) return emitOrderUpdate(m, label);
    // Not ours, or ours but the REST reply has not arrived yet: hold briefly.
    const now = Date.now();
    m.receivedAt = now;
    earlyUpdates.set(id, [...(earlyUpdates.get(id) || []), m]);
    for (const [k, list] of earlyUpdates) if (now - list[0].receivedAt > 15000) earlyUpdates.delete(k);
    while (earlyUpdates.size > 200) earlyUpdates.delete(earlyUpdates.keys().next().value);
  } else if (m.type === 'subscribe' && m.status !== 'success') {
    setLive('live', errorText(m.message) || 'Subscription failed');
  }
}

/** Marks an update as handled; returns false if it was already handled. */
function markSeen(m) {
  const key = `${m.orderid}|${m.order_status}|${m.filled_quantity}`;
  if (live.seen.has(key)) return false;
  live.seen.add(key);
  if (live.seen.size > 300) live.seen.clear();
  return true;
}

/** Forwards an order update for an order this extension placed (deduplicated). */
function emitOrderUpdate(m, label) {
  if (!markSeen(m)) return;
  broadcast({
    type: 'order',
    label,
    orderid: String(m.orderid),
    status: String(m.order_status || ''),
    action: m.action,
    symbol: m.symbol,
    quantity: m.quantity,
    filled: m.filled_quantity,
    price: Number(m.average_price) || Number(m.price) || null,
    reason: m.rejection_reason || '',
    sandbox: m.mode === 'analyze',
  });
}

// Ticks can arrive many times a second; forward at most ~4 per second.
function pushQuote() {
  const wait = 250 - (Date.now() - live.lastPush);
  if (wait > 0) {
    if (!live.pushTimer) live.pushTimer = setTimeout(() => { live.pushTimer = 0; pushQuote(); }, wait);
    return;
  }
  live.lastPush = Date.now();
  if (live.quote) broadcast({ type: 'quote', ...live.quote });
}

function subscribe(inst) {
  const ws = live.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cur = live.sub;
  if (cur && inst && cur.symbol === inst.symbol && cur.exchange === inst.exchange) return;
  if (cur) ws.send(JSON.stringify({ action: 'unsubscribe', symbols: [{ ...cur, mode: 'Quote' }] }));
  live.sub = inst;
  live.quote = null;
  broadcast({ type: 'quote', symbol: inst?.symbol || '', exchange: inst?.exchange || '', ltp: null, close: null });
  if (inst) ws.send(JSON.stringify({ action: 'subscribe', mode: 'Quote', symbols: [inst] }));
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.hostUrl || changes.apiKey || changes.wsUrl)) {
    expiryCache.clear();
    serverInfo = { ...serverInfo, at: 0 };
    stopLive();
    if (live.ports.size) {
      refreshServerInfo(true);
      syncLive();
    }
  }
  if (area === 'sync' && ['mode', 'symbol', 'exchange', 'optUnderlying', 'optExchange', 'liveData'].some((k) => changes[k])) {
    syncLive();
  }
});

// --------------------------------------------------------------- messages --

const isExtensionPage = (sender) => typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));

async function openSettings() {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.runtime.openOptionsPage();
  }
  return { ok: true };
}

// `page: true` handlers are only callable from the extension's own pages.
const HANDLERS = {
  ready: { page: true, fn: async () => { await ready; return { ok: true }; } },
  trade: { fn: (m) => trade(String(m.action)) },
  openSettings: { fn: openSettings },
  status: { page: true, fn: async (m) => ({ ok: true, server: await refreshServerInfo(!!m.force), live: { state: live.state, error: live.error } }) },
  expiries: {
    page: true,
    fn: async () => {
      const cfg = await getConfig();
      expiryCache.clear();
      return { ok: true, list: await listExpiries(cfg.optUnderlying.trim().toUpperCase(), cfg.optExchange) };
    },
  },
  optionInfo: {
    page: true,
    fn: async () => {
      const cfg = await getConfig();
      const underlying = cfg.optUnderlying.trim().toUpperCase();
      const expiry = cfg.optExpiry || (await nearestExpiry(underlying, cfg.optExchange));
      const d = await api('optionsymbol', {
        underlying, exchange: cfg.optExchange, expiry_date: expiry, offset: cfg.optOffset || 'ATM', option_type: 'CE',
      });
      return { ok: true, symbol: d.symbol, lotsize: d.lotsize, expiry, ltp: d.underlying_ltp };
    },
  },
  position: {
    page: true,
    fn: async () => {
      const cfg = await getConfig();
      if (!cfg.symbol.trim()) return { ok: true, quantity: null };
      const d = await api('openposition', {
        strategy: OA.STRATEGY, symbol: cfg.symbol.trim().toUpperCase(), exchange: cfg.exchange, product: cfg.product,
      });
      return { ok: true, quantity: Number(d.quantity) || 0 };
    },
  },
  tracked: { page: true, fn: async () => ({ ok: true, tracked: await getTracked() }) },
  forgetTracked: {
    page: true,
    fn: async () => {
      await chrome.storage.local.remove('optPositions');
      return { ok: true };
    },
  },
  closeAll: {
    page: true,
    fn: async () => {
      const d = await api('closeposition', { strategy: OA.STRATEGY }, { order: true });
      await chrome.storage.local.remove('optPositions');
      return { ok: true, level: 'success', message: errorText(d.message) || 'All open positions closed.', sandbox: d.mode === 'analyze' };
    },
  },
  cancelAll: {
    page: true,
    fn: async () => {
      const d = await api('cancelallorder', { strategy: OA.STRATEGY }, { order: true });
      return { ok: true, level: 'success', message: errorText(d.message) || 'All open orders cancelled.', sandbox: d.mode === 'analyze' };
    },
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg.type !== 'string') return false;
  const h = Object.hasOwn(HANDLERS, msg.type) ? HANDLERS[msg.type] : null;
  if (!h || (h.page && !isExtensionPage(sender))) {
    sendResponse({ ok: false, level: 'error', message: 'Not allowed.' });
    return false;
  }
  Promise.resolve()
    .then(() => h.fn(msg, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, level: e.kind === 'uncertain' ? 'warn' : 'error', message: e.message || String(e), kind: e.kind }));
  return true; // async response
});

// ---------------------------------------------------------------- install --

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ready;
  // Tabs that were open before install/update have no (or an orphaned) content
  // script; inject the current one so the bar works without reloading them.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map((t) => chrome.scripting.executeScript({
    target: { tabId: t.id },
    files: ['shared.js', 'content.js'],
  }).catch(() => {})));
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
