import { DurableObject } from 'cloudflare:workers';

const STATE_KEY = 'paper-state-v1';
const STATE_META_KEY = 'paper-state-meta-v1';
const STATE_CHUNK_PREFIX = 'paper-state-chunk-v1-';
const STATE_CHUNK_BYTES = 1_500_000;
const NOTIFICATION_STATUS_KEY = 'notification-status-v1';
const NOTIFICATION_DLQ = 'momentum-trader-notifications-dlq';
const OKX_API = 'https://www.okx.com';
const GATE_API = 'https://api.gateio.ws';
const HYPERLIQUID_API = 'https://api.hyperliquid.xyz';
const INTERVAL_MS = { '15m': 900000 };
const RECENT_SIGNAL_TTL_MS = 30 * 60 * 1000;
const RECENT_SIGNAL_LIMIT = 50;
const TICKER_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;
const GATE_MIN_QUOTE_VOLUME = 5_000_000;
const GATE_FALLBACK_VOLUME_RATIO = 0.25;
const XYZ_MIN_QUOTE_VOLUME = 5_000_000;
const POSITION_KLINE_LOOKBACK_MIN = 8;
const POSITION_KLINE_LOOKBACK_MAX = 300;
const COMPLETE_SCAN_BATCH_SIZE = 2;

const LABELS = {
  pullback_uptrend: '上升趨勢回檔',
  volume_breakout_follow: '放量突破跟進',
  impulse_pullback_reclaim: '急拉回檔確認',
  rally_downtrend: '下降趨勢反彈',
  strong_momentum_breakout: '強動量突破追價',
  volume_ignition: '放量啟動追隨',
  high_range_continuation: '高位續勢承接',
  narrative_momentum: '題材動量順勢',
};

const STRATEGY_SIDES = {
  pullback_uptrend: 'long',
  volume_breakout_follow: 'long',
  impulse_pullback_reclaim: 'long',
  rally_downtrend: 'short',
  strong_momentum_breakout: 'long',
  volume_ignition: 'long',
  high_range_continuation: 'long',
  narrative_momentum: 'long',
};

const DEFAULT_CFG = {
  initialEquity: 1000,
  riskPerTrade: 0.01,
  maxPositions: 8,
  maxTotalRisk: 0.08,
  minQuoteVolume: 20000000,
  minSignalScore: 70,
  paperMinScore: 82,
  maxHoldHours: 72,
  cooldownBars: 96,
  symbolStopCooldownMs: 24 * 60 * 60 * 1000,
  scanLimit: 35,
  maxKlineScans: 16,
  scanBatchSize: COMPLETE_SCAN_BATCH_SIZE,
  anomalyScanLimit: 10,
  coreScanLimit: 3,
  coreScanEveryMs: 30 * 60 * 1000,
  extendedScanStart: 35,
  extendedScanEnd: 160,
  extendedScanBatch: 3,
  xyzScanLimit: 4,
  xyzAnomalyScanLimit: 2,
  xyzCoreScanLimit: 1,
  xyzExtendedScanStart: 8,
  xyzExtendedScanBatch: 1,
  scanRequestDelayMs: 500,
  scanStaleMs: 10 * 60 * 1000,
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
    ctx.waitUntil(triggerPaperTick(env, {
      reason: 'cron',
      scheduledAt: Number(controller.scheduledTime || Date.now()),
    }));
  },
  async queue(batch, env) {
    if (batch.queue === NOTIFICATION_DLQ) {
      await handleNotificationDeadLetters(batch, env);
      return;
    }
    await handleNotificationQueue(batch, env);
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
      return paperCoordinator(env).fetch('https://paper-coordinator/state');
    }

    if (request.method === 'GET' && url.pathname === '/prices') {
      return paperCoordinator(env).fetch('https://paper-coordinator/prices');
    }

    if (request.method === 'GET' && url.pathname === '/snapshot') {
      return paperCoordinator(env).fetch('https://paper-coordinator/snapshot');
    }

    if (request.method === 'POST' && ['/start', '/stop', '/reset', '/config', '/scan', '/tick'].includes(url.pathname)) {
      const body = await readJson(request);
      if (url.pathname === '/tick') body.forceScan = url.searchParams.get('forceScan') === '1';
      return paperCoordinator(env).fetch(`https://paper-coordinator/control${url.pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (request.method === 'POST' && url.pathname === '/notify/test') {
      const text = 'Claude Momentum 測試通知\nWorker 通知通道已連線。';
      if (url.searchParams.get('queue') === '1' && env.NOTIFICATION_QUEUE) {
        await env.NOTIFICATION_QUEUE.send({
          id: `notification_test_${Date.now()}`,
          type: 'test',
          symbol: 'TEST',
          createdAt: Date.now(),
          text,
          payload: { type: 'test' },
        });
        return json({ ok: true, notification: { configured: configuredNotificationChannels(env), sent: 0, queued: true } });
      }
      const notification = await sendNotification(env, text, { type: 'test' });
      return json({ ok: true, notification });
    }

    return json({ ok: false, error: 'Not found' }, 404);
  } catch (error) {
    return json({ ok: false, error: error.message || String(error) }, 500);
  }
}

export class PaperCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.tickChain = Promise.resolve();
  }

  async storedState() {
    const meta = await this.ctx.storage.get(STATE_META_KEY);
    if (meta?.chunkCount > 0) {
      const keys = Array.from({ length: meta.chunkCount }, (_, index) => `${STATE_CHUNK_PREFIX}${index}`);
      const stored = await this.ctx.storage.get(keys);
      const chunks = keys.map((key) => stored.get(key)).filter(Boolean).map((value) => new Uint8Array(value));
      if (chunks.length !== keys.length) throw new Error('Paper state chunk is missing');
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      if (totalLength !== Number(meta.byteLength || 0)) throw new Error('Paper state chunk length mismatch');
      const bytes = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return normalizeState(JSON.parse(new TextDecoder().decode(bytes)));
    }

    let state = await this.ctx.storage.get(STATE_KEY);
    if (!state) {
      const legacy = this.env.PAPER_STATE
        ? await this.env.PAPER_STATE.get(STATE_KEY, 'json').catch(() => null)
        : null;
      state = normalizeState(legacy || defaultState());
      state.stateVersion = Math.max(1, Number(state.stateVersion || 0));
      state.migratedFromKvAt = legacy ? Date.now() : 0;
    }
    await this.persistState(state);
    return normalizeState(state);
  }

  async persistState(state) {
    const bytes = new TextEncoder().encode(JSON.stringify(normalizeState(state)));
    const chunks = [];
    for (let offset = 0; offset < bytes.byteLength; offset += STATE_CHUNK_BYTES) {
      const chunk = bytes.slice(offset, Math.min(offset + STATE_CHUNK_BYTES, bytes.byteLength));
      chunks.push(chunk.buffer);
    }
    await this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get(STATE_META_KEY);
      for (let index = 0; index < chunks.length; index++) {
        await txn.put(`${STATE_CHUNK_PREFIX}${index}`, chunks[index]);
      }
      for (let index = chunks.length; index < Number(previous?.chunkCount || 0); index++) {
        await txn.delete(`${STATE_CHUNK_PREFIX}${index}`);
      }
      await txn.put(STATE_META_KEY, {
        chunkCount: chunks.length,
        byteLength: bytes.byteLength,
        stateVersion: Number(state.stateVersion || 0),
      });
      if (!previous) await txn.delete(STATE_KEY);
    });
  }

  async saveStoredState(state) {
    const next = normalizeState(state);
    next.stateVersion = Number(next.stateVersion || 0) + 1;
    next.savedAt = Date.now();
    await this.persistState(next);
    Object.assign(state, next);
    return next;
  }

  enqueue(operation) {
    const pending = this.tickChain.then(operation, operation);
    this.tickChain = pending.catch(() => {});
    return pending;
  }

  async runTick(options = {}) {
    const now = Date.now();
    const state = await this.storedState();
    try {
      state.lastRunAt = now;
      state.lastRunReason = options.reason || 'coordinator';
      state.marketProvider = 'okx+gate+xyz-perpetuals';

      recoverLastFailedNotification(state);
      if (await flushPendingNotifications(state, this.env)) await this.saveStoredState(state);

      const forceScan = Boolean(options.forceScan || state.forceScanRequested);
      const onlyScan = Boolean(options.onlyScan || state.manualScanOnly);
      const scanStale = !state.signals.length || now - (state.lastScanAt || 0) >= state.cfg.scanStaleMs;
      const willScan = forceScan || scanStale;
      if (!state.running && !state.positions.length && !willScan && !onlyScan) {
        return { skipped: true, reason: 'paper-stopped' };
      }

      const positionUpdate = applyPositionUpdateStatus(
        state,
        await updatePositions(state, { markToMarket: !willScan }),
      );
      if (willScan) {
        let plan = await createScanPlan(state);
        while (plan.cursor < plan.tickers.length) {
          plan = await scanSignalPlanBatch(plan, state.cfg, COMPLETE_SCAN_BATCH_SIZE);
        }
        finalizeScanPlan(state, plan);
      }

      await openNewPositionsAfterUpdate(state, this.env, onlyScan, positionUpdate);
      state.forceScanRequested = false;
      state.manualScanOnly = false;
      if (positionUpdate.historyGaps.length) {
        const symbols = positionUpdate.historyGaps.map((gap) => gap.symbol).join(', ');
        state.lastError = `position_history_gap: ${symbols}; new entries paused until candle history is continuous`;
        state.lastErrorAt = Date.now();
      } else {
        state.lastError = null;
      }
      await this.saveStoredState(state);
      return {
        ok: true,
        stateVersion: state.stateVersion,
        scannedCount: state.scanMeta?.scannedCount || 0,
        signalCount: state.signals.length,
        openPositions: state.positions.length,
      };
    } catch (error) {
      state.lastError = `${error.message || error}`;
      state.lastErrorAt = Date.now();
      await this.saveStoredState(state).catch(() => {});
      throw error;
    }
  }

  async runControl(pathname, body = {}) {
    if (pathname === '/control/start') {
      const state = await this.storedState();
      applyConfig(state, body);
      state.running = true;
      state.lastError = null;
      state.updatedBy = 'start';
      await this.saveStoredState(state);
      const tick = await this.runTick({ forceScan: true, reason: 'manual-start' });
      return { ok: true, tick, state: await this.storedState() };
    }
    if (pathname === '/control/stop') {
      const state = await this.storedState();
      state.running = false;
      state.updatedBy = 'stop';
      await this.saveStoredState(state);
      return { ok: true, state };
    }
    if (pathname === '/control/reset') {
      const current = await this.storedState();
      const state = defaultState();
      state.stateVersion = current.stateVersion;
      applyConfig(state, body);
      state.updatedBy = 'reset';
      await this.saveStoredState(state);
      return { ok: true, state };
    }
    if (pathname === '/control/config') {
      const state = await this.storedState();
      applyConfig(state, body);
      state.updatedBy = 'config';
      await this.saveStoredState(state);
      return { ok: true, state };
    }
    if (pathname === '/control/scan') {
      const tick = await this.runTick({ forceScan: true, onlyScan: true, reason: 'manual-scan' });
      return { ok: true, tick, state: await this.storedState() };
    }
    if (pathname === '/control/tick') {
      const tick = await this.runTick({ forceScan: Boolean(body.forceScan), reason: 'manual-tick' });
      return { ok: true, tick, state: await this.storedState() };
    }
    return { ok: false, error: 'Unknown paper control' };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/raw-state') {
      return json({ ok: true, state: await this.storedState() });
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      const state = await this.storedState();
      const status = await this.env.PAPER_STATE.get(NOTIFICATION_STATUS_KEY, 'json');
      return json({ ok: true, state: mergeNotificationStatus(state, status) });
    }
    if (request.method === 'GET' && url.pathname === '/prices') {
      const state = await this.storedState();
      return json({ ok: true, fetchedAt: Date.now(), prices: await currentPrices(state) });
    }
    if (request.method === 'GET' && url.pathname === '/snapshot') {
      const state = await this.storedState();
      const [prices, status] = await Promise.all([
        currentPrices(state),
        this.env.PAPER_STATE.get(NOTIFICATION_STATUS_KEY, 'json'),
      ]);
      return json({
        ok: true,
        fetchedAt: Date.now(),
        state: mergeNotificationStatus(state, status),
        prices,
      });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/control/')) {
      const body = await request.json().catch(() => ({}));
      try {
        const result = await this.enqueue(() => this.runControl(url.pathname, body));
        return json(result, result.ok === false ? 404 : 200);
      } catch (error) {
        return json({ ok: false, error: error.message || String(error) }, 500);
      }
    }
    if (request.method === 'POST' && url.pathname === '/commit') {
      const body = await request.json();
      return this.enqueue(async () => {
        const current = await this.storedState();
        const expectedVersion = Number(body.expectedVersion || 0);
        if (expectedVersion !== Number(current.stateVersion || 0)) {
          return json({
            ok: false,
            error: 'state_version_conflict',
            stateVersion: current.stateVersion,
          }, 409);
        }
        const next = normalizeState(body.state || defaultState());
        next.stateVersion = expectedVersion;
        await this.saveStoredState(next);
        return json({ ok: true, state: next });
      });
    }
    if (request.method === 'POST' && url.pathname === '/tick') {
      const options = await request.json().catch(() => ({}));
      try {
        return json(await this.enqueue(() => this.runTick(options)));
      } catch (error) {
        return json({ ok: false, error: error.message || String(error) }, 500);
      }
    }
    return json({ ok: false, error: 'Not found' }, 404);
  }
}

function paperCoordinator(env) {
  if (!env.PAPER_COORDINATOR) return null;
  return env.PAPER_COORDINATOR.getByName(STATE_KEY);
}

async function triggerPaperTick(env, options = {}) {
  const coordinator = paperCoordinator(env);
  if (!coordinator) throw new Error('PAPER_COORDINATOR binding is unavailable');
  const response = await coordinator.fetch('https://paper-coordinator/tick', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `PaperCoordinator tick ${response.status}`);
  return payload;
}

function mergeNotificationStatus(state, status) {
  const current = state.lastNotification;
  if (status && (
    status.positionId === current?.positionId ||
    Number(status.createdAt || 0) >= Number(current?.createdAt || 0)
  )) {
    state.lastNotification = status;
    state.notificationLog = [
      status,
      ...(state.notificationLog || []).filter((item) => item.positionId !== status.positionId),
    ].slice(0, 100);
  }
  return state;
}

function defaultState() {
  return {
    running: false,
    stateVersion: 0,
    forceScanRequested: false,
    manualScanOnly: false,
    initialEquity: DEFAULT_CFG.initialEquity,
    equity: DEFAULT_CFG.initialEquity,
    peakEquity: DEFAULT_CFG.initialEquity,
    pausedUntil: 0,
    consecutiveLosses: 0,
    signals: [],
    recentSignals: [],
    positions: [],
    trades: [],
    equityCurve: [],
    notificationLog: [],
    pendingNotifications: [],
    backtest: null,
    lastScanAt: 0,
    lastCoreScanAt: 0,
    scanCursor: 0,
    xyzScanCursor: 0,
    scanPlan: null,
    scanMeta: null,
    tickerSnapshot: null,
    lastRunAt: 0,
    lastError: null,
    positionHistoryGaps: [],
    marketProvider: 'okx+gate+xyz-perpetuals',
    cfg: { ...DEFAULT_CFG },
  };
}

function normalizeState(state) {
  const cfg = { ...DEFAULT_CFG, ...(state.cfg || {}) };
  cfg.maxKlineScans = Math.min(positiveInt(cfg.maxKlineScans, DEFAULT_CFG.maxKlineScans), DEFAULT_CFG.maxKlineScans);
  cfg.scanBatchSize = Math.min(positiveInt(cfg.scanBatchSize, DEFAULT_CFG.scanBatchSize), DEFAULT_CFG.scanBatchSize, cfg.maxKlineScans);
  cfg.anomalyScanLimit = Math.min(positiveInt(cfg.anomalyScanLimit, DEFAULT_CFG.anomalyScanLimit), DEFAULT_CFG.anomalyScanLimit);
  cfg.coreScanLimit = Math.min(positiveInt(cfg.coreScanLimit, DEFAULT_CFG.coreScanLimit), DEFAULT_CFG.coreScanLimit);
  cfg.extendedScanBatch = Math.min(positiveInt(cfg.extendedScanBatch, DEFAULT_CFG.extendedScanBatch), DEFAULT_CFG.extendedScanBatch);
  cfg.xyzScanLimit = Math.min(positiveInt(cfg.xyzScanLimit, DEFAULT_CFG.xyzScanLimit), DEFAULT_CFG.xyzScanLimit);
  cfg.xyzAnomalyScanLimit = Math.min(positiveInt(cfg.xyzAnomalyScanLimit, DEFAULT_CFG.xyzAnomalyScanLimit), DEFAULT_CFG.xyzAnomalyScanLimit, cfg.xyzScanLimit);
  cfg.xyzCoreScanLimit = Math.min(positiveInt(cfg.xyzCoreScanLimit, DEFAULT_CFG.xyzCoreScanLimit), DEFAULT_CFG.xyzCoreScanLimit, cfg.xyzScanLimit);
  cfg.xyzExtendedScanBatch = Math.min(positiveInt(cfg.xyzExtendedScanBatch, DEFAULT_CFG.xyzExtendedScanBatch), DEFAULT_CFG.xyzExtendedScanBatch, cfg.xyzScanLimit);
  cfg.scanRequestDelayMs = Math.max(positiveInt(cfg.scanRequestDelayMs, DEFAULT_CFG.scanRequestDelayMs), DEFAULT_CFG.scanRequestDelayMs);
  cfg.scanStaleMs = Math.max(positiveInt(cfg.scanStaleMs, DEFAULT_CFG.scanStaleMs), DEFAULT_CFG.scanStaleMs);
  // maxPositions/maxTotalRisk 不開放 /config 設定，KV 裡的舊值只是過期快取，一律以程式碼預設為準
  cfg.maxPositions = DEFAULT_CFG.maxPositions;
  cfg.maxTotalRisk = DEFAULT_CFG.maxTotalRisk;
  if (typeof state.initialEquity === 'number') cfg.initialEquity = state.initialEquity;
  if (typeof state.riskPerTrade === 'number') cfg.riskPerTrade = state.riskPerTrade;
  const normalized = {
    ...defaultState(),
    ...state,
    cfg,
    stateVersion: Math.max(0, Number(state.stateVersion || 0)),
    forceScanRequested: Boolean(state.forceScanRequested),
    manualScanOnly: Boolean(state.manualScanOnly),
    initialEquity: Number(state.initialEquity ?? cfg.initialEquity),
    equity: Number(state.equity ?? cfg.initialEquity),
    peakEquity: Number(state.peakEquity ?? state.equity ?? cfg.initialEquity),
    signals: Array.isArray(state.signals) ? state.signals : [],
    recentSignals: Array.isArray(state.recentSignals) ? state.recentSignals : [],
    positions: Array.isArray(state.positions) ? state.positions : [],
    trades: Array.isArray(state.trades) ? state.trades : [],
    equityCurve: Array.isArray(state.equityCurve) ? state.equityCurve : [],
    notificationLog: Array.isArray(state.notificationLog) ? state.notificationLog.slice(0, 100) : [],
    pendingNotifications: Array.isArray(state.pendingNotifications) ? state.pendingNotifications.slice(0, 20) : [],
    positionHistoryGaps: Array.isArray(state.positionHistoryGaps) ? state.positionHistoryGaps : [],
    scanPlan: normalizeScanPlan(state.scanPlan),
  };
  normalizeStrategyLabels(normalized.signals);
  normalizeStrategyLabels(normalized.recentSignals);
  normalizeStrategyLabels(normalized.positions);
  normalizeStrategyLabels(normalized.trades);
  normalizeMarketProviders(normalized.signals);
  normalizeMarketProviders(normalized.recentSignals);
  normalizeMarketProviders(normalized.positions);
  normalizeMarketProviders(normalized.trades);
  for (const position of normalized.positions) ensurePositionEvents(position);
  return normalized;
}

function hasActiveScanPlan(state) {
  const plan = state?.scanPlan;
  return Boolean(plan && Array.isArray(plan.tickers) && Number(plan.cursor || 0) < plan.tickers.length);
}

function normalizeScanPlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tickers)) return null;
  const maxTickers = DEFAULT_CFG.maxKlineScans;
  const tickers = plan.tickers
    .filter((ticker) => ticker?.instId && ticker?.symbol && ticker?.marketProvider)
    .slice(0, maxTickers);
  if (!tickers.length) return null;
  const cursor = Math.min(Math.max(0, Number(plan.cursor || 0)), tickers.length);
  if (cursor >= tickers.length) return null;
  return {
    id: String(plan.id || `scan_${Date.now()}`),
    createdAt: Number(plan.createdAt || Date.now()),
    cursor,
    tickers,
    meta: plan.meta && typeof plan.meta === 'object' ? plan.meta : {},
    riskOff: Boolean(plan.riskOff),
    btcContextOk: plan.btcContextOk !== false,
    signals: Array.isArray(plan.signals) ? plan.signals.slice(0, maxTickers) : [],
    successfulScanCount: Math.max(0, Number(plan.successfulScanCount || 0)),
    failedScanCount: Math.max(0, Number(plan.failedScanCount || 0)),
    failedSymbols: Array.isArray(plan.failedSymbols) ? plan.failedSymbols.slice(0, 8) : [],
    failedReasonCounts: plan.failedReasonCounts && typeof plan.failedReasonCounts === 'object' ? plan.failedReasonCounts : {},
  };
}

function normalizeStrategyLabels(items) {
  for (const item of items) {
    if (item?.strategyKey && LABELS[item.strategyKey]) {
      item.strategyLabel = LABELS[item.strategyKey];
    }
  }
}

function normalizeMarketProviders(items) {
  for (const item of items) {
    if (!item?.marketProvider) item.marketProvider = providerFromInstId(item?.instId);
  }
}

function mergeRecentSignals(previousSignals, currentSignals, now = Date.now()) {
  const cutoff = now - RECENT_SIGNAL_TTL_MS;
  const bySymbol = new Map();

  for (const signal of Array.isArray(previousSignals) ? previousSignals : []) {
    if (!signal?.symbol) continue;
    const lastSeenAt = Number(signal.lastSeenAt || signal.scannedAt || 0);
    if (lastSeenAt < cutoff) continue;
    bySymbol.set(signal.symbol, {
      ...signal,
      firstSeenAt: Number(signal.firstSeenAt || signal.scannedAt || lastSeenAt),
      lastSeenAt,
    });
  }

  for (const signal of Array.isArray(currentSignals) ? currentSignals : []) {
    if (!signal?.symbol) continue;
    const previous = bySymbol.get(signal.symbol);
    bySymbol.set(signal.symbol, {
      ...previous,
      ...signal,
      firstSeenAt: Number(previous?.firstSeenAt || signal.scannedAt || now),
      lastSeenAt: now,
    });
  }

  return [...bySymbol.values()]
    .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0) || Number(b.score || 0) - Number(a.score || 0))
    .slice(0, RECENT_SIGNAL_LIMIT);
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

async function createScanPlan(state, rankedResult = null) {
  const cfg = state.cfg;
  const { tickers, meta } = await scanUniverse(state, rankedResult);
  let riskOff = false;
  let btcContextOk = true;
  try {
    const btcRows = await marketKlines('okx', 'BTC-USDT-SWAP', '15m', 130);
    riskOff = btcRiskOff(btcRows);
  } catch (error) {
    btcContextOk = false;
    console.warn('BTC risk context failed', error);
  }
  return {
    id: `scan_${Date.now()}`,
    createdAt: Date.now(),
    cursor: 0,
    tickers,
    meta,
    riskOff,
    btcContextOk,
    signals: [],
    successfulScanCount: 0,
    failedScanCount: 0,
    failedSymbols: [],
    failedReasonCounts: {},
  };
}

async function scanSignals(state, options = {}) {
  const cfg = state.cfg;
  if (options.forceNewPlan || !hasActiveScanPlan(state)) {
    state.scanPlan = await createScanPlan(state);
  }

  const batchSize = Math.min(
    positiveInt(cfg.scanBatchSize, DEFAULT_CFG.scanBatchSize),
    state.scanPlan.tickers.length || DEFAULT_CFG.scanBatchSize,
  );
  state.scanPlan = await scanSignalPlanBatch(state.scanPlan, cfg, batchSize, false);
  if (state.scanPlan.cursor >= state.scanPlan.tickers.length) {
    return finalizeScanPlan(state, state.scanPlan);
  }
  return state.signals;
}

async function scanSignalPlanBatch(plan, cfg, batchSize, failOnError = true) {
  const next = {
    ...plan,
    signals: [...(plan.signals || [])],
    failedSymbols: [...(plan.failedSymbols || [])],
    failedReasonCounts: { ...(plan.failedReasonCounts || {}) },
  };
  const batch = plan.tickers.slice(plan.cursor, plan.cursor + batchSize);
  for (const ticker of batch) {
    try {
      const rows = await marketKlines(ticker.marketProvider, ticker.instId, '15m', 130);
      const sig = evaluateSignal(
        ticker.symbol,
        ticker.instId,
        rows,
        ticker.quoteVolumeFloat,
        Date.now(),
        ticker.marketProvider === 'xyz' ? false : plan.riskOff,
        { ...cfg, minQuoteVolume: ticker.minQuoteVolume || cfg.minQuoteVolume },
      );
      next.successfulScanCount++;
      if (sig) next.signals.push({
        ...sig,
        marketProvider: ticker.marketProvider,
        universeTier: ticker.universeTier,
        universeRank: ticker.rank,
      });
    } catch (error) {
      if (failOnError) throw error;
      next.failedScanCount++;
      if (next.failedSymbols.length < 8) next.failedSymbols.push(ticker.symbol);
      const reason = scanFailureReason(error);
      next.failedReasonCounts[reason] = Number(next.failedReasonCounts[reason] || 0) + 1;
      console.warn('scan failed', ticker.instId, error);
    }
    await sleep(positiveInt(cfg.scanRequestDelayMs, DEFAULT_CFG.scanRequestDelayMs));
  }
  next.cursor += batch.length;
  return next;
}

function signalSort(a, b) {
  return Number(b.score || 0) - Number(a.score || 0)
    || Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0);
}

function sortedPlanSignals(plan) {
  return [...(plan?.signals || [])].sort(signalSort);
}

function finalizeScanPlan(state, plan) {
  const requiredCount = positiveInt(state.cfg.maxKlineScans, DEFAULT_CFG.maxKlineScans);
  if (plan.tickers.length !== requiredCount) {
    throw new Error(`Incomplete scan universe: ${plan.tickers.length}/${requiredCount}`);
  }
  if (plan.cursor < plan.tickers.length || plan.successfulScanCount < plan.tickers.length) {
    throw new Error(`Incomplete scan plan: ${plan.successfulScanCount}/${plan.tickers.length}`);
  }
  if (Date.now() - Number(plan.createdAt || 0) > state.cfg.scanStaleMs) {
    throw new Error('Scan plan expired before publication');
  }
  const signals = sortedPlanSignals(plan);
  const scannedTickers = plan.tickers.slice(0, plan.cursor);
  state.scanMeta = {
    ...plan.meta,
    providerMeta: {
      ...(plan.meta.providerMeta || {}),
      okxScanned: scannedTickers.filter((ticker) => ticker.marketProvider === 'okx').length,
      gateScanned: scannedTickers.filter((ticker) => ticker.marketProvider === 'gate').length,
      xyzScanned: scannedTickers.filter((ticker) => ticker.marketProvider === 'xyz').length,
    },
    scannedAt: Date.now(),
    scannedCount: plan.cursor,
    plannedScanCount: plan.tickers.length,
    batchScannedCount: plan.tickers.length,
    successfulScanCount: plan.successfulScanCount,
    failedScanCount: plan.failedScanCount,
    failedSymbols: plan.failedSymbols,
    failedReasonCounts: plan.failedReasonCounts,
    btcContextOk: plan.btcContextOk,
    scanComplete: true,
    scanBatchSize: COMPLETE_SCAN_BATCH_SIZE,
    signalCount: signals.length,
  };
  state.lastScanAt = state.scanMeta.scannedAt;
  state.signals = signals;
  state.recentSignals = mergeRecentSignals(state.recentSignals, signals, state.lastScanAt);
  state.scanCursor = plan.meta.nextCursor;
  state.scanPlan = null;
  return signals;
}

function signalPriceKey(signal) {
  return `${signal.marketProvider || providerFromInstId(signal.instId)}:${signal.instId}`;
}

function eligibleEntrySignals(state, signals = state.signals) {
  const cfg = state.cfg;
  if (state.pausedUntil && Date.now() < state.pausedUntil) return;

  const openSymbols = new Set(state.positions.map((p) => p.symbol));
  const stoppedRecent = new Set((state.trades || [])
    .filter((t) => ['stop', 'be_stop', 'early_stop'].includes(t.reason) && Date.now() - t.exitTime < cfg.symbolStopCooldownMs)
    .map((t) => t.symbol));
  return [...(signals || [])]
    .sort(signalSort)
    .filter((sig) => !openSymbols.has(sig.symbol)
      && !stoppedRecent.has(sig.symbol)
      && sig.score >= cfg.paperMinScore
      && !(sig.strategyKey === 'narrative_momentum' && sig.score < cfg.paperMinScore + 8));
}

async function latestEntryPrices(state, signals = state.signals) {
  const candidates = eligibleEntrySignals(state, signals) || [];
  const results = await Promise.allSettled(candidates.map(async (signal) => [
    signalPriceKey(signal),
    await tickerPrice(signal.marketProvider || providerFromInstId(signal.instId), signal.instId),
  ]));
  return Object.fromEntries(results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter(([, price]) => Number.isFinite(price) && price > 0));
}

function repriceSignal(signal, latestPrice) {
  const signalEntry = Number(signal.entry || 0);
  const entry = Number(latestPrice || 0);
  if (!Number.isFinite(signalEntry) || signalEntry <= 0 || !Number.isFinite(entry) || entry <= 0) return null;
  const rebase = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? entry * (number / signalEntry) : undefined;
  };
  return {
    ...signal,
    signalEntry,
    entry,
    lastPrice: entry,
    stop: rebase(signal.stop),
    tp1: rebase(signal.tp1),
    beTrigger: rebase(signal.beTrigger),
    lockTrigger: rebase(signal.lockTrigger),
    lockLevel: rebase(signal.lockLevel),
    earlyTrigger: rebase(signal.earlyTrigger),
    earlyLevel: rebase(signal.earlyLevel),
    pricedAt: Date.now(),
  };
}

async function openNewPositions(state, env, latestPrices = null) {
  const cfg = state.cfg;
  if (state.pausedUntil && Date.now() < state.pausedUntil) return;
  const candidates = eligibleEntrySignals(state) || [];
  const prices = latestPrices || await latestEntryPrices(state, candidates);
  const openSymbols = new Set(state.positions.map((p) => p.symbol));

  let totalRisk = state.positions.reduce((sum, p) => sum + Number(p.riskUsdt || 0), 0);
  for (const originalSignal of candidates) {
    if (state.positions.length >= cfg.maxPositions) break;
    if (openSymbols.has(originalSignal.symbol)) continue;
    const sig = repriceSignal(originalSignal, prices[signalPriceKey(originalSignal)]);
    if (!sig) continue;

    const sized = positionSize(state.equity, sig.entry, sig.stop, cfg);
    if (totalRisk + sized.riskUsdt > state.equity * cfg.maxTotalRisk) break;

    const entryTime = Date.now();
    const position = {
      id: `p_${entryTime}_${sig.symbol}`,
      symbol: sig.symbol,
      instId: sig.instId,
      marketProvider: sig.marketProvider || providerFromInstId(sig.instId),
      strategyKey: sig.strategyKey,
      strategyLabel: sig.strategyLabel,
      side: sig.side || 'long',
      entryTime,
      lastTime: entryTime,
      signalEntry: sig.signalEntry,
      pricedAt: sig.pricedAt,
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
      earlyTrigger: sig.earlyTrigger,
      earlyLevel: sig.earlyLevel,
      bePartialEnabled: true,
      bePartialDone: false,
      tp1Done: false,
      trailPct: sig.trailPct,
      highest: sig.entry,
      lowest: sig.entry,
      score: sig.score,
      riskUsdt: sized.riskUsdt,
      realizedPnl: 0,
      partialExits: [],
      events: [],
      reasons: sig.reasons,
    };
    recordPositionEvent(position, {
      type: 'open',
      time: entryTime,
      price: position.entry,
      qtyDelta: position.qty,
      remainingQty: position.qty,
      stop: position.stop,
    });
    state.positions.push(position);
    totalRisk += sized.riskUsdt;
    openSymbols.add(sig.symbol);
    await notifyNewPosition(env, position, state);
  }
}

async function updatePositions(state, options = {}) {
  return updatePositionIds(state, state.positions.map((position) => position.id), options);
}

function applyPositionUpdateStatus(state, positionUpdate) {
  state.positionHistoryGaps = positionUpdate.historyGaps;
  return positionUpdate;
}

async function openNewPositionsAfterUpdate(state, env, onlyScan, positionUpdate) {
  if (!state.running || onlyScan || positionUpdate.historyGaps.length) return false;
  const latestPrices = await latestEntryPrices(state, state.signals);
  await openNewPositions(state, env, latestPrices);
  return true;
}

async function updatePositionIds(state, positionIds, options = {}) {
  if (!state.positions.length || !positionIds.length) return { historyGaps: [] };
  const markToMarket = options.markToMarket !== false;
  const selectedIds = new Set(positionIds);
  const closedIds = new Set();
  const historyGaps = [];

  for (const p of state.positions.filter((position) => selectedIds.has(position.id))) {
    let closed = false;
    try {
      const provider = p.marketProvider || providerFromInstId(p.instId);
      const instId = p.instId || instIdFromSymbol(p.symbol, provider);
      const rows = closedKlines(await marketKlines(provider, instId, '15m', positionKlineLimit(p)));
      const pendingRows = positionKlinesAfter(p, rows);
      delete p.historyGap;
      for (const bar of pendingRows) {
        p.lastTime = kTime(bar);
        const high = kHigh(bar);
        const low = kLow(bar);
        const close = kClose(bar);
        p.highest = Math.max(p.highest || p.entry, high);
        p.lowest = Math.min(p.lowest || p.entry, low);
        p.last = close;

        recordProtectionEvents(p, kTime(bar));
        takeBreakEvenPartial(state, p, kTime(bar));
        const effectiveStop = effectiveStopFor(p);
        if (p.side === 'short' ? high >= effectiveStop : low <= effectiveStop) {
          closePosition(state, p, effectiveStop, stopReasonFor(p), kTime(bar));
          closed = true;
          break;
        }
        if (!p.tp1Done && (p.side === 'short' ? low <= p.tp1 : high >= p.tp1)) {
          takeTP1(state, p, kTime(bar));
        }
        // 呆倉踢除：持有 48h 仍未達 +1% 且未觸發任何保護層 → 出場讓位給新訊號（24h 會誤殺慢熱單，見 ZEC 案例）
        const staleProfit = p.side === 'short' ? (p.entry - close) / p.entry : (close - p.entry) / p.entry;
        if (kTime(bar) >= p.entryTime + 48 * 60 * 60 * 1000 && staleProfit < 0.01 && !p.tp1Done && !p.bePartialDone) {
          closePosition(state, p, close, 'stale_exit', kTime(bar));
          closed = true;
          break;
        }
        if (kTime(bar) >= p.entryTime + state.cfg.maxHoldHours * 60 * 60 * 1000) {
          closePosition(state, p, close, 'time_exit', kTime(bar));
          closed = true;
          break;
        }
      }

      if (!closed && markToMarket) {
        const price = await tickerPrice(provider, instId);
        p.last = price;
        p.highest = Math.max(p.highest || p.entry, price);
        p.lowest = Math.min(p.lowest || p.entry, price);
        recordProtectionEvents(p, Date.now());
        takeBreakEvenPartial(state, p, Date.now());
        const effectiveStop = effectiveStopFor(p);
        if (p.side === 'short' ? price >= effectiveStop : price <= effectiveStop) {
          closePosition(state, p, effectiveStop, stopReasonFor(p), Date.now());
          closed = true;
        } else if (!p.tp1Done && (p.side === 'short' ? price <= p.tp1 : price >= p.tp1)) {
          takeTP1(state, p, Date.now());
        }
      }
    } catch (error) {
      if (error.code === 'position_history_gap') {
        const gap = {
          ...error.details,
          symbol: p.symbol,
          provider: p.marketProvider || providerFromInstId(p.instId),
          detectedAt: Date.now(),
        };
        p.historyGap = gap;
        historyGaps.push(gap);
      } else if (p.historyGap) {
        historyGaps.push(p.historyGap);
      }
      console.warn('position update failed', p.symbol, error);
    }

    if (closed) closedIds.add(p.id);
    await sleep(20);
  }
  if (closedIds.size) state.positions = state.positions.filter((position) => !closedIds.has(position.id));
  return { historyGaps };
}

async function scanUniverse(state, rankedResult = null) {
  const cfg = state.cfg;
  const maxKlineScans = positiveInt(cfg.maxKlineScans || cfg.scanLimit, 35);
  const anomalyLimit = positiveInt(cfg.anomalyScanLimit, 24);
  const coreLimit = positiveInt(cfg.coreScanLimit, 10);
  const xyzScanLimit = Math.min(positiveInt(cfg.xyzScanLimit, 8), maxKlineScans);
  const xyzAnomalyLimit = Math.min(positiveInt(cfg.xyzAnomalyScanLimit, 4), xyzScanLimit);
  const xyzCoreLimit = Math.min(positiveInt(cfg.xyzCoreScanLimit, 2), xyzScanLimit);
  const xyzExtendedStart = positiveInt(cfg.xyzExtendedScanStart, 8);
  const xyzExtendedBatch = Math.min(positiveInt(cfg.xyzExtendedScanBatch, 2), xyzScanLimit);
  const coreScanEveryMs = positiveInt(cfg.coreScanEveryMs, 30 * 60 * 1000);
  const extendedStart = positiveInt(cfg.extendedScanStart, 35);
  const extendedEnd = Math.max(extendedStart, positiveInt(cfg.extendedScanEnd, 120));
  const extendedBatch = Math.max(0, positiveInt(cfg.extendedScanBatch, 8));
  let universeSource = 'live';
  let universeError = null;
  let providerMeta = {};
  let ranked;
  try {
    const result = rankedResult || await rankedInstruments(cfg);
    ranked = result.ranked;
    providerMeta = result.providerMeta;
    if (providerMeta.okxError || providerMeta.gateError || providerMeta.xyzError) universeSource = 'live-partial';
  } catch (error) {
    ranked = rankedFromTickerSnapshot(state.tickerSnapshot, cfg);
    if (!ranked.length) throw error;
    universeSource = 'cached';
    universeError = error.message || String(error);
    providerMeta = state.tickerSnapshot?.providerMeta || {};
  }
  const previousSnapshot = state.tickerSnapshot?.items || {};
  const scored = ranked.map((ticker) => ({
    ...ticker,
    anomalyScore: anomalyScore(ticker, previousSnapshot[ticker.instId]),
  }));
  const cryptoRanked = scored.filter((ticker) => ticker.marketProvider !== 'xyz');
  const xyzRanked = scored.filter((ticker) => ticker.marketProvider === 'xyz');
  const anomaly = cryptoRanked
    .filter((ticker) => ticker.rank > coreLimit || ticker.anomalyScore >= 20)
    .sort((a, b) => b.anomalyScore - a.anomalyScore || b.normalizedQuoteVolume - a.normalizedQuoteVolume)
    .slice(0, anomalyLimit)
    .map((ticker) => ({ ...ticker, universeTier: 'anomaly' }));

  const now = Date.now();
  const coreDue = !state.lastCoreScanAt || now - state.lastCoreScanAt >= coreScanEveryMs;
  const core = coreDue
    ? cryptoRanked.slice(0, coreLimit).map((ticker) => ({ ...ticker, universeTier: 'core' }))
    : [];

  const pool = cryptoRanked.slice(extendedStart, extendedEnd);
  const cursor = Number.isFinite(Number(state.scanCursor)) ? Number(state.scanCursor) : 0;
  const extended = rotatingSlice(pool, cursor, extendedBatch).map((ticker) => ({ ...ticker, universeTier: 'extended' }));
  const nextCursor = pool.length && extendedBatch ? (cursor + extendedBatch) % pool.length : 0;

  const xyzAnomalyBudget = coreDue
    ? xyzAnomalyLimit
    : Math.min(xyzScanLimit - xyzExtendedBatch, xyzAnomalyLimit + xyzCoreLimit);
  const xyzAnomaly = xyzRanked
    .filter((ticker) => ticker.rank > xyzCoreLimit || ticker.anomalyScore >= 20)
    .sort((a, b) => b.anomalyScore - a.anomalyScore || b.quoteVolumeFloat - a.quoteVolumeFloat)
    .slice(0, Math.max(0, xyzAnomalyBudget))
    .map((ticker) => ({ ...ticker, universeTier: 'xyz-anomaly' }));
  const xyzCore = coreDue
    ? xyzRanked.slice(0, xyzCoreLimit).map((ticker) => ({ ...ticker, universeTier: 'xyz-core' }))
    : [];
  const xyzPool = xyzRanked.slice(xyzExtendedStart);
  const xyzCursor = Number.isFinite(Number(state.xyzScanCursor)) ? Number(state.xyzScanCursor) : 0;
  const xyzExtended = rotatingSlice(xyzPool, xyzCursor, xyzExtendedBatch)
    .map((ticker) => ({ ...ticker, universeTier: 'xyz-extended' }));
  const nextXyzCursor = xyzPool.length && xyzExtendedBatch
    ? (xyzCursor + xyzExtendedBatch) % xyzPool.length
    : 0;
  const xyzPriority = new Map(
    [...xyzAnomaly, ...xyzExtended, ...xyzCore].map((ticker) => [ticker.instId, ticker]),
  );
  const xyzReserve = xyzRanked
    .filter((ticker) => !xyzPriority.has(ticker.instId))
    .map((ticker) => ({ ...ticker, universeTier: 'xyz-reserve' }));
  const xyzSelected = [...xyzPriority.values(), ...xyzReserve].slice(0, xyzScanLimit);

  const cryptoCandidates = [...new Map(
    [...anomaly, ...extended, ...core].map((ticker) => [ticker.instId, ticker]),
  ).values()];
  const cryptoBudget = Math.max(0, maxKlineScans - xyzSelected.length);
  const deduped = [...cryptoCandidates.slice(0, cryptoBudget), ...xyzSelected].slice(0, maxKlineScans);

  if (coreDue && deduped.some((ticker) => ticker.universeTier === 'core')) state.lastCoreScanAt = now;
  if (universeSource !== 'cached') state.tickerSnapshot = buildTickerSnapshot(ranked, providerMeta);
  state.xyzScanCursor = nextXyzCursor;

  return {
    tickers: deduped,
    meta: {
      mode: 'anomaly-first',
      universeSource,
      universeError,
      providerMeta: {
        ...providerMeta,
        okxScanned: deduped.filter((ticker) => ticker.marketProvider === 'okx').length,
        gateScanned: deduped.filter((ticker) => ticker.marketProvider === 'gate').length,
        xyzScanned: deduped.filter((ticker) => ticker.marketProvider === 'xyz').length,
      },
      universeSnapshotAgeMs: universeSource === 'cached' ? Date.now() - Number(state.tickerSnapshot?.savedAt || 0) : 0,
      maxKlineScans,
      anomalyLimit,
      anomalyCandidates: anomaly.length + xyzAnomaly.length,
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
      xyzScanLimit,
      xyzAnomalyCandidates: xyzAnomaly.length,
      xyzCoreScanned: deduped.filter((ticker) => ticker.universeTier === 'xyz-core').length,
      xyzExtendedPoolSize: xyzPool.length,
      xyzCursor,
      nextXyzCursor,
    },
  };
}

async function rankedInstruments(cfg) {
  const [okxResult, gateResult, xyzResult] = await Promise.allSettled([
    okx('/api/v5/market/tickers', { instType: 'SWAP' }, 0, 1),
    gate('/api/v4/futures/usdt/tickers', {}, 0, 1),
    hyperliquidInfo({ type: 'metaAndAssetCtxs', dex: 'xyz' }, 0, 1),
  ]);
  if (okxResult.status === 'rejected' && gateResult.status === 'rejected' && xyzResult.status === 'rejected') {
    throw new Error(`Market universe unavailable: ${okxResult.reason}; ${gateResult.reason}; ${xyzResult.reason}`);
  }

  const okxAll = okxResult.status === 'fulfilled' ? normalizeOkxTickers(okxResult.value) : [];
  const gateAll = gateResult.status === 'fulfilled' ? normalizeGateTickers(gateResult.value) : [];
  const xyzAll = xyzResult.status === 'fulfilled' ? normalizeXyzTickers(xyzResult.value) : [];
  const gateVolumeRatio = deriveGateVolumeRatio(okxAll, gateAll, cfg.minQuoteVolume);
  const gateMinQuoteVolume = Math.min(
    cfg.minQuoteVolume,
    Math.max(GATE_MIN_QUOTE_VOLUME, cfg.minQuoteVolume * gateVolumeRatio),
  );
  const effectiveGateVolumeRatio = gateMinQuoteVolume / cfg.minQuoteVolume;
  const okxEligible = okxAll
    .filter((ticker) => ticker.quoteVolumeFloat >= cfg.minQuoteVolume)
    .map((ticker) => ({
      ...ticker,
      minQuoteVolume: cfg.minQuoteVolume,
      normalizedQuoteVolume: ticker.quoteVolumeFloat,
    }));
  const gateEligible = gateAll
    .filter((ticker) => ticker.quoteVolumeFloat >= gateMinQuoteVolume)
    .map((ticker) => ({
      ...ticker,
      minQuoteVolume: gateMinQuoteVolume,
      normalizedQuoteVolume: ticker.quoteVolumeFloat / effectiveGateVolumeRatio,
    }));
  const cryptoRanked = mergeProviderInstruments(okxEligible, gateEligible, okxAll)
    .sort((a, b) => b.normalizedQuoteVolume - a.normalizedQuoteVolume)
    .map((ticker, index) => ({ ...ticker, rank: index + 1 }));
  const xyzEligible = xyzAll
    .filter((ticker) => ticker.quoteVolumeFloat >= XYZ_MIN_QUOTE_VOLUME)
    .map((ticker) => ({
      ...ticker,
      minQuoteVolume: XYZ_MIN_QUOTE_VOLUME,
      normalizedQuoteVolume: ticker.quoteVolumeFloat,
    }))
    .sort((a, b) => b.quoteVolumeFloat - a.quoteVolumeFloat)
    .map((ticker, index) => ({ ...ticker, rank: index + 1 }));
  const ranked = [...cryptoRanked, ...xyzEligible];

  return {
    ranked,
    providerMeta: {
      okxListed: okxAll.length,
      okxEligible: okxEligible.length,
      gateListed: gateAll.length,
      gateEligible: gateEligible.length,
      gateExclusive: cryptoRanked.filter((ticker) => ticker.marketProvider === 'gate').length,
      gateVolumeRatio,
      effectiveGateVolumeRatio,
      gateMinQuoteVolume,
      xyzListed: xyzAll.length,
      xyzEligible: xyzEligible.length,
      xyzMinQuoteVolume: XYZ_MIN_QUOTE_VOLUME,
      okxError: okxResult.status === 'rejected' ? String(okxResult.reason) : null,
      gateError: gateResult.status === 'rejected' ? String(gateResult.reason) : null,
      xyzError: xyzResult.status === 'rejected' ? String(xyzResult.reason) : null,
    },
  };
}

function normalizeOkxTickers(tickers) {
  return tickers
    .filter((ticker) => ticker.instId?.endsWith('-USDT-SWAP'))
    .map((ticker) => {
      const last = Number(ticker.last || 0);
      const open24h = Number(ticker.open24h || 0);
      const high24h = Number(ticker.high24h || 0);
      const low24h = Number(ticker.low24h || 0);
      const quoteVolumeFloat = last * Number(ticker.volCcy24h || 0);
      const change24h = open24h ? (last / open24h - 1) * 100 : 0;
      const range24hPosition = high24h > low24h ? (last - low24h) / (high24h - low24h) : 0.5;
      return {
        instId: ticker.instId,
        symbol: symbolFromInstId(ticker.instId),
        marketProvider: 'okx',
        last,
        open24h,
        high24h,
        low24h,
        change24h,
        range24hPosition,
        quoteVolumeFloat,
      };
    })
    .filter(validTicker);
}

function normalizeGateTickers(tickers) {
  return tickers
    .filter((ticker) => ticker.contract?.endsWith('_USDT'))
    .map((ticker) => {
      const last = Number(ticker.last || 0);
      const change24h = Number(ticker.change_percentage || 0);
      const open24h = change24h > -100 ? last / (1 + change24h / 100) : 0;
      const high24h = Number(ticker.high_24h || 0);
      const low24h = Number(ticker.low_24h || 0);
      const range24hPosition = high24h > low24h ? (last - low24h) / (high24h - low24h) : 0.5;
      return {
        instId: ticker.contract,
        symbol: symbolFromInstId(ticker.contract),
        marketProvider: 'gate',
        last,
        open24h,
        high24h,
        low24h,
        change24h,
        range24hPosition,
        quoteVolumeFloat: Number(ticker.volume_24h_quote || ticker.volume_24h_settle || 0),
      };
    })
    .filter(validTicker);
}

function normalizeXyzTickers(payload) {
  const universe = Array.isArray(payload?.[0]?.universe) ? payload[0].universe : [];
  const contexts = Array.isArray(payload?.[1]) ? payload[1] : [];
  return universe
    .map((asset, index) => {
      const context = contexts[index] || {};
      const last = Number(context.markPx || context.midPx || context.oraclePx || 0);
      const open24h = Number(context.prevDayPx || 0);
      const change24h = open24h ? (last / open24h - 1) * 100 : 0;
      return {
        instId: asset.name,
        symbol: symbolFromInstId(asset.name),
        marketProvider: 'xyz',
        last,
        open24h,
        high24h: 0,
        low24h: 0,
        change24h,
        range24hPosition: 0.5,
        quoteVolumeFloat: Number(context.dayNtlVlm || 0),
      };
    })
    .filter(validTicker);
}

function validTicker(ticker) {
  return ticker.symbol
    && Number.isFinite(ticker.last)
    && ticker.last > 0
    && Number.isFinite(ticker.quoteVolumeFloat)
    && ticker.quoteVolumeFloat > 0;
}

function deriveGateVolumeRatio(okxTickers, gateTickers, okxMinQuoteVolume) {
  const gateBySymbol = new Map(gateTickers.map((ticker) => [ticker.symbol, ticker]));
  const ratios = okxTickers
    .filter((ticker) => ticker.quoteVolumeFloat >= okxMinQuoteVolume)
    .map((ticker) => {
      const gateTicker = gateBySymbol.get(ticker.symbol);
      return gateTicker?.quoteVolumeFloat >= 1_000_000
        ? gateTicker.quoteVolumeFloat / ticker.quoteVolumeFloat
        : null;
    })
    .filter((ratio) => Number.isFinite(ratio) && ratio > 0)
    .sort((a, b) => a - b);
  if (ratios.length < 10) return GATE_FALLBACK_VOLUME_RATIO;
  const middle = Math.floor(ratios.length / 2);
  return ratios.length % 2
    ? ratios[middle]
    : (ratios[middle - 1] + ratios[middle]) / 2;
}

function mergeProviderInstruments(okxEligible, gateEligible, okxAll = okxEligible) {
  const okxListedSymbols = new Set(okxAll.map((ticker) => ticker.symbol));
  const gateExclusive = gateEligible.filter((ticker) => !okxListedSymbols.has(ticker.symbol));
  return [...okxEligible, ...gateExclusive];
}

async function tickerPrice(provider, instId) {
  let price;
  if (provider === 'gate') {
    const data = await gate('/api/v4/futures/usdt/tickers', { contract: instId }, 0, 0);
    price = Number(data?.[0]?.last || 0);
  } else if (provider === 'xyz') {
    const ticker = normalizeXyzTickers(await hyperliquidInfo({ type: 'metaAndAssetCtxs', dex: 'xyz' }, 0, 0))
      .find((item) => item.instId === instId);
    price = Number(ticker?.last || 0);
  } else {
    const data = await okx('/api/v5/market/ticker', { instId }, 0, 0);
    price = Number(data?.[0]?.last || 0);
  }
  if (!Number.isFinite(price) || price <= 0) throw new Error(`${provider} ticker price unavailable: ${instId}`);
  return price;
}

async function currentPrices(state) {
  const wantedItems = [...(state.signals || []), ...(state.recentSignals || []), ...(state.positions || [])]
    .filter((item) => item?.instId);
  if (!wantedItems.length) return {};

  const wantedByProvider = {
    okx: new Set(wantedItems.filter((item) => (item.marketProvider || providerFromInstId(item.instId)) === 'okx').map((item) => item.instId)),
    gate: new Set(wantedItems.filter((item) => (item.marketProvider || providerFromInstId(item.instId)) === 'gate').map((item) => item.instId)),
    xyz: new Set(wantedItems.filter((item) => (item.marketProvider || providerFromInstId(item.instId)) === 'xyz').map((item) => item.instId)),
  };
  const requests = [];
  if (wantedByProvider.okx.size) {
    requests.push(okx('/api/v5/market/tickers', { instType: 'SWAP' }).then((tickers) => tickers
      .filter((ticker) => wantedByProvider.okx.has(ticker.instId))
      .map((ticker) => [ticker.instId, {
        instId: ticker.instId,
        symbol: symbolFromInstId(ticker.instId),
        marketProvider: 'okx',
        last: Number(ticker.last || 0),
        timestamp: Number(ticker.ts || Date.now()),
      }])));
  }
  if (wantedByProvider.gate.size) {
    requests.push(gate('/api/v4/futures/usdt/tickers').then((tickers) => tickers
      .filter((ticker) => wantedByProvider.gate.has(ticker.contract))
      .map((ticker) => [ticker.contract, {
        instId: ticker.contract,
        symbol: symbolFromInstId(ticker.contract),
        marketProvider: 'gate',
        last: Number(ticker.last || 0),
        timestamp: Date.now(),
      }])));
  }
  if (wantedByProvider.xyz.size) {
    requests.push(hyperliquidInfo({ type: 'metaAndAssetCtxs', dex: 'xyz' }).then((payload) => normalizeXyzTickers(payload)
      .filter((ticker) => wantedByProvider.xyz.has(ticker.instId))
      .map((ticker) => [ticker.instId, {
        instId: ticker.instId,
        symbol: ticker.symbol,
        marketProvider: 'xyz',
        last: ticker.last,
        timestamp: Date.now(),
      }])));
  }
  const results = await Promise.allSettled(requests);
  return Object.fromEntries(results
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .filter(([, price]) => Number.isFinite(price.last) && price.last > 0));
}

async function marketKlines(provider, instId, interval = '15m', limit = 130) {
  if (provider === 'gate') {
    const rows = await gate('/api/v4/futures/usdt/candlesticks', { contract: instId, interval, limit }, 0, 0);
    return normalizeGateKlines(rows);
  }
  if (provider === 'xyz') {
    const intervalMs = INTERVAL_MS[interval];
    if (!intervalMs) throw new Error(`XYZ unsupported interval: ${interval}`);
    const endTime = Date.now();
    const rows = await hyperliquidInfo({
      type: 'candleSnapshot',
      req: {
        coin: instId,
        interval,
        startTime: endTime - (limit + 1) * intervalMs,
        endTime,
      },
    }, 0, 0);
    return normalizeXyzKlines(rows).slice(-limit);
  }
  // Keep K-line scans to one subrequest each. Retrying dozens of rate-limited
  // symbols in the same invocation can exceed Cloudflare's subrequest cap.
  const rows = await okx('/api/v5/market/history-candles', { instId, bar: interval, limit }, 0, 0);
  return rows
    .map((row) => [Number(row[0]), Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[5])])
    .filter((row) => row.every((value) => Number.isFinite(value)))
    .sort((a, b) => a[0] - b[0]);
}

function normalizeGateKlines(rows) {
  return rows
    .map((row) => [Number(row.t) * 1000, Number(row.o), Number(row.h), Number(row.l), Number(row.c), Number(row.v)])
    .filter((row) => row.every((value) => Number.isFinite(value)))
    .sort((a, b) => a[0] - b[0]);
}

function normalizeXyzKlines(rows) {
  return rows
    .map((row) => [Number(row.t), Number(row.o), Number(row.h), Number(row.l), Number(row.c), Number(row.v)])
    .filter((row) => row.every((value) => Number.isFinite(value)))
    .sort((a, b) => a[0] - b[0]);
}

async function okx(path, params = {}, attempt = 0, maxRetries = 2) {
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
  if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
    await sleep(500 * (attempt + 1));
    return okx(path, params, attempt + 1, maxRetries);
  }
  if (!response.ok) throw new Error(`OKX ${path} ${response.status}`);
  const payload = await response.json();
  if (payload.code && payload.code !== '0') throw new Error(`OKX ${path} ${payload.code}: ${payload.msg}`);
  return payload.data || [];
}

async function gate(path, params = {}, attempt = 0, maxRetries = 2) {
  const url = new URL(path, GATE_API);
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
  if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
    await sleep(500 * (attempt + 1));
    return gate(path, params, attempt + 1, maxRetries);
  }
  if (!response.ok) throw new Error(`Gate ${path} ${response.status}`);
  return response.json();
}

async function hyperliquidInfo(body, attempt = 0, maxRetries = 2) {
  const response = await fetch(`${HYPERLIQUID_API}/info`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'momentum-trader-claude-runner/1.0',
    },
    body: JSON.stringify(body),
    cf: { cacheTtl: 0 },
  });
  if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
    await sleep(500 * (attempt + 1));
    return hyperliquidInfo(body, attempt + 1, maxRetries);
  }
  if (!response.ok) throw new Error(`XYZ info ${response.status}`);
  return response.json();
}

function scanFailureReason(error) {
  const message = String(error?.message || error || '');
  if (message.includes('Gate') && message.includes('429')) return 'gate_rate_limit';
  if (message.includes('OKX') && (message.includes('429') || message.includes('50011'))) return 'okx_rate_limit';
  if (message.includes('XYZ')) return 'xyz_api_error';
  if (message.includes('Too many subrequests')) return 'worker_subrequest_limit';
  return 'other';
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
  const prevLow = Math.min(...prev24hBars.map(kLow));
  const momentum1h = pct(prev1h, price) || 0;
  const momentum4h = pct(prev4h, price) || 0;
  const momentum24h = pct(prev24h, price) || 0;
  const position24h = rangePosition(price, last24h.map(kLow), last24h.map(kHigh));
  const distancePrevHigh = pct(prevHigh, price) || 0;
  const distancePrevLow = pct(prevLow, price) || 0;
  const volumeRatio = safeDiv(kVol(c[c.length - 1]), median(c.slice(-5, -1).map(kVol)), 0);
  const atrValue = atrPct(c);
  const ema50 = ema(c.map(kClose), 50);
  const aboveEma = price > ema50;
  const emaSlope = pct(ema(c.slice(0, -8).map(kClose), 50), ema50) || 0;
  const lastBar = c[c.length - 1];
  const marketContext = classifyMarketContext(c, atrValue);
  // 結構位：近 6 小時（24 根 15m）擺動高低點
  const swingLow = Math.min(...c.slice(-24).map(kLow));
  const swingHigh = Math.max(...c.slice(-24).map(kHigh));

  // ══ 多頭分支：上升趨勢（EMA 上方且斜率為正）══
  if (aboveEma && emaSlope >= 0) {
    if (marketContext.isImpulseFollow) {
      const risk = buildRisk(price, atrValue, 'long', marketContext.impulseLow * 0.995);
      let score = 82;
      const reasons = [
        `24h quote volume ${Math.round(quoteVolume).toLocaleString()} USDT`,
        `fresh 15m volume impulse: +${marketContext.impulseGainPct.toFixed(2)}%, ${marketContext.impulseVolumeRatio.toFixed(2)}x volume`,
        'entry window is limited to the next 15m bar',
      ];
      if (marketContext.impulseGainPct >= 6) score += 6;
      if (marketContext.impulseVolumeRatio >= 10) score += 4;
      if (marketContext.impulseCloseLocation >= 0.70) score += 3;
      score += 4;
      reasons.push('above 50-period EMA with positive slope');
      if (riskOff) {
        score -= 12;
        reasons.push('BTC context risk-off penalty');
      }
      score = Math.round(clamp(score, 0, 100));
      if (score < cfg.minSignalScore) return null;

      const metrics = {
        momentum1h, momentum4h, momentum24h, position24h, distancePrevHigh, volumeRatio,
        atrPct: atrValue, stopPct: risk.stopPct, btcRiskOff: riskOff,
        lastKlineOpenTime: kTime(lastBar), aboveEma, emaSlope,
        marketType: marketContext.marketType,
        impulseAgeBars: marketContext.barsSinceImpulse,
        impulseGainPct: marketContext.impulseGainPct,
        impulseVolumeRatio: marketContext.impulseVolumeRatio,
        impulseRetracePct: marketContext.retracePct,
        isImpulseFollow: true,
      };
      return {
        scannedAt, symbol, instId, score,
        strategyKey: 'volume_breakout_follow',
        strategyLabel: LABELS.volume_breakout_follow,
        side: 'long', entry: price, lastPrice: price,
        stop: risk.stop, tp1: risk.tp1, beTrigger: risk.beTrigger,
        lockTrigger: risk.lockTrigger, lockLevel: risk.lockLevel,
        trailPct: risk.trailPct, atrPct: atrValue, quoteVolume, reasons, metrics,
      };
    }

    if (marketContext.hasRecentImpulse && !marketContext.isConfirmedPullback) return null;
    if (momentum1h >= 6) return null;
    if (position24h >= 0.95 && momentum1h > 0) return null;
    if (momentum24h >= 10 && momentum4h < -1 && !marketContext.isConfirmedPullback) return null;
    // 確認K線：最後一根已收盤 15m 必須收紅，避免接刀
    if (kClose(lastBar) <= kOpen(lastBar)) return null;

    const isImpulsePullback = marketContext.isConfirmedPullback;
    // 深度要求：position24h 上限 0.80，排除高位盤整假回檔（回測甜蜜點：PF 1.56 優於 0.70/0.85）
    const isPullback = isImpulsePullback
      || (momentum24h >= 5 && momentum4h >= -1 && momentum1h <= 0.5 && momentum1h >= -3 && position24h >= 0.40 && position24h <= 0.80);
    const risk = buildRisk(price, atrValue, 'long', swingLow * 0.995);
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
    if (isImpulsePullback) {
      score += 14;
      reasons.push(`pump retraced ${marketContext.retracePct.toFixed(1)}% and printed a bullish higher-low confirmation`);
    }
    if (momentum1h >= 4 && position24h >= 0.85) { score -= 14; reasons.push('penalty: chasing the top'); }
    score += 5;
    reasons.push('above 50-period EMA with positive slope');
    score = Math.round(clamp(score, 0, 100));
    if (score < cfg.minSignalScore) return null;

    const metrics = {
      momentum1h, momentum4h, momentum24h, position24h, distancePrevHigh, volumeRatio,
      atrPct: atrValue, stopPct: risk.stopPct, btcRiskOff: riskOff,
      lastKlineOpenTime: kTime(c[c.length - 1]), aboveEma, emaSlope, isPullback,
      isImpulsePullback,
      marketType: marketContext.marketType,
      impulseAgeBars: marketContext.barsSinceImpulse,
      impulseGainPct: marketContext.impulseGainPct,
      impulseVolumeRatio: marketContext.impulseVolumeRatio,
      impulseRetracePct: marketContext.retracePct,
    };
    const key = strategyKey(metrics);
    // 追價策略硬性擋單：1h 已衝 4% 以上不追
    if (key === 'strong_momentum_breakout' && momentum1h >= 4) return null;
    // 放量單專屬窄停損：ATR 門檻已保證標的在動，2% 停損換更高賺賠比
    if (key === 'volume_ignition') { risk.stop = price * 0.98; risk.stopPct = 2; metrics.stopPct = 2; }
    // 回檔/題材單停損上限 4%：贏單 MAE 不超過 3.5%，更寬的停損只稀釋賺賠比
    if ((key === 'pullback_uptrend' || key === 'narrative_momentum') && risk.stopPct > 4) { risk.stop = price * 0.96; risk.stopPct = 4; metrics.stopPct = 4; }
    // 回檔單專屬 +4% 早期保護：浮盈 +4% 後停損拉到 -1%
    const earlyTrigger = key === 'pullback_uptrend' ? price * 1.04 : undefined;
    const earlyLevel = key === 'pullback_uptrend' ? price * 0.99 : undefined;
    return { scannedAt, symbol, instId, score, strategyKey: key, strategyLabel: LABELS[key], side: 'long', entry: price, lastPrice: price, stop: risk.stop, tp1: risk.tp1, beTrigger: risk.beTrigger, lockTrigger: risk.lockTrigger, lockLevel: risk.lockLevel, earlyTrigger, earlyLevel, trailPct: risk.trailPct, atrPct: atrValue, quoteVolume, reasons, metrics };
  }

  // ══ 空頭分支：下降趨勢反彈衰竭（EMA 下方且斜率為負）══
  if (!aboveEma && emaSlope < 0) {
    if (momentum1h <= -6) return null;
    if (position24h <= 0.05 && momentum1h < 0) return null;
    if (momentum24h <= -10 && momentum4h > 1) return null;

    const isRallyFade = momentum24h <= -5 && momentum4h <= 1 && momentum1h >= -0.5 && momentum1h <= 3 && position24h >= 0.15 && position24h <= 0.60;
    if (!isRallyFade) return null;
    // 確認K線：最後一根已收盤 15m 必須收綠，確認反彈開始衰竭
    if (kClose(lastBar) >= kOpen(lastBar)) return null;

    const risk = buildRisk(price, atrValue, 'short', swingHigh * 1.005);
    let score = 10;
    const reasons = [`24h quote volume ${Math.round(quoteVolume).toLocaleString()} USDT`];

    if (momentum4h <= -4 || momentum24h <= -8) { score += 20; reasons.push(`downtrend confirmed: 4h ${momentum4h.toFixed(2)}%, 24h ${momentum24h.toFixed(2)}%`); }
    if (momentum4h <= -8) { score += 8; reasons.push(`strong 4h downside ${momentum4h.toFixed(2)}%`); }
    if (momentum24h <= -15) { score += 8; reasons.push(`strong 24h downside ${momentum24h.toFixed(2)}%`); }
    if (momentum1h < 0) { score += 5; reasons.push(`rally already rolling over: 1h ${momentum1h.toFixed(2)}%`); }
    if (position24h <= 0.25) { score += 20; reasons.push(`price in bottom ${(position24h * 100).toFixed(1)}% of 24h range`); }
    if (distancePrevLow <= 4) { score += 10; reasons.push(`within ${Math.abs(distancePrevLow).toFixed(2)}% of prior 24h low`); }
    if (distancePrevLow < 0) { score += 5; reasons.push('breaking prior 24h low'); }
    if (volumeRatio >= 1.5) { score += 20; reasons.push(`15m volume expansion ${volumeRatio.toFixed(2)}x`); }
    if (volumeRatio >= 3) { score += 5; reasons.push('volume expansion is unusually strong'); }
    if (momentum1h >= -18) { score += 10; reasons.push('not a capitulation candle'); } else { score -= 15; reasons.push(`1h move ${momentum1h.toFixed(2)}% is a capitulation, bounce risk`); }
    if (riskOff) { score += 8; reasons.push('BTC risk-off supports shorts'); }
    score += 18;
    reasons.push('rally exhaustion in downtrend');
    score += 5;
    reasons.push('below 50-period EMA with negative slope');
    score = Math.round(clamp(score, 0, 100));
    if (score < cfg.minSignalScore) return null;

    const metrics = { momentum1h, momentum4h, momentum24h, position24h, distancePrevHigh, distancePrevLow, volumeRatio, atrPct: atrValue, stopPct: risk.stopPct, btcRiskOff: riskOff, lastKlineOpenTime: kTime(c[c.length - 1]), aboveEma, emaSlope, isRallyFade };
    return { scannedAt, symbol, instId, score, strategyKey: 'rally_downtrend', strategyLabel: LABELS.rally_downtrend, side: 'short', entry: price, lastPrice: price, stop: risk.stop, tp1: risk.tp1, beTrigger: risk.beTrigger, lockTrigger: risk.lockTrigger, lockLevel: risk.lockLevel, trailPct: risk.trailPct, atrPct: atrValue, quoteVolume, reasons, metrics };
  }

  return null;
}

function recordPositionEvent(position, event) {
  position.events = Array.isArray(position.events) ? position.events : [];
  const time = Number(event.time || Date.now());
  position.events.push({
    id: `${position.id || position.symbol}_${event.type}_${time}_${position.events.length}`,
    type: event.type,
    time,
    price: Number(event.price || 0),
    qtyDelta: Number(event.qtyDelta || 0),
    remainingQty: Number(event.remainingQty ?? position.remainingQty ?? 0),
    stop: Number(event.stop ?? position.stop ?? 0),
    pnl: Number(event.pnl || 0),
    reason: event.reason || '',
    note: event.note || '',
  });
  position.events = position.events.slice(-50);
}

function ensurePositionEvents(position) {
  if (Array.isArray(position.events) && position.events.length) return;
  position.events = [];
  recordPositionEvent(position, {
    type: 'open',
    time: position.entryTime,
    price: position.entry,
    qtyDelta: position.qty,
    remainingQty: position.qty,
    stop: position.originalStop || position.stop,
    note: 'reconstructed',
  });
  let remainingQty = Number(position.qty || 0);
  for (const partial of [...(position.partialExits || [])].sort((a, b) => Number(a.exitTime || 0) - Number(b.exitTime || 0))) {
    const qty = Math.max(0, Number(partial.qty || 0));
    remainingQty = Math.max(0, remainingQty - qty);
    recordPositionEvent(position, {
      type: partial.type === 'tp1' ? 'tp1' : 'partial_exit',
      time: partial.exitTime,
      price: partial.exit,
      qtyDelta: -qty,
      remainingQty,
      stop: position.entry,
      pnl: partial.pnl,
      note: 'reconstructed',
    });
  }
  const reconstructedAt = Number(position.lastTime || position.entryTime || Date.now());
  if (position.side !== 'short' && position.earlyTrigger && Number(position.highest || 0) >= position.earlyTrigger) {
    recordPositionEvent(position, {
      type: 'early_protection',
      time: reconstructedAt,
      price: position.earlyTrigger,
      remainingQty: position.remainingQty,
      stop: position.earlyLevel || position.entry * 0.99,
      note: 'reconstructed',
    });
  }
  const lockTriggered = position.side === 'short'
    ? position.lockTrigger && Number(position.lowest || position.entry) <= position.lockTrigger
    : position.lockTrigger && Number(position.highest || position.entry) >= position.lockTrigger;
  if (lockTriggered) {
    recordPositionEvent(position, {
      type: 'lock_protection',
      time: reconstructedAt,
      price: position.lockTrigger,
      remainingQty: position.remainingQty,
      stop: position.lockLevel || position.entry,
      note: 'reconstructed',
    });
  }
}

function recordProtectionEvents(position, time) {
  position.events = Array.isArray(position.events) ? position.events : [];
  const hasEvent = (type) => position.events.some((event) => event.type === type);
  const high = Number(position.highest || position.entry);
  const low = Number(position.lowest || position.entry);
  if (
    position.side !== 'short'
    && position.earlyTrigger
    && high >= position.earlyTrigger
    && !hasEvent('early_protection')
  ) {
    recordPositionEvent(position, {
      type: 'early_protection',
      time,
      price: position.earlyTrigger,
      remainingQty: position.remainingQty,
      stop: position.earlyLevel || position.entry * 0.99,
    });
  }
  const lockTriggered = position.side === 'short'
    ? position.lockTrigger && low <= position.lockTrigger
    : position.lockTrigger && high >= position.lockTrigger;
  if (lockTriggered && !hasEvent('lock_protection')) {
    recordPositionEvent(position, {
      type: 'lock_protection',
      time,
      price: position.lockTrigger,
      remainingQty: position.remainingQty,
      stop: position.lockLevel || position.entry,
    });
  }
}

function closePosition(state, p, exit, reason, exitTime) {
  const exitPnl = p.side === 'short' ? p.remainingQty * (p.entry - exit) : p.remainingQty * (exit - p.entry);
  const totalPnl = (p.realizedPnl || 0) + exitPnl;
  state.equity += exitPnl;
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  const mfePct = p.side === 'short' ? (p.entry - (p.lowest || p.entry)) / p.entry * 100 : pct(p.entry, p.highest) || 0;
  const maePct = p.side === 'short' ? (p.entry - (p.highest || p.entry)) / p.entry * 100 : pct(p.entry, p.lowest) || 0;
  recordPositionEvent(p, {
    type: 'close',
    time: exitTime,
    price: exit,
    qtyDelta: -Number(p.remainingQty || 0),
    remainingQty: 0,
    stop: effectiveStopFor(p),
    pnl: exitPnl,
    reason,
  });
  state.trades.unshift({ symbol: p.symbol, instId: p.instId, marketProvider: p.marketProvider || providerFromInstId(p.instId), strategyKey: p.strategyKey, strategyLabel: p.strategyLabel, side: p.side || 'long', entryTime: p.entryTime, exitTime, entry: p.entry, exit, qty: p.qty, pnl: totalPnl, rMultiple: safeDiv(totalPnl, p.riskUsdt, 0), reason, mfePct, maePct, score: p.score, partialExits: p.partialExits || [], events: p.events || [] });
  state.equityCurve.push({ timeMs: exitTime, equity: state.equity, drawdownPct: safeDiv(state.peakEquity - state.equity, state.peakEquity, 0) * 100 });
  state.consecutiveLosses = totalPnl < 0 ? state.consecutiveLosses + 1 : 0;
  if (state.consecutiveLosses >= 3) {
    state.pausedUntil = Date.now() + 6 * 60 * 60 * 1000;
    state.consecutiveLosses = 0;
  }
  if (safeDiv(state.peakEquity - state.equity, state.peakEquity, 0) >= 0.12) state.running = false;
}

function takeBreakEvenPartial(state, p, exitTime) {
  if (!p.bePartialEnabled || p.bePartialDone || p.tp1Done || !p.beTrigger) return false;
  const triggered = p.side === 'short'
    ? (p.lowest || p.entry) <= p.beTrigger
    : (p.highest || p.entry) >= p.beTrigger;
  if (!triggered) return false;

  const closeQty = p.remainingQty * 0.5;
  const partialPnl = p.side === 'short'
    ? closeQty * (p.entry - p.beTrigger)
    : closeQty * (p.beTrigger - p.entry);
  state.equity += partialPnl;
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  p.realizedPnl = (p.realizedPnl || 0) + partialPnl;
  p.remainingQty -= closeQty;
  p.bePartialDone = true;
  p.stop = p.entry;
  p.partialExits = p.partialExits || [];
  p.partialExits.push({ type: 'be_partial', exitTime, exit: p.beTrigger, qty: closeQty, pnl: partialPnl });
  recordPositionEvent(p, {
    type: 'partial_exit',
    time: exitTime,
    price: p.beTrigger,
    qtyDelta: -closeQty,
    remainingQty: p.remainingQty,
    stop: p.stop,
    pnl: partialPnl,
  });
  return true;
}

function takeTP1(state, p, exitTime) {
  const sellQty = p.remainingQty * 0.5;
  const tpPnl = p.side === 'short' ? sellQty * (p.entry - p.tp1) : sellQty * (p.tp1 - p.entry);
  state.equity += tpPnl;
  state.peakEquity = Math.max(state.peakEquity, state.equity);
  p.realizedPnl = (p.realizedPnl || 0) + tpPnl;
  p.remainingQty -= sellQty;
  p.tp1Done = true;
  p.stop = p.entry;
  p.partialExits = p.partialExits || [];
  p.partialExits.push({ type: 'tp1', exitTime, exit: p.tp1, qty: sellQty, pnl: tpPnl });
  recordPositionEvent(p, {
    type: 'tp1',
    time: exitTime,
    price: p.tp1,
    qtyDelta: -sellQty,
    remainingQty: p.remainingQty,
    stop: p.stop,
    pnl: tpPnl,
  });
}

async function notifyNewPosition(env, position, state) {
  const message = positionNotificationText(position);
  const createdAt = Date.now();
  const payload = { type: 'new_position', position, equity: state.equity };
  const queueMessage = {
    id: `notification_${position.id}`,
    type: 'new_position',
    symbol: position.symbol,
    positionId: position.id,
    createdAt,
    text: message,
    payload,
  };
  let result;
  const configured = configuredNotificationChannels(env);
  if (env.NOTIFICATION_QUEUE && configured > 0) {
    try {
      await env.NOTIFICATION_QUEUE.send(queueMessage);
      result = { configured, sent: 0, queued: true, attempts: [], failures: [] };
    } catch (error) {
      result = await sendNotification(env, message, payload);
      result.queueError = String(error);
    }
  } else {
    result = await sendNotification(env, message, payload);
  }
  const record = {
    type: 'new_position',
    symbol: position.symbol,
    positionId: position.id,
    createdAt,
    pending: result.configured > 0 && result.sent === 0 && !result.queued,
    ...result,
  };
  storeNotificationRecord(state, record);
  if (record.pending) queuePositionNotification(state, position, message, record.createdAt);
  return result;
}

function positionNotificationText(position) {
  const sideText = position.side === 'short' ? '空單' : '多單';
  const providerText = position.marketProvider === 'gate'
    ? 'Gate'
    : position.marketProvider === 'xyz'
      ? 'XYZ'
      : 'OKX';
  const reasons = (position.reasons || []).slice(0, 3).join('\n- ');
  return [
    `新模擬單：${position.symbol} ${sideText}`,
    `來源：${providerText}`,
    `策略：${position.strategyLabel || position.strategyKey}`,
    `分數：${position.score}`,
    `進場：${fmtNumber(position.entry, 8)}`,
    `停損：${fmtNumber(position.stop, 8)}`,
    `TP1：${fmtNumber(position.tp1, 8)}`,
    `風險：${fmtNumber(position.riskUsdt, 2)} U`,
    reasons ? `理由：\n- ${reasons}` : '',
    `時間：${new Date(position.entryTime).toISOString()}`,
  ].filter(Boolean).join('\n');
}

function queuePositionNotification(state, position, text, createdAt) {
  const pending = {
    id: `notification_${position.id}`,
    type: 'new_position',
    symbol: position.symbol,
    positionId: position.id,
    createdAt,
    text,
    payload: { type: 'new_position', position, equity: state.equity },
    deliveryCycles: 0,
  };
  state.pendingNotifications = [
    pending,
    ...(state.pendingNotifications || []).filter((item) => item.positionId !== position.id),
  ].slice(0, 20);
}

function recoverLastFailedNotification(state) {
  const last = state.lastNotification;
  if (!last || last.type !== 'new_position' || last.sent !== 0 || last.queued || Number(last.deliveryCycles || 0) >= 12) return;
  if ((state.pendingNotifications || []).some((item) => item.positionId === last.positionId)) return;
  const position = (state.positions || []).find((item) => item.id === last.positionId);
  if (position) queuePositionNotification(state, position, positionNotificationText(position), last.createdAt || Date.now());
}

function storeNotificationRecord(state, record) {
  state.lastNotification = record;
  state.notificationLog = [
    record,
    ...(state.notificationLog || []).filter((item) => item.positionId !== record.positionId),
  ].slice(0, 100);
}

async function flushPendingNotifications(state, env) {
  const pending = state.pendingNotifications || [];
  if (!pending.length) return false;

  const remaining = [];
  for (const item of pending.slice(0, 2)) {
    const result = await sendNotification(env, item.text, item.payload);
    const deliveryCycles = Number(item.deliveryCycles || 0) + 1;
    const record = {
      type: item.type,
      symbol: item.symbol,
      positionId: item.positionId,
      createdAt: item.createdAt,
      retriedAt: Date.now(),
      deliveryCycles,
      pending: result.configured > 0 && result.sent === 0 && deliveryCycles < 12,
      ...result,
    };
    storeNotificationRecord(state, record);
    if (record.pending) remaining.push({ ...item, deliveryCycles });
  }
  state.pendingNotifications = [...remaining, ...pending.slice(2)].slice(0, 20);
  return true;
}

async function handleNotificationQueue(batch, env) {
  for (const message of batch.messages) {
    const item = message.body || {};
    const result = await sendNotification(env, item.text || '', item.payload || {});
    const delivered = result.sent > 0 || result.configured === 0;
    const record = {
      type: item.type || 'new_position',
      symbol: item.symbol,
      positionId: item.positionId,
      createdAt: item.createdAt || Date.now(),
      updatedAt: Date.now(),
      queueAttempts: message.attempts,
      queued: !delivered,
      pending: false,
      ...result,
    };
    if (item.type === 'new_position') await saveNotificationStatus(env, record);
    if (delivered) {
      message.ack();
    } else {
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function handleNotificationDeadLetters(batch, env) {
  for (const message of batch.messages) {
    const item = message.body || {};
    if (item.type === 'new_position') {
      await saveNotificationStatus(env, {
        type: item.type,
        symbol: item.symbol,
        positionId: item.positionId,
        createdAt: item.createdAt || Date.now(),
        updatedAt: Date.now(),
        queueAttempts: message.attempts,
        configured: configuredNotificationChannels(env),
        sent: 0,
        queued: false,
        pending: true,
        attempts: [],
        failures: [{ channel: 'queue', error: 'Queue retries exhausted; message moved to the dead-letter queue.' }],
      });
    }
    message.ack();
  }
}

async function saveNotificationStatus(env, record) {
  await env.PAPER_STATE.put(NOTIFICATION_STATUS_KEY, JSON.stringify(record));
}

function configuredNotificationChannels(env) {
  return Number(Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)) +
    Number(Boolean(env.DISCORD_WEBHOOK_URL)) +
    Number(Boolean(env.NOTIFY_WEBHOOK_URL));
}

async function sendNotification(env, text, payload = {}) {
  const tasks = [];

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    tasks.push({
      channel: 'telegram',
      send: () => sendTelegramNotification(env, text, payload),
    });
  }

  if (env.DISCORD_WEBHOOK_URL) {
    tasks.push({
      channel: 'discord',
      send: () => fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      }),
    });
  }

  if (env.NOTIFY_WEBHOOK_URL) {
    tasks.push({
      channel: 'webhook',
      send: () => fetch(env.NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, ...payload }),
      }),
    });
  }

  if (!tasks.length) return { configured: 0, sent: 0, failures: [] };

  const results = await Promise.all(tasks.map(sendNotificationWithRetry));
  const failures = results.filter((result) => !result.ok);
  return {
    configured: tasks.length,
    sent: tasks.length - failures.length,
    attempts: results.map(({ channel, attempts }) => ({ channel, attempts })),
    failures: failures.map(({ channel, attempts, status, error, body }) => ({ channel, attempts, status, error, body })),
    warnings: results.filter((result) => result.warning).map(({ channel, warning }) => ({ channel, ...warning })),
  };
}

async function sendTelegramNotification(env, text, payload) {
  const sendResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!sendResponse.ok || payload.type !== 'new_position') return sendResponse;

  let sentMessage;
  try {
    sentMessage = await sendResponse.json();
  } catch (error) {
    return { ok: true, warning: { action: 'pin', error: `Telegram send response was not JSON: ${error}` } };
  }

  const messageId = sentMessage?.result?.message_id;
  if (!messageId) {
    return { ok: true, warning: { action: 'pin', error: 'Telegram send response did not include message_id.' } };
  }

  const pinResult = await pinTelegramMessage(env, messageId);
  if (!pinResult.ok) {
    console.warn('telegram pin failed', pinResult);
    return { ok: true, warning: { action: 'pin', ...pinResult } };
  }
  return { ok: true };
}

async function pinTelegramMessage(env, messageId) {
  const maxAttempts = 3;
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/pinChatMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          message_id: messageId,
          disable_notification: true,
        }),
      });
      if (response.ok) return { ok: true, attempts: attempt };

      const body = (await response.text().catch(() => '')).slice(0, 500);
      lastFailure = { ok: false, attempts: attempt, status: response.status, body };
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = { ok: false, attempts: attempt, error: String(error) };
      if (lastFailure.error.includes('Too many subrequests')) break;
    }

    if (attempt < maxAttempts) await sleep(500 * (2 ** (attempt - 1)));
  }

  return lastFailure || { ok: false, attempts: 0, error: 'Telegram pin failed without a response.' };
}

async function sendNotificationWithRetry(task) {
  const maxAttempts = 3;
  let lastFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await task.send();
      if (response.ok) return { ok: true, channel: task.channel, attempts: attempt, warning: response.warning };

      const body = (await response.text().catch(() => '')).slice(0, 500);
      lastFailure = { ok: false, channel: task.channel, attempts: attempt, status: response.status, body };
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = { ok: false, channel: task.channel, attempts: attempt, error: String(error) };
      if (lastFailure.error.includes('Too many subrequests')) break;
    }

    if (attempt < maxAttempts) await sleep(500 * (2 ** (attempt - 1)));
  }

  console.warn('notification failed', task.channel, lastFailure);
  return lastFailure;
}

function buildRisk(entry, atrValue, side = 'long', structStop = null) {
  const atrStopPct = Math.max(3, Math.min(8, 1.2 * atrValue));
  const trailPct = Math.max(8, 1.5 * atrValue);
  if (side === 'short') {
    // 結構停損：放在近期擺動高點上方，取較寬者，寬度上限 10%
    let stop = entry * (1 + atrStopPct / 100);
    if (structStop && structStop > stop) stop = Math.min(structStop, entry * 1.10);
    const stopPct = (stop / entry - 1) * 100;
    return { stop, tp1: entry * 0.85, beTrigger: entry * 0.95, lockTrigger: entry * 0.90, lockLevel: entry * 0.97, trailPct, stopPct };
  }
  // 結構停損：放在近期擺動低點下方，取較寬者，寬度上限 10%
  let stop = entry * (1 - atrStopPct / 100);
  if (structStop && structStop < stop) stop = Math.max(structStop, entry * 0.90);
  const stopPct = (1 - stop / entry) * 100;
  return { stop, tp1: entry * 1.20, beTrigger: entry * 1.08, lockTrigger: entry * 1.15, lockLevel: entry * 1.05, trailPct, stopPct };
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
  if (p.earlyTrigger && high >= p.earlyTrigger) return Math.max(p.stop, p.earlyLevel || p.entry * 0.99);
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
  if (p.earlyTrigger && high >= p.earlyTrigger) return 'early_stop';
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

function positionKlineLimit(position) {
  const lastTime = Number(position?.lastTime || position?.entryTime || 0);
  if (!lastTime) return POSITION_KLINE_LOOKBACK_MAX;
  const missingBars = Math.ceil(Math.max(0, Date.now() - lastTime) / INTERVAL_MS['15m']);
  return clamp(missingBars + 4, POSITION_KLINE_LOOKBACK_MIN, POSITION_KLINE_LOOKBACK_MAX);
}

function positionKlinesAfter(position, rows, now = Date.now()) {
  const lastTime = Number(position?.lastTime || position?.entryTime || 0);
  const pendingRows = rows.filter((row, index) => (
    kTime(row) > lastTime && (!index || kTime(row) !== kTime(rows[index - 1]))
  ));
  if (!lastTime) return pendingRows;

  const intervalMs = INTERVAL_MS['15m'];
  const expectedTime = Math.floor(lastTime / intervalMs) * intervalMs + intervalMs;
  const latestClosedTime = Math.floor(now / intervalMs) * intervalMs - intervalMs;
  const firstMismatch = pendingRows.find((row, index) => kTime(row) !== expectedTime + index * intervalMs);
  const trailingGap = pendingRows.length && kTime(pendingRows[pendingRows.length - 1]) < latestClosedTime;
  if (expectedTime <= latestClosedTime && (!pendingRows.length || firstMismatch || trailingGap)) {
    const firstAvailableTime = firstMismatch ? kTime(firstMismatch) : null;
    const mismatchIndex = firstMismatch ? pendingRows.indexOf(firstMismatch) : pendingRows.length;
    const missingStartTime = expectedTime + mismatchIndex * intervalMs;
    const missingEndTime = firstAvailableTime ? firstAvailableTime - intervalMs : latestClosedTime;
    const missingBars = Math.floor((missingEndTime - missingStartTime) / intervalMs) + 1;
    const error = new Error(
      `position_history_gap: expected ${new Date(missingStartTime).toISOString()}, `
      + `first available ${firstAvailableTime ? new Date(firstAvailableTime).toISOString() : 'none'}`,
    );
    error.code = 'position_history_gap';
    error.details = { lastTime, expectedTime: missingStartTime, firstAvailableTime, missingBars };
    throw error;
  }
  return pendingRows;
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

function classifyMarketContext(rows, atrValue) {
  const lastIndex = rows.length - 1;
  const firstIndex = Math.max(8, lastIndex - 48);
  let impulse = null;

  for (let i = firstIndex; i <= lastIndex; i++) {
    const priorVolumes = rows.slice(i - 8, i).map(kVol);
    const baseVolume = median(priorVolumes);
    const open = kOpen(rows[i]);
    const high = kHigh(rows[i]);
    const low = kLow(rows[i]);
    const close = kClose(rows[i]);
    const gainPct = pct(open, close) || 0;
    const rangePct = pct(open, high) || 0;
    const volumeRatio = safeDiv(kVol(rows[i]), baseVolume, 0);
    const closeLocation = safeDiv(close - low, high - low, 0.5);
    const minImpulseRange = Math.max(5, atrValue * 1.5);

    if (gainPct >= 4 && rangePct >= minImpulseRange && volumeRatio >= 5 && closeLocation >= 0.50) {
      impulse = { index: i, gainPct, volumeRatio, closeLocation, low };
    }
  }

  if (!impulse) {
    return {
      marketType: 'normal_trend',
      hasRecentImpulse: false,
      isImpulseFollow: false,
      isConfirmedPullback: false,
      barsSinceImpulse: null,
      impulseGainPct: null,
      impulseVolumeRatio: null,
      impulseCloseLocation: null,
      impulseLow: null,
      retracePct: null,
    };
  }

  const barsSinceImpulse = lastIndex - impulse.index;
  const baseStart = Math.max(0, impulse.index - 8);
  const impulseBase = Math.min(...rows.slice(baseStart, impulse.index + 1).map(kLow));
  const impulseHigh = Math.max(...rows.slice(impulse.index).map(kHigh));
  const currentClose = kClose(rows[lastIndex]);
  const impulseRange = impulseHigh - impulseBase;
  const retracePct = clamp(safeDiv(impulseHigh - currentClose, impulseRange, 0) * 100, 0, 100);
  const previousBar = rows[lastIndex - 1];
  const lastBar = rows[lastIndex];
  const bullishHigherLow = barsSinceImpulse > 0
    && kClose(lastBar) > kOpen(lastBar)
    && kLow(lastBar) > kLow(previousBar)
    && kClose(lastBar) > kClose(previousBar);
  const isConfirmedPullback = barsSinceImpulse > 0
    && retracePct >= 35
    && retracePct <= 60
    && bullishHigherLow;

  let marketType = 'pump_exhaustion';
  if (barsSinceImpulse === 0) marketType = 'volume_impulse';
  else if (retracePct < 35) marketType = 'high_range_consolidation';
  else if (retracePct <= 60) marketType = isConfirmedPullback ? 'confirmed_pump_pullback' : 'pump_pullback_wait';

  return {
    marketType,
    hasRecentImpulse: true,
    isImpulseFollow: barsSinceImpulse === 0,
    isConfirmedPullback,
    barsSinceImpulse,
    impulseGainPct: impulse.gainPct,
    impulseVolumeRatio: impulse.volumeRatio,
    impulseCloseLocation: impulse.closeLocation,
    impulseLow: impulse.low,
    retracePct,
  };
}

function strategyKey(m) {
  if (m.isImpulsePullback) return 'impulse_pullback_reclaim';
  if (m.isPullback) return 'pullback_uptrend';
  if ((m.momentum4h >= 15 && m.position24h >= 0.80) || (m.momentum24h >= 20 && m.distancePrevHigh >= -2)) return 'strong_momentum_breakout';
  if (m.momentum24h >= 8 && m.position24h >= 0.75 && m.position24h < 0.92 && m.momentum4h >= -3 && m.momentum4h <= 8) return 'high_range_continuation';
  // ATR 門檻：擋掉低波動標的（美股代幣隔夜死水）的單根量能假觸發
  if (m.volumeRatio >= 2 && m.position24h >= 0.65 && m.momentum1h > -1 && m.atrPct >= 0.8) return 'volume_ignition';
  return 'narrative_momentum';
}

function sideForStrategy(key) {
  return STRATEGY_SIDES[key] || 'long';
}

function symbolFromInstId(instId) {
  const provider = providerFromInstId(instId);
  if (provider === 'xyz') {
    return String(instId).replace(/^xyz:/, '');
  }
  if (provider === 'gate') {
    return instId.slice(0, -'_USDT'.length).replaceAll('_', '') + 'USDT';
  }
  return instId.replace('-USDT-SWAP', 'USDT').replaceAll('-', '');
}

function providerFromInstId(instId) {
  if (String(instId || '').startsWith('xyz:')) return 'xyz';
  return String(instId || '').endsWith('_USDT') ? 'gate' : 'okx';
}

function instIdFromSymbol(symbol, provider = 'okx') {
  if (provider === 'xyz') return `xyz:${String(symbol).replace(/^xyz:/i, '')}`;
  const base = symbol.replace(/USDT$/, '');
  return provider === 'gate' ? `${base}_USDT` : `${base}-USDT-SWAP`;
}

function anomalyScore(ticker, previous) {
  const positiveChange = Math.max(0, ticker.change24h || 0);
  const rangePressure = Math.max(0, (ticker.range24hPosition || 0.5) - 0.65) * 100;
  const rankJump = previous?.rank ? Math.max(0, previous.rank - ticker.rank) : 0;
  const quoteVolumeGrowthPct = previous?.quoteVolumeFloat
    ? Math.max(0, (ticker.quoteVolumeFloat / previous.quoteVolumeFloat - 1) * 100)
    : 0;
  const liquidityWeight = Math.max(0, Math.log10(Math.max(ticker.normalizedQuoteVolume || ticker.quoteVolumeFloat, 1) / 1_000_000));

  return positiveChange * 2
    + rangePressure * 1.2
    + Math.min(rankJump, 50) * 1.5
    + Math.min(quoteVolumeGrowthPct, 250) * 0.35
    + liquidityWeight * 2;
}

function buildTickerSnapshot(ranked, providerMeta = {}) {
  const items = {};
  for (const ticker of ranked.slice(0, 240)) {
    items[ticker.instId] = {
      rank: ticker.rank,
      symbol: ticker.symbol,
      marketProvider: ticker.marketProvider,
      minQuoteVolume: ticker.minQuoteVolume,
      normalizedQuoteVolume: ticker.normalizedQuoteVolume,
      last: ticker.last,
      change24h: ticker.change24h,
      range24hPosition: ticker.range24hPosition,
      quoteVolumeFloat: ticker.quoteVolumeFloat,
    };
  }
  return { savedAt: Date.now(), providerMeta, items };
}

function rankedFromTickerSnapshot(snapshot, cfg, now = Date.now()) {
  const savedAt = Number(snapshot?.savedAt || 0);
  if (!savedAt || now - savedAt > TICKER_SNAPSHOT_MAX_AGE_MS || !snapshot?.items) return [];
  return Object.entries(snapshot.items)
    .map(([instId, ticker]) => ({
      instId,
      symbol: ticker.symbol || symbolFromInstId(instId),
      marketProvider: ticker.marketProvider || providerFromInstId(instId),
      last: Number(ticker.last || 0),
      change24h: Number(ticker.change24h || 0),
      range24hPosition: Number(ticker.range24hPosition ?? 0.5),
      quoteVolumeFloat: Number(ticker.quoteVolumeFloat || 0),
      minQuoteVolume: Number(ticker.minQuoteVolume || (
        (ticker.marketProvider || providerFromInstId(instId)) === 'gate'
          ? snapshot.providerMeta?.gateMinQuoteVolume || GATE_MIN_QUOTE_VOLUME
          : (ticker.marketProvider || providerFromInstId(instId)) === 'xyz'
            ? snapshot.providerMeta?.xyzMinQuoteVolume || XYZ_MIN_QUOTE_VOLUME
            : cfg.minQuoteVolume
      )),
      normalizedQuoteVolume: Number(ticker.normalizedQuoteVolume || ticker.quoteVolumeFloat || 0),
      rank: Number(ticker.rank || 0),
    }))
    .filter((ticker) => (
      ticker.marketProvider === 'gate'
        ? ticker.quoteVolumeFloat >= Number(snapshot.providerMeta?.gateMinQuoteVolume || GATE_MIN_QUOTE_VOLUME)
        : ticker.marketProvider === 'xyz'
          ? ticker.quoteVolumeFloat >= Number(snapshot.providerMeta?.xyzMinQuoteVolume || XYZ_MIN_QUOTE_VOLUME)
          : ticker.quoteVolumeFloat >= cfg.minQuoteVolume
    ))
    .sort((a, b) => a.rank - b.rank || b.quoteVolumeFloat - a.quoteVolumeFloat);
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

function kOpen(k) { return Number(k[1]); }
function kHigh(k) { return Number(k[2]); }
function kLow(k) { return Number(k[3]); }
function kClose(k) { return Number(k[4]); }
function kVol(k) { return Number(k[5]); }
function kTime(k) { return Number(k[0]); }
function pct(a, b) { return !a || b === null || b === undefined ? null : (b / a - 1) * 100; }
function safeDiv(a, b, def = 0) { return !b || a === null || a === undefined ? def : a / b; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function fmtNumber(value, digits = 4) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? '');
  return number.toLocaleString('en-US', { maximumFractionDigits: digits });
}
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
