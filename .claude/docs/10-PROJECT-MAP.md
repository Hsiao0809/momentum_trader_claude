# 10 — 專案地圖（動手前先讀這份，不要盲掃檔案）

> 行號是 2026-07-03 的快照，**會漂移**。定位一律以 `Grep` 函式名為準，行號只當粗略導航。

## 這是什麼系統

加密貨幣動能策略「紙上交易」系統，兩個執行面：

| 面 | 檔案 | 資料源 | 執行方式 |
|---|---|---|---|
| Dashboard（UI + 獨立模式） | `momentum_trader_claude.html` | Binance Futures（瀏覽器直連） | 使用者開網頁 |
| 24/7 Runner | `worker/src/index.js` | OKX USDT 永續（Binance 擋 Workers，403） | Cloudflare cron，每 5 分鐘 |

- 部署：Cloudflare Pages（前端）+ Cloudflare Workers（runner）。Runner 線上網址：`https://momentum-trader-claude-runner.siaosiao1016.workers.dev`
- 狀態存 Cloudflare KV（binding `PAPER_STATE`）；開倉通知走 Cloudflare Queue `momentum-trader-notifications`（+ DLQ）。
- **這個 worker 是正在線上運行的真實系統**。改壞了不是測試掛掉，是使用者的紙上交易停擺或行為錯亂。

## 指令表

| 指令 | 作用 |
|---|---|
| `npm run verify` | 語法閘門：worker + HTML 內嵌 JS 的 `node --check` + build。**改完 code 必跑** |
| `npm run build` | 把兩個 html 複製到 `dist/` |
| `npm run dev` | build + `wrangler pages dev dist`（本地預覽，沙箱內通常不需要） |
| `npm run deploy` / `worker:deploy` / `deploy:all` | 部署（**需要 Cloudflare 憑證，模型不要主動執行**，交給使用者） |
| `npm run worker:tail` | 看線上 worker log（需憑證） |

沒有測試、沒有 linter。邏輯正確性靠 `.claude/docs/30-JUDGMENT.md` 的檢查表與 fresh-context 驗收。

## ⚠️ 雙實作對照表（本 repo 第一大坑）

以下函式在 **兩個檔案各有一份**，同名不同源（HTML 吃 Binance K 線格式、worker 吃 OKX）。改策略邏輯時，先在兩檔各 grep 一次，決定改一邊還是兩邊，並在回覆中明說理由：

`evaluateSignal`、`scanSignals`、`buildRisk`、`effectiveStopFor`、`stopReasonFor`、`positionSize`、`closePosition`、`takeBreakEvenPartial`、`takeTP1`、`updatePositions`、`atrPct`、`btcRiskOff`、`strategyKey`、`sideForStrategy`、`closedKlines`、`rangePosition`、`kHigh`/`kLow`/`kClose`/`kVol`/`kTime`、`ema`/`mean`/`median`、`pct`/`safeDiv`/`clamp`

判斷準則：
- **策略規則本身**（進出場條件、停損停利、分批比例、風險參數）→ 幾乎一定要兩邊都改，讓 dashboard 顯示與 runner 行為一致。
- ⚠️ **風險常數多空鏡像**：`buildRisk` 對多、空各回傳一組鏡像常數（多單 `tp1:entry*1.20` ↔ 空單 `tp1:entry*0.80`，be/lock/trail 同理）。改任何一個百分比＝改「兩檔 × 多空」**四處**，只改多單那邊是最常見的無聲分岔。
- **資料抓取、掃描預算、KV/Queue、通知** → 通常只在 worker。
- **畫面、圖表、PnL 分析頁** → 只在 HTML。

## momentum_trader_claude.html（約 2000 行，105KB）

**禁止無 offset 整檔 Read**（見 `00-DIAGNOSIS.md` 弱點 2）。結構：

- L7–159 `<style>`；L161–386 HTML 骨架：主 dashboard（訊號表、持倉、回測、平倉表）、`settingsBackdrop`/drawer、PnL 分析頁（`pnlChartView`、`pnlCalendarView`、覆盤分析）
- L387–1998 單一 `<script>`，大致分區（以函式名 grep 定位）：
  - 工具/格式化：`nowMs`、`tw`、`fmt`、`log`、`updateStatusLine`
  - 雲端同步（GitHub Gist）：`loadCloudCfg`、`fetchGist`、`pushToCloud`、`syncNow`
  - 與 worker 對接：`serverRequest`、`syncServerState`、`applyServerState`、`refreshServerSnapshot`、`startLiveRefresh`（頁面隱藏時暫停）
  - 瀏覽器通知：`toggleBrowserNotifications`、`maybeShowBrowserNotification`
  - 設定 drawer / server config：`toggleSettingsDrawer`、`updateServerConfig`、`togglePaperState`
  - Binance API：`request`、`exchangeInfo`、`ticker24h`、`klines`、`historicalKlines`、`topSymbols`
  - 策略（雙實作區）：`evaluateSignal`、`scanSignals`、`buildRisk`⋯（見上表）
  - 回測：`simulateTrade`、`summarize`、`applyPortfolio`、`runBacktest`
  - 本地紙上交易：`startPaper`、`paperTick`、`updatePositions`
  - 渲染：`refreshMarks`、`drawSpark`、`metric`、`statsFromTrades`
  - PnL 分析頁：`buildPnlModel`、`setDashboardPage`、`setPnlRange`、`pnl*` 系列
- 有多條 500–900 字元長行（L155、L1255、L1828 附近）。`Edit` 比對失敗時改用短而獨特的錨點字串。

## worker/src/index.js（約 1150 行）

- L1–68：常數（`STATE_KEY`、`OKX_API`、`DEFAULT_CFG`、`STRATEGY_SIDES`、`CORS_HEADERS`）
- `handleRequest`（L70 起）HTTP API：
  - GET `/`（健康）、`/state`、`/prices`、`/snapshot`
  - POST `/start`、`/stop`、`/reset`、`/config`、`/scan`、`/tick`、`/notify/test`
- `runPaperTick`（cron 主流程）→ `scanSignals` → `openNewPositions` / `updatePositions`
- 掃描預算邏輯：`scanUniverse`、`rankedInstruments`、`anomalyScore`、`buildTickerSnapshot`、`rotatingSlice`（anomaly-first，每次掃描 K-line 上限 28 次、候選上限 20、核心標的每 30 分鐘輪掃）
- 狀態：`loadState`/`saveState`/`normalizeState`/`applyConfig`（KV）
- 通知：`notifyNewPosition` → Queue（`queuePositionNotification`）；`handleNotificationQueue`/`handleNotificationDeadLetters`；KV pending 是 fallback（`flushPendingNotifications`）
- 策略（雙實作區）：`evaluateSignal`、`buildRisk`⋯（見上表）

## 硬性外部約束（違反＝無聲翻車，數字以 README 為準）

1. **KV 寫入預算**：free plan。cron 每天 288 次、每次約 2 writes（lock+state；有新開倉通知時另 +1 次 NOTIFICATION_STATUS_KEY）≈ 576/日，只剩約 424/日給手動操作。→ 預設不在 tick 路徑新增 KV write；使用者要求的功能必須加時，先算出「每日 +N writes」寫進回覆並取得使用者同意。
   **「動到 tick/掃描/KV 路徑」的機械判準**：你的 diff 是否改變了每次 tick 的外部 fetch 次數或 KV write 次數？是 → 逐條核對本節；否（純計算邏輯、UI、文案）→ 不需。
2. **掃描預算**：每次掃描 K-line ≤ 28 次。→ 不要加不設上限的迴圈 fetch。
3. **Subrequest 上限**：通知走 Queue 就是為了避開掃描路徑的 subrequest 限制。→ 不要把通知改回掃描時同步直發。
4. **Worker 端禁用 Binance**（403）。瀏覽器端才能用 Binance。
5. **策略行為改動**（停損/停利/分批/開倉條件）屬於使用者的交易決策 → 除非使用者明確要求，不要「順手優化」。
