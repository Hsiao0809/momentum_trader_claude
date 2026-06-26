const STATE_KEY = 'paper-state-v1';
const LOCK_KEY = 'paper-lock-v1';
const OKX_API = 'https://www.okx.com';
const INTERVAL_MS = { '15m': 900000 };

const LABELS = {
  pullback_uptrend: '上升趨勢回檔',
  strong_momentum_breakout: '強動量突破追價',
  volume_ignition: '放量啟動追隨',
  high_range_continuation: '高位續勢承接',
  narrative_momentum: '題材動量順勢',
};

const DEFAULT_CFG = {
  initialEquity: 1000,
  riskPerTrade: 0.01,
  maxPositions: 5,
  maxTotalRisk: 0.05,
  minQuoteVolume: 20000000,
  minSignalScore: 70,
  paperMinScore: 82,
  maxHoldHours: 72,
  cooldownBars: 96,
  symbolStopCooldownMs: 24 * 60 * 60 * 1000,
  scanLimit: 35,
  maxKlineScans: 28,
  anomalyScanLimit: 20,
  coreScanLimit: 6,
  coreScanEveryMs: 30 * 60 * 1000,
  extendedScanStart: 35,
  extendedScanEnd: 160,
  extendedScanBatch: 8,
  scanRequestDelayMs: 120,
  scanStaleMs: 5 * 60 * 1000,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runPaperTick(env, { reason: 'cron' }));
  },
};

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'momentum-trader-claude-runner' });
    }

    if (request.method === 'GET' && url.pathname === '/state') {
      return json({ ok: true, state: await loadState(env) });
    }

    if (request.method === 'POST' && url.pathname === '/start') {
      const body = await readJson(request);
      const state = await loadState(env);
      applyConfig(state, body);
      state.running = true;
      state.lastError = null;
      state.updatedBy = 'start';
      await saveState(env, state);
      await runPaperTick(env, { forceScan: true, reason: 'manual-start' });
      return json({ ok: true, state: await loadState(env) });
    }

    if (request.method === 'POST' && url.pathname === '/stop') {
      const state = await loadState(env);
      state.running = false;
      state.updatedBy = 'stop';
      await saveState(env, state);
      return json({ ok: true, state });
    }

    if (request.method === 'POST' && url.pathname === '/reset') {
      const body = await readJson(request);
      const state = defaultState();
      applyConfig(state, body);
      state.updatedBy = 'reset';
      await saveState(env, state);
      return json({ ok: true, state });
    }

    if (request.method === 'POST' && url.pathname === '/config') {
      const body = await readJson(request);
      const state = await loadState(env);
      applyConfig(state, body);
      state.updatedBy = 'config';
      await saveState(env, state);
      return json({ ok: true, state });
    }

    if (request.method === 'POST' && url.pathname === '/scan') {
      await runPaperTick(env, { forceScan: true, onlyScan: true, reason: 'manual-scan' });
      return json({ ok: true, state: await loadState(env) });
    }

    if (request.method === 'POST' && url.pathname === '/tick') {
      await runPaperTick(env, { forceScan: url.searchParams.get('forceScan') === '1', reason: 'manual-tick' });
      return json({ ok: true, state: await loadState(env) });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (error) {
    const state = await loadState(env).catch(() => null);
    if (state) {
      state.lastError = `${error.message || error}`;
      state.lastErrorAt = Date.now();
      await saveState(env, state).catch(() => {});
    }
    return json({ ok: false, error: error.message || String(error) }, 500);
  }
}

async function runPaperTick(env, options = {}) {
  const now = Date.now();
  const lock = await env.PAPER_STATE.get(LOCK_KEY, 'json');
  if (lock?.expiresAt && lock.expiresAt > now) return;
  await env.PAPER_STATE.put(LOCK_KEY, JSON.stringify({ expiresAt: now + 55000 }), { expirationTtl: 60 });

  try {
    const state = await loadState(env);
    state.lastRunAt = now;
    state.lastRunReason = options.reason || 'unknown';
    state.marketProvider = 'okx-usdt-swap';

    if (!state.running && !state.positions.length && !options.forceScan && !options.onlyScan) {
      return;
    }

    const scanStale = !state.signals.length || now - (state.lastScanAt || 0) > state.cfg.scanStaleMs;
    const willScan = options.forceScan || scanStale;
    await updatePositions(state, { markToMarket: !willScan });

    if (willScan) {
      state.signals = await scanSignals(state);
      state.lastScanAt = Date.now();
    }

    if (state.running && !options.onlyScan) {
      openNewPositions(state);
    }

    state.lastError = null;
    await saveState(env, state);
  } catch (error) {
    const state = await loadState(env).catch(() => defaultState());
    state.lastError = `${error.message || error}`;
    state.lastErrorAt = Date.now();
    state.lastRunAt = Date.now();
    await saveState(env, state);
    throw error;
  } finally {
    await env.PAPER_STATE.delete(LOCK_KEY);
  }
}

async function loadState(env) {
  const raw = await env.PAPER_STATE.get(STATE_KEY, 'json');
  return normalizeState(raw || defaultState());
}

async function saveState(env, state) {
  state.savedAt = Date.now();
  await env.PAPER_STATE.put(STATE_KEY, JSON.stringify(normalizeState(state)));
}

function defaultState() {
  return {
    running: false,
    initialEquity: DEFAULT_CFG.initialEquity,
    equity: DEFAULT_CFG.initialEquity,
    peakEquity: DEFAULT_CFG.initialEquity,
    pausedUntil: 0,
    consecutiveLosses: 0,
    signals: [],
    positions: [],
    trades: [],
    equityCurve: [],
    backtest: null,
    lastScanAt: 0,
    lastCoreScanAt: 0,
    scanCursor: 0,
    scanMeta: null,
    tickerSnapshot: null,
    lastRunAt: 0,
    lastError: null,
    marketProvider: 'okx-usdt-swap',
    cfg: { ...DEFAULT_CFG },
  };
}

function normalizeState(state) {
  const cfg = { ...DEFAULT_CFG, ...(state.cfg || {}) };
  cfg.maxKlineScans = Math.min(positiveInt(cfg.maxKlineScans, DEFAULT_CFG.maxKlineScans), DEFAULT_CFG.maxKlineScans);
  cfg.anomalyScanLimit = Math.min(positiveInt(cfg.anomalyScanLimit, DEFAULT_CFG.anomalyScanLimit), DEFAULT_CFG.anomalyScanLimit);
  cfg.coreScanLimit = Math.min(positiveInt(cfg.coreScanLimit, DEFAULT_CFG.coreScanLimit), DEFAULT_CFG.coreScanLimit);
  cfg.scanRequestDelayMs = Math.max(positiveInt(cfg.scanRequestDelayMs, DEFAULT_CFG.scanRequestDelayMs), DEFAULT_CFG.scanRequestDelayMs);
  if (typeof state.initialEquity === 'number') cfg.initialEquity = state.initialEquity;
  if (typeof state.riskPerTrade === 'number') cfg.riskPerTrade = state.riskPerTrade;
  const normalized = {
    ...defaultState(),
    ...state,
    cfg,
    initialEquity: Number(state.initialEquity ?? cfg.initialEquity),
    equity: Number(state.equity ?? cfg.initialEquity),
    peakEquity: Number(state.peakEquity ?? state.equity ?? cfg.initialEquity),
    signals: Array.isArray(state.signals) ? state.signals : [],
    positions: Array.isArray(state.positions) ? state.positions : [],
    trades: Array.isArray(state.trades) ? state.trades : [],
    equityCurve: Array.isArray(state.equityCurve) ? state.equityCurve : [],
  };
  normalizeStrategyLabels(normalized.signals);
  normalizeStrategyLabels(normalized.positions);
  normalizeStrategyLabels(normalized.trades);
  return normalized;
}

function normalizeStrategyLabels(items) {
  for (const item of items) {
    if (item?.strategyKey && LABELS[item.strategyKey]) {
      item.strategyLabel = LABELS[item.strategyKey];
    }
  }
}

function applyConfig(state, body = {}) {
  if (Number.isFinite(Number(body.initialEquity)) && Number(body.initialEquity) >= 100) {
    const next = Number(body.initialEquity);
    const previous = Number(state.initialEquity || state.cfg.initialEquity);
    const shift = next - previous;
    state.initialEquity = next;
    state.equity = Number(state.equity || previous) + shift;
    state.peakEquity = Number(state.peakEquity || previous) + shift;
    state.cfg.initialEquity = next;
  }
  if (Number.isFinite(Number(body.riskPerTrade))) {
    const value = clamp(Number(body.riskPerTrade), 0.001, 0.05);
    state.riskPerTrade = value;
    state.cfg.riskPerTrade = value;
  }
}

async function scanSignals(state) {
  const cfg = state.cfg;
  const { tickers, meta } = await scanUniverse(state);
  let riskOff = false;
  try {
    const btcRows = await klines('BTC-USDT-SWAP', '15m', 130);
    riskOff = btcRiskOff(btcRows);
  } catch (error) {
    console.warn('BTC risk context failed', error);
  }
  const signals = [];

  for (const ticker of tickers) {
    try {
      const rows = await klines(ticker.instId, '15m', 130);
      const sig = evaluateSignal(ticker.symbol, ticker.instId, rows, ticker.quoteVolumeFloat, Date.now(), riskOff, cfg);
      if (sig) signals.push({ ...sig, universeTier: ticker.universeTier, universeRank: ticker.rank });
    } catch (error) {
      console.warn('scan failed', ticker.instId, error);
    }
    await sleep(positiveInt(cfg.scanRequestDelayMs, 120));
  }

  state.scanCursor = meta.nextCursor;
  state.scanMeta = { ...meta, scannedAt: Date.now(), scannedCount: tickers.length, signalCount: signals.length };
  return signals.sort((a, b) => b.score - a.score || b.quoteVolume - a.quoteVolume);
}

function openNewPositions(state) {
  const cfg = state.cfg;
  if (state.pausedUntil && Date.now() < state.pausedUntil) return;

  const openSymbols = new Set(state.positions.map((p) => p.symbol));
  const stoppedRecent = new Set((state.trades || [])
    .filter((t) => t.reason === 'stop' && Date.now() - t.exitTime < cfg.symbolStopCooldownMs)
    .map((t) => t.symbol));

  let totalRisk = state.positions.reduce((sum, p) => sum + Number(p.riskUsdt || 0), 0);
  for (const sig of state.signals) {
    if (state.positions.length >= cfg.maxPositions) break;
    if (openSymbols.has(sig.symbol) || stoppedRecent.has(sig.symbol) || sig.score < cfg.paperMinScore) continue;

    const sized = positionSize(state.equity, sig.entry, sig.stop, cfg);
    if (totalRisk + sized.riskUsdt > state.equity * cfg.maxTotalRisk) break;

    state.positions.push({
      id: `p_${Date.now()}_${sig.symbol}`,
      symbol: sig.symbol,
      instId: sig.instId,
      strategyKey: sig.strategyKey,
      strategyLabel: sig.strategyLabel,
      side: sig.side || 'long',
      entryTime: Date.now(),
      lastTime: Date.now(),
      entry: sig.entry,
      last: sig.entry,
      qty: sized.qty,
      remainingQty: sized.qty,
      stop: sig.stop,
      originalStop: sig.stop,
      tp1: sig.tp1,
      beTrigger: sig.beTrigger,
      lockTrigger: sig.lockTrigger,
      lockLevel: sig.lockLevel,
      tp1Done: false,
      trailPct: sig.trailPct,
      highest: sig.entry,
      lowest: sig.entry,
      score: sig.score,
      riskUsdt: sized.riskUsdt,
      realizedPnl: 0,
      reasons: sig.reasons,
    });
    totalRisk += sized.riskUsdt;
    openSymbols.add(sig.symbol);
  }
}

async function updatePositions(state, options = {}) {
  if (!state.positions.length) return;
  const markToMarket = options.markToMarket !== false;
  const stillOpen = [];

  for (const p of state.positions) {
    let closed = false;
    try {
      const rows = closedKlines(await klines(p.instId || instIdFromSymbol(p.symbol), '15m', 300));
      for (const bar of rows) {
        if (kTime(bar) <= p.lastTime) continue;
        p.lastTime = kTime(bar);
        const high = kHigh(bar);
        const low = kLow(bar);
        const close = kClose(bar);
        p.highest = Math.max(p.highest || p.entry, high);
        p.lowest = Math.min(p.lowest || p.entry, low);
        p.last = close;

        const effectiveStop = effectiveStopFor(p);
        if (p.side === 'short' ? high >= effectiveStop : low <= effectiveStop) {
          closePosition(state, p, effectiveStop, stopReasonFor(p), kTime(bar));
          closed = true;
          break;
        }
        if (!p.tp1Done && (p.side === 'short' ? low <= p.tp1 : high >= p.tp1)) {
          takeTP1(state, p);
        }
        if (kTime(bar) >= p.entryTime + state.cfg.maxHoldHours * 60 * 60 * 1000) {
          closePosition(state, p, close, 'time_exit', kTime(bar));
          closed = true;
          break;
        }
      }

      if (!closed && markToMarket) {
        const price = await tickerPrice(p.instId || instIdFromSymbol(p.symbol));
        p.last = price;
        p.highest = Math.max(p.highest || p.entry, price);
        p.lowest = Math.min(p.lowest || p.entry, price);
        const effectiveStop = effectiveStopFor(p);
        if (p.side === 'short' ? price >= effectiveStop : price <= effectiveStop) {
          closePosition(state, p, effectiveStop, stopReasonFor(p), Date.now());
          closed = true;
        } else if (!p.tp1Done && (p.side === 'short' ? price <= p.tp1 : price >= p.tp1)) {
          takeTP1(state, p);
        }
      }
    } catch (error) {
      console.warn('position update failed', p.symbol, error);
    }

    if (!closed) stillOpen.push(p);
    await sleep(20);
  }
  state.positions = stillOpen;
}

async function scanUniverse(state) {
  const cfg = state.cfg;
  const maxKlineScans = positiveInt(cfg.maxKlineScans || cfg.scanLimit, 35);
  const anomalyLimit = positiveInt(cfg.anomalyScanLimit, 24);
  const coreLimit = positiveInt(cfg.coreScanLimit, 10);
  const coreScanEveryMs = positiveInt(cfg.coreScanEveryMs, 30 * 60 * 1000);
  const extendedStart = positiveInt(cfg.extendedScanStart, 35);
  const extendedEnd = Math.max(extendedStart, positiveInt(cfg.extendedScanEnd, 120));
  const extendedBatch = Math.max(0, positiveInt(cfg.extendedScanBatch, 8));
  const ranked = await rankedInstruments(cfg);
  const previousSnapshot = state.tickerSnapshot?.items || {};
  const scored = ranked.map((ticker) => ({
    ...ticker,
    anomalyScore: anomalyScore(ticker, previousSnapshot[ticker.instId]),
  }));
  const anomaly = scored
    .filter((ticker) => ticker.rank > coreLimit || ticker.anomalyScore >= 20)
    .sort((a, b) => b.anomalyScore - a.anomalyScore || b.quoteVolumeFloat - a.quoteVolumeFloat)
    .slice(0, anomalyLimit)
    .map((ticker) => ({ ...ticker, universeTier: 'anomaly' }));

  const now = Date.now();
  const coreDue = !state.lastCoreScanAt || now - state.lastCoreScanAt >= coreScanEveryMs;
  const core = coreDue
    ? ranked.slice(0, coreLimit).map((ticker) => ({ ...ticker, universeTier: 'core' }))
    : [];

  const pool = ranked.slice(extendedStart, extendedEnd);
  const cursor = Number.isFinite(Number(state.scanCursor)) ? Number(state.scanCursor) : 0;
  const extended = rotatingSlice(pool, cursor, extendedBatch).map((ticker) => ({ ...ticker, universeTier: 'extended' }));
  const nextCursor = pool.length && extendedBatch ? (cursor + extendedBatch) % pool.length : 0;
  const deduped = [...new Map([...anomaly, ...extended, ...core].map((ticker) => [ticker.instId, ticker])).values()]
    .slice(0, maxKlineScans);

  if (coreDue && deduped.some((ticker) => ticker.universeTier === 'core')) state.lastCoreScanAt = now;
  state.tickerSnapshot = buildTickerSnapshot(ranked);

  return {
    tickers: deduped,
    meta: {
      mode: 'anomaly-first',
      maxKlineScans,
      anomalyLimit,
      anomalyCandidates: anomaly.length,
      coreLimit,
      coreDue,
      coreScanned: deduped.filter((ticker) => ticker.universeTier === 'core').length,
      coreScanEveryMs,
      extendedStart,
      extendedEnd,
      extendedBatch,
      extendedPoolSize: pool.length,
      cursor,
      nextCursor,
    },
  };
}

async function rankedInstruments(cfg) {
  const tickers = await okx('/api/v5/market/tickers', { instType: 'SWAP' });
  return tickers
    .filter((t) => t.instId && t.instId.endsWith('-USDT-SWAP'))
    .map((t) => {
      const last = Number(t.last || 0);
      const open24h = Number(t.open24h || 0);
      const high24h = Number(t.high24h || 0);
      const low24h = Number(t.low24h || 0);
      const baseVolume = Number(t.volCcy24h || 0);
      const quoteVolumeFloat = last * baseVolume;
      const change24h = open24h ? (last / open24h - 1) * 100 : 0;
      const range24hPosition = high24h > low24h ? (last - low24h) / (high24h - low24h) : 0.5;
      return { instId: t.instId, symbol: symbolFromInstId(t.instId), last, open24h, high24h, low24h, change24h, range24hPosition, quoteVolumeFloat };
    })
    .filter((t) => t.quoteVolumeFloat >= cfg.minQuoteVolume)
    .sort((a, b) => b.quoteVolumeFloat - a.quoteVolumeFloat)
    .map((ticker, index) => ({ ...ticker, rank: index + 1 }));
}

async function tickerPrice(instId) {
  const data = await okx('/api/v5/market/ticker', { instId });
  return Number(data?.[0]?.last || 0);
}

async function klines(instId, interval = '15m', limit = 130) {
  const rows = await okx('/api/v5/market/candles', { instId, bar: interval, limit });
  return rows
    .map((row) => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])])
    .filter((row) => row.every((value) => Number.isFinite(value)))
    .sort((a, b) => a[0] - b[0]);
}

async function okx(path, params = {}, attempt = 0) {
  const url = new URL(path, OKX_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'momentum-trader-claude-runner/1.0',
    },
    cf: { cacheTtl: 0 },
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 2) {
    await sleep(500 * (attempt + 1));
    return okx(path, params, attempt + 1);
  }
  if (!response.ok) throw new Error(`OKX ${path} ${response.status}`);
  const payload = await response.json();
  if (payload.code && payload.code !== '0') throw new Error(`OKX ${path} ${payload.code}: ${payload.msg}`);
  return payload.data || [];
}

function evaluateSignal(symbol, instId, rows, quoteVolume, scannedAt, riskOff, cfg) {
  const c = closedKlines(rows);
  if (c.length < 110 || quoteVolume < cfg.minQuoteVolume) return null;
  const price = kClose(c[c.length - 1]);
  const prev1h = kClose(c[c.length - 5]);
  const prev4h = kClose(c[c.length - 17]);
  const prev24h = kClose(c[c.length - 97]);
  const last24h = c.slice(-96);
  const prev24hBars = c.slice(-97, -1);
  const prevHigh = Math.max(...prev24hBars.map(kHigh));
  const momentum1h = pct(prev1h, price) || 0;
  const momentum4h = pct(prev4h, price) || 0;
  const momentum24h = pct(prev24h, price) || 0;
  const position24h = rangePosition(price, last24h.map(kLow), last24h.map(kHigh));
  const distancePrevHigh = pct(prevHigh, price) || 0;
  const volumeRatio = safeDiv(kVol(c[c.length - 1]), median(c.slice(-5, -1).map(kVol)), 0);
  const atrValue = atrPct(c);
  const ema50 = ema(c.map(kClose), 50);
  const aboveEma = price > ema50;
  const emaSlope = pct(ema(c.slice(0, -8).map(kClose), 50), ema50) || 0;

  if (momentum1h >= 6) return null;
  if (position24h >= 0.95 && momentum1h > 0) return null;
  if (momentum24h >= 10 && momentum4h < -1) return null;
  if (!aboveEma) return null;
  if (emaSlope < 0) return null;

  const isPullback = momentum24h >= 5 && momentum4h >= -1 && momentum1h <= 0.5 && momentum1h >= -3 && position24h >= 0.40 && position24h <= 0.85;
  const side = isPullback ? 'long' : 'short';
  const risk = buildRisk(price, atrValue, side);
  let score = 10;
  const reasons = [`24h quote volume ${Math.round(quoteVolume).toLocaleString()} USDT`];

  if (momentum4h >= 4 || momentum24h >= 8) { score += 20; reasons.push(`momentum confirmed: 4h ${momentum4h.toFixed(2)}%, 24h ${momentum24h.toFixed(2)}%`); }
  if (momentum4h >= 8) { score += 8; reasons.push(`strong 4h momentum ${momentum4h.toFixed(2)}%`); }
  if (momentum24h >= 15) { score += 8; reasons.push(`strong 24h momentum ${momentum24h.toFixed(2)}%`); }
  if (momentum1h > 0) { score += 5; reasons.push(`1h still positive ${momentum1h.toFixed(2)}%`); }
  if (position24h >= 0.75) { score += 20; reasons.push(`price in top ${(position24h * 100).toFixed(1)}% of 24h range`); }
  if (distancePrevHigh >= -4) { score += 10; reasons.push(`within ${Math.abs(distancePrevHigh).toFixed(2)}% of prior 24h high`); }
  if (distancePrevHigh > 0) { score += 5; reasons.push('breaking prior 24h high'); }
  if (volumeRatio >= 1.5) { score += 20; reasons.push(`15m volume expansion ${volumeRatio.toFixed(2)}x`); }
  if (volumeRatio >= 3) { score += 5; reasons.push('volume expansion is unusually strong'); }
  if (momentum1h <= 18) { score += 10; reasons.push('not a one-candle runaway move'); } else { score -= 15; reasons.push(`1h move ${momentum1h.toFixed(2)}% is overheated`); }
  if (riskOff) { score -= 12; reasons.push('BTC context risk-off penalty'); }
  if (isPullback) { score += 18; reasons.push('healthy pullback in uptrend'); }
  if (momentum1h >= 4 && position24h >= 0.85) { score -= 14; reasons.push('penalty: chasing the top'); }
  score += 5;
  reasons.push('above 50-period EMA with positive slope');
  score = Math.round(clamp(score, 0, 100));
  if (score < cfg.minSignalScore) return null;

  const metrics = { momentum1h, momentum4h, momentum24h, position24h, distancePrevHigh, volumeRatio, atrPct: atrValue, stopPct: risk.stopPct, btcRiskOff: riskOff, lastKlineOpenTime: kTime(c[c.length - 1]), aboveEma, emaSlope, isPullback };
  const key = strategyKey(metrics);
  return { scannedAt, symbol, instId, score, strategyKey: key, strategyLabel: LABELS[key], side, entry: price, lastPrice: price, stop: risk.stop, tp1: risk.tp1, beTrigger: risk.beTrigger, lockTrigger: risk.lockTrigger, lockLevel: risk.lockLevel, trailPct: risk.trailPct, atrPct: atrValue, quoteVolume, reasons, metrics };
}

function closePosition(state, p, exit, reason, exitTime) {
  const exitPnl = p.side === 'short' ? p.remainingQty * (p.entry - exit) : p.remainingQty * (exit - p.entry);
  const totalPnl = (p.realizedPnl || 0) + exitPnl;
  state.equity += exitPnl;
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  const mfePct = p.side === 'short' ? (p.entry - (p.lowest || p.entry)) / p.entry * 100 : pct(p.entry, p.highest) || 0;
  const maePct = p.side === 'short' ? (p.entry - (p.highest || p.entry)) / p.entry * 100 : pct(p.entry, p.lowest) || 0;
  state.trades.unshift({ symbol: p.symbol, instId: p.instId, strategyKey: p.strategyKey, strategyLabel: p.strategyLabel, side: p.side || 'long', entryTime: p.entryTime, exitTime, entry: p.entry, exit, qty: p.qty, pnl: totalPnl, rMultiple: safeDiv(totalPnl, p.riskUsdt, 0), reason, mfePct, maePct, score: p.score });
  state.trades = state.trades.slice(0, 500);
  state.equityCurve.push({ timeMs: exitTime, equity: state.equity, drawdownPct: safeDiv(state.peakEquity - state.equity, state.peakEquity, 0) * 100 });
  state.equityCurve = state.equityCurve.slice(-1000);
  state.consecutiveLosses = totalPnl < 0 ? state.consecutiveLosses + 1 : 0;
  if (state.consecutiveLosses >= 3) {
    state.pausedUntil = Date.now() + 6 * 60 * 60 * 1000;
    state.consecutiveLosses = 0;
  }
  if (safeDiv(state.peakEquity - state.equity, state.peakEquity, 0) >= 0.12) state.running = false;
}

function takeTP1(state, p) {
  const sellQty = p.remainingQty * 0.5;
  const tpPnl = p.side === 'short' ? sellQty * (p.entry - p.tp1) : sellQty * (p.tp1 - p.entry);
  state.equity += tpPnl;
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  p.realizedPnl = (p.realizedPnl || 0) + tpPnl;
  p.remainingQty -= sellQty;
  p.tp1Done = true;
  p.stop = p.entry;
}

function buildRisk(entry, atrValue, side = 'long') {
  const stopPct = Math.max(3, Math.min(8, 1.2 * atrValue));
  const trailPct = Math.max(8, 1.5 * atrValue);
  if (side === 'short') {
    return { stop: entry * (1 + stopPct / 100), tp1: entry * 0.80, beTrigger: entry * 0.92, lockTrigger: entry * 0.85, lockLevel: entry * 0.95, trailPct, stopPct };
  }
  return { stop: entry * (1 - stopPct / 100), tp1: entry * 1.20, beTrigger: entry * 1.08, lockTrigger: entry * 1.15, lockLevel: entry * 1.05, trailPct, stopPct };
}

function effectiveStopFor(p) {
  if (p.side === 'short') {
    const low = p.lowest || p.entry;
    if (p.tp1Done) return Math.min(p.lockLevel || p.entry, low * (1 + p.trailPct / 100));
    if (p.lockTrigger && low <= p.lockTrigger) return Math.min(p.stop, p.lockLevel || p.entry);
    if (p.beTrigger && low <= p.beTrigger) return Math.min(p.stop, p.entry);
    return p.stop;
  }
  const high = p.highest || p.entry;
  if (p.tp1Done) return Math.max(p.lockLevel || p.entry, high * (1 - p.trailPct / 100));
  if (p.lockTrigger && high >= p.lockTrigger) return Math.max(p.stop, p.lockLevel || p.entry);
  if (p.beTrigger && high >= p.beTrigger) return Math.max(p.stop, p.entry);
  return p.stop;
}

function stopReasonFor(p) {
  if (p.tp1Done) return 'trail_stop';
  if (p.side === 'short') {
    const low = p.lowest || p.entry;
    if (p.lockTrigger && low <= p.lockTrigger) return 'lock_stop';
    if (p.beTrigger && low <= p.beTrigger) return 'be_stop';
    return 'stop';
  }
  const high = p.highest || p.entry;
  if (p.lockTrigger && high >= p.lockTrigger) return 'lock_stop';
  if (p.beTrigger && high >= p.beTrigger) return 'be_stop';
  return 'stop';
}

function positionSize(equity, entry, stop, cfg) {
  const riskUsdt = equity * cfg.riskPerTrade;
  const perUnitRisk = Math.max(Math.abs(entry - stop), entry * 0.001);
  return { qty: riskUsdt / perUnitRisk, riskUsdt };
}

function closedKlines(rows) {
  if (!rows.length) return [];
  const currentOpen = Math.floor(Date.now() / INTERVAL_MS['15m']) * INTERVAL_MS['15m'];
  return Number(rows[rows.length - 1][0]) >= currentOpen ? rows.slice(0, -1) : rows.slice();
}

function atrPct(rows, period = 14) {
  if (rows.length < period + 1) return 4;
  const sub = rows.slice(-(period + 1));
  const trs = [];
  for (let i = 1; i < sub.length; i++) {
    const prevClose = kClose(sub[i - 1]);
    trs.push(Math.max(kHigh(sub[i]) - kLow(sub[i]), Math.abs(kHigh(sub[i]) - prevClose), Math.abs(kLow(sub[i]) - prevClose)));
  }
  return safeDiv(mean(trs), kClose(rows[rows.length - 1]), 0.04) * 100;
}

function btcRiskOff(rows) {
  const c = closedKlines(rows);
  if (c.length < 17) return false;
  const last = kClose(c[c.length - 1]);
  const oneH = pct(kClose(c[c.length - 5]), last) || 0;
  const fourH = pct(kClose(c[c.length - 17]), last) || 0;
  return oneH <= -1.5 && fourH <= -3;
}

function strategyKey(m) {
  if (m.isPullback) return 'pullback_uptrend';
  if ((m.momentum4h >= 15 && m.position24h >= 0.80) || (m.momentum24h >= 20 && m.distancePrevHigh >= -2)) return 'strong_momentum_breakout';
  if (m.momentum24h >= 8 && m.position24h >= 0.75 && m.position24h < 0.92 && m.momentum4h >= -3 && m.momentum4h <= 8) return 'high_range_continuation';
  if (m.volumeRatio >= 2 && m.position24h >= 0.65 && m.momentum1h > -1) return 'volume_ignition';
  return 'narrative_momentum';
}

function symbolFromInstId(instId) {
  return instId.replace('-USDT-SWAP', 'USDT').replaceAll('-', '');
}

function instIdFromSymbol(symbol) {
  return `${symbol.replace(/USDT$/, '')}-USDT-SWAP`;
}

function anomalyScore(ticker, previous) {
  const positiveChange = Math.max(0, ticker.change24h || 0);
  const rangePressure = Math.max(0, (ticker.range24hPosition || 0.5) - 0.65) * 100;
  const rankJump = previous?.rank ? Math.max(0, previous.rank - ticker.rank) : 0;
  const quoteVolumeGrowthPct = previous?.quoteVolumeFloat
    ? Math.max(0, (ticker.quoteVolumeFloat / previous.quoteVolumeFloat - 1) * 100)
    : 0;
  const liquidityWeight = Math.max(0, Math.log10(Math.max(ticker.quoteVolumeFloat, 1) / 1_000_000));

  return positiveChange * 2
    + rangePressure * 1.2
    + Math.min(rankJump, 50) * 1.5
    + Math.min(quoteVolumeGrowthPct, 250) * 0.35
    + liquidityWeight * 2;
}

function buildTickerSnapshot(ranked) {
  const items = {};
  for (const ticker of ranked.slice(0, 240)) {
    items[ticker.instId] = {
      rank: ticker.rank,
      last: ticker.last,
      change24h: ticker.change24h,
      range24hPosition: ticker.range24hPosition,
      quoteVolumeFloat: ticker.quoteVolumeFloat,
    };
  }
  return { savedAt: Date.now(), items };
}

function rotatingSlice(items, cursor, size) {
  if (!items.length || !size) return [];
  const out = [];
  for (let i = 0; i < Math.min(size, items.length); i++) {
    out.push(items[(cursor + i) % items.length]);
  }
  return out;
}

function positiveInt(value, fallback) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function kHigh(k) { return Number(k[2]); }
function kLow(k) { return Number(k[3]); }
function kClose(k) { return Number(k[4]); }
function kVol(k) { return Number(k[5]); }
function kTime(k) { return Number(k[0]); }
function pct(a, b) { return !a || b === null || b === undefined ? null : (b / a - 1) * 100; }
function safeDiv(a, b, def = 0) { return !b || a === null || a === undefined ? def : a / b; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs) {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function rangePosition(price, lows, highs) {
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  return hi === lo ? 0.5 : (price - lo) / (hi - lo);
}
function ema(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.includes('application/json')) return {};
  return request.json().catch(() => ({}));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}
