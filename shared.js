/*
 * OpenAlgo Chrome extension: constants and helpers shared by the service
 * worker (importScripts), the popup (<script>) and the content script.
 * Plain script on purpose: no build step, no modules, no dependencies.
 */
'use strict';

// eslint-disable-next-line no-var
var OA = (() => {
  const STRATEGY = 'Chrome';

  // Non-secret settings: chrome.storage.sync (the content script reads these).
  // Key names for symbol/exchange/product/quantity match v1, so they carry over.
  const CONFIG_DEFAULTS = {
    mode: 'equity', // 'equity' | 'options'
    symbol: '',
    exchange: 'NSE',
    product: 'MIS',
    quantity: '',
    optUnderlying: 'NIFTY',
    optExchange: 'NSE_INDEX',
    optExpiry: '', // '' = nearest expiry, resolved at order time
    optOffset: 'ATM',
    optSide: 'BUY', // BUY = option buyer, SELL = option writer
    optProduct: 'MIS',
    optQuantity: '',
    barMode: 'all', // 'all' | 'selected' | 'off'
    siteRules: {}, // hostname -> true (show) | false (hide)
    confirmOrders: false,
    liveData: true,
    theme: 'auto', // 'auto' | 'light' | 'dark'
    barPos: null, // { fx, fy } fractions of the free viewport space
    barCollapsed: false,
  };

  // Secrets: chrome.storage.local only, restricted to extension pages + worker.
  const CONN_DEFAULTS = { hostUrl: 'http://127.0.0.1:5000', apiKey: '', wsUrl: '' };

  const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'BCD', 'MCX', 'NCDEX', 'NCO'];
  const PRODUCTS = ['MIS', 'NRML', 'CNC'];
  const OPT_EXCHANGES = ['NSE_INDEX', 'BSE_INDEX', 'NSE', 'BSE', 'NFO', 'BFO'];
  const OPT_PRODUCTS = ['MIS', 'NRML'];
  const OFFSETS = [
    ...Array.from({ length: 10 }, (_, i) => `ITM${10 - i}`),
    'ATM',
    ...Array.from({ length: 10 }, (_, i) => `OTM${i + 1}`),
  ];

  // Every order the extension can send. Content scripts may only name one of these.
  const ACTIONS = {
    LE: { mode: 'equity', label: 'LE', sub: 'BUY', tone: 'le', title: 'Long entry: BUY at market' },
    LX: { mode: 'equity', label: 'LX', sub: 'EXIT', tone: 'lx', title: 'Long exit: close the long position' },
    SE: { mode: 'equity', label: 'SE', sub: 'SELL', tone: 'se', title: 'Short entry: SELL at market' },
    SX: { mode: 'equity', label: 'SX', sub: 'EXIT', tone: 'sx', title: 'Short exit: close the short position' },
    CE_ENTRY: { mode: 'options', label: 'CE', sub: 'BUY', tone: 'le', type: 'CE', title: 'Call entry' },
    CE_EXIT: { mode: 'options', label: 'CE', sub: 'EXIT', tone: 'lx', type: 'CE', exit: true, title: 'Exit calls opened here' },
    PE_ENTRY: { mode: 'options', label: 'PE', sub: 'BUY', tone: 'se', type: 'PE', title: 'Put entry' },
    PE_EXIT: { mode: 'options', label: 'PE', sub: 'EXIT', tone: 'sx', type: 'PE', exit: true, title: 'Exit puts opened here' },
  };

  /** The four buttons for the current mode, with labels resolved for option side. */
  function actionsFor(cfg) {
    return Object.entries(ACTIONS)
      .filter(([, a]) => a.mode === cfg.mode)
      .map(([id, a]) => {
        if (a.mode !== 'options' || a.exit) return { id, ...a };
        const side = cfg.optSide === 'SELL' ? 'SELL' : 'BUY';
        return { id, ...a, sub: side, title: `${side} ${a.type} (${cfg.optOffset || 'ATM'}) at market` };
      });
  }

  function barVisible(cfg, hostname) {
    const rule = (cfg.siteRules || {})[hostname];
    if (cfg.barMode === 'off') return false;
    if (cfg.barMode === 'selected') return rule === true;
    return rule !== false;
  }

  /** Short description of what the buttons will trade, e.g. "SBIN · NSE · MIS · 10". */
  function summary(cfg) {
    if (cfg.mode === 'options') {
      const exp = cfg.optExpiry ? cfg.optExpiry.slice(0, 5) : 'Nearest';
      return { title: cfg.optUnderlying || 'Set underlying', meta: `${cfg.optOffset} · ${exp} · Qty ${cfg.optQuantity || '?'}` };
    }
    return { title: cfg.symbol || 'Set symbol', meta: `${cfg.exchange} · ${cfg.product} · Qty ${cfg.quantity || '?'}` };
  }

  /** Fields that must be filled before the current mode can trade. */
  function missing(cfg) {
    const out = [];
    if (cfg.mode === 'options') {
      if (!String(cfg.optUnderlying || '').trim()) out.push('underlying');
      if (!posInt(cfg.optQuantity)) out.push('quantity');
    } else {
      if (!String(cfg.symbol || '').trim()) out.push('symbol');
      if (!posInt(cfg.quantity)) out.push('quantity');
    }
    return out;
  }

  /** The instrument whose price the bar shows. */
  function liveInstrument(cfg) {
    if (cfg.mode === 'options') {
      const symbol = String(cfg.optUnderlying || '').trim().toUpperCase();
      return symbol ? { symbol, exchange: cfg.optExchange } : null;
    }
    const symbol = String(cfg.symbol || '').trim().toUpperCase();
    return symbol ? { symbol, exchange: cfg.exchange } : null;
  }

  function posInt(v) {
    const n = Number(String(v ?? '').trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  }

  /** Accepts "127.0.0.1:5000", "http://host:5000/", etc. Returns origin or null. */
  function normalizeHost(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
    try {
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || !u.hostname) return null;
      return u.origin;
    } catch {
      return null;
    }
  }

  function normalizeWs(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      if (!/^wss?:$/.test(u.protocol) || u.username || u.password) return null;
      return u.href.replace(/\/$/, '');
    } catch {
      return null;
    }
  }

  function isLocalHost(hostname) {
    return /^(localhost|127(\.\d+){3}|\[::1\]|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/i.test(hostname)
      || hostname.endsWith('.local') || hostname.endsWith('.localhost');
  }

  /** Default WebSocket URL: ws://host:8765 locally, wss://domain/ws behind a proxy. */
  function deriveWsUrl(hostUrl) {
    try {
      const u = new URL(hostUrl);
      if (isLocalHost(u.hostname)) return `ws://${u.hostname}:8765`;
      return `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`;
    } catch {
      return '';
    }
  }

  /** True when an API key would travel unencrypted over the internet. */
  function insecureRemote(hostUrl) {
    try {
      const u = new URL(hostUrl);
      return u.protocol === 'http:' && !isLocalHost(u.hostname);
    } catch {
      return false;
    }
  }

  /** "01-DEC-26" or "01DEC26" -> "01DEC26" */
  function compactExpiry(s) {
    const m = /^(\d{1,2})-?([A-Za-z]{3})-?(\d{2}|\d{4})$/.exec(String(s || '').trim());
    if (!m) return '';
    return `${m[1].padStart(2, '0')}${m[2].toUpperCase()}${m[3].slice(-2)}`;
  }

  const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  /** "01DEC26" -> UTC midnight timestamp, or NaN. */
  function expiryTime(compact) {
    const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(compact || '');
    const mon = m ? MONTHS.indexOf(m[2]) : -1;
    return mon < 0 ? NaN : Date.UTC(2000 + Number(m[3]), mon, Number(m[1]));
  }

  /** Today's date in India (exchange time) as a UTC-midnight timestamp. */
  function todayIST(now = Date.now()) {
    const d = new Date(now + 330 * 60 * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  /** Exchange to look up option expiries on, for an optionsorder underlying exchange. */
  function derivExchange(ex) {
    return /^BSE|^BFO/.test(ex) ? 'BFO' : 'NFO';
  }

  const nf = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtPrice = (n) => (Number.isFinite(n) ? nf.format(n) : '');

  return Object.freeze({
    STRATEGY, CONFIG_DEFAULTS, CONN_DEFAULTS, EXCHANGES, PRODUCTS, OPT_EXCHANGES, OPT_PRODUCTS,
    OFFSETS, ACTIONS, actionsFor, barVisible, summary, missing, liveInstrument, posInt,
    normalizeHost, normalizeWs, deriveWsUrl, insecureRemote, isLocalHost, compactExpiry,
    expiryTime, todayIST, derivExchange, fmtPrice,
  });
})();
