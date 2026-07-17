# 10 — 專案地圖（動手前先讀這份，不要盲掃檔案）

> 行號是 2026-07-03 的快照，**會漂移**。定位一律以 `Grep` 函式名為準，行號只當粗略導航。

## 這是什麼系統

加密貨幣動能策略「紙上交易」系統，兩個執行面：

| 面 | 檔案 | 資料源 | 執行方式 |
|---|---|---|---|
| Dashboard（UI + 獨立模式） | `momentum_trader_claude.html` | Binance Futures（瀏覽器直連） | 使用者開網頁 |
| 24/7 Runner | `worker/src/index.js` | OKX + Gate + XYZ 永續（Binance 擋 Workers，403） | Cloudflare cron → Durable Object，每 5 分鐘 |

- 部署：Cloudflare Pages（前端）+ Cloudflare Workers（runner）。Runner 線上網址：`https://momentum-trader-claude-runner.siaosiao1016.workers.dev`
- 狀態由 SQLite Durable Object `PaperCoordinator` 單一寫入；首次自 `PAPER_STATE` KV 相容遷移。開倉通知走 Cloudflare Queue `momentum-trader-notifications`（+ DLQ）。
- **這個 worker 是正在線上運行的真實系統**。改壞了不是測試掛掉，是使用者的紙上交易停擺或行為錯亂。

## 指令表

| 指令 | 作用 |
|---|---|
| `npm run verify` | 語法閘門：worker + HTML 內嵌 JS 的 `node --check` + build。**改完 code 必跑** |
| `npm run build` | 把兩個 html 複製到 `dist/` |
| `npm run dev` | build + `wrangler pages dev dist`（本地預覽，沙箱內通常不需要） |
| `npm run deploy` / `worker:deploy` / `deploy:all` | 部署（**需要 Cloudflare 憑證，模型不要主動執行**，交給使用者） |
| `npm run worker:tail` | 看線上 worker log（需憑證） |
| `node scripts/fetch-okx-candles.mjs [days] [universe]` | 抓 OKX 真實 K 線到 `scripts/.cache/`（不進 git），供回測用 |
| `node scripts/backtest-strategies.mjs [--patch OLD NEW]` | 對 `momentum_trader_claude.html` 的真實策略邏輯跑回測；用法見 `.claude/docs/70-STRATEGY-PLAYBOOK.md` |

沒有測試、沒有 linter。邏輯正確性靠 `.claude/docs/30-JUDGMENT.md` 的檢查表與 fresh-context 驗收。

## ⚠️ 雙實作對照表（本 repo 第一大坑）

以下函式在 **兩個檔案各有一份**，同名不同源（HTML 吃 Binance K 線格式、worker 吃正規化後的 OKX/Gate K 線）。改策略邏輯時，先在兩檔各 grep 一次，決定改一邊還是兩邊，並在回覆中明說理由：

`evaluateSignal`、`scanSignals`、`buildRisk`、`effectiveStopFor`、`stopReasonFor`、`stopAtBarOpen`、`positionSize`、`closePosition`、`takeBreakEvenPartial`、`takeTP1`、`updatePositions`、`atrPct`、`btcRiskOff`、`strategyKey`、`sideForStrategy`、`closedKlines`、`rangePosition`、`kHigh`/`kLow`/`kClose`/`kVol`/`kTime`、`ema`/`mean`/`median`、`pct`/`safeDiv`/`clamp`

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
  - 渲染：`refreshMarks`、`drawSpark`、`metric`、`statsFromTrades`、`buildPositionActivity`（倉位活動紀錄；舊交易由 entry / partialExits / close 重建）
  - PnL 分析頁：`buildPnlModel`、`setDashboardPage`、`setPnlRange`、`pnl*` 系列
- 有多條 500–900 字元長行（L155、L1255、L1828 附近）。`Edit` 比對失敗時改用短而獨特的錨點字串。

## worker/src/index.js（約 1150 行）

- L1–70：常數（`STATE_KEY`、`OKX_API`、`GATE_API`、`DEFAULT_CFG`、`STRATEGY_SIDES`、`CORS_HEADERS`）
- `handleRequest`（L70 起）HTTP API：
  - GET `/`（健康）、`/state`、`/prices`、`/snapshot`
  - POST `/start`、`/stop`、`/reset`、`/config`、`/scan`、`/tick`、`/notify/test`
- `PaperCoordinator.runTick`（cron 主流程）→ `updatePositions` → `createScanPlan` / `scanSignalPlanBatch` → `finalizeScanPlan` → `latestEntryPrices` / `openNewPositions`
- 掃描預算邏輯：`scanUniverse`、`rankedInstruments`、`normalizeOkxTickers`、`normalizeGateTickers`、`deriveGateVolumeRatio`、`anomalyScore`、`buildTickerSnapshot`、`rotatingSlice`（OKX 優先、Gate-only 補充；完整 scan plan 必須正好 16 個 K-line、XYZ 保留 4 個；16/16 全成功後才發布並排序）
- 狀態：`PaperCoordinator` 的 `storedState`/`saveStoredState`/`runControl` + `normalizeState`/`applyConfig`；所有控制與 tick 共用 `enqueue`，外部提交帶 `stateVersion`；完整 state 以 1.5MB UTF-8 chunks 儲存，避免單 row 2MB 上限；每筆 position 的 `events` 完整保留；持倉 K 線會以 `positionKlinesAfter` 驗證 `lastTime` 後的連續性，超過 300 根時由 `marketKlinesFrom` 每次補一個錨定 chunk，缺口未補齊期間寫入 `position_history_gap` 並暫停新開倉
- 通知：`notifyNewPosition` → Queue（`queuePositionNotification`）；`handleNotificationQueue`/`handleNotificationDeadLetters`；KV pending 是 fallback（`flushPendingNotifications`）
- 策略（雙實作區）：`evaluateSignal`、`buildRisk`⋯（見上表）

## 硬性外部約束（違反＝無聲翻車，數字以 README 為準）

1. **免費儲存預算**：正常一個 state chunk 約 576 Durable Object row writes/日（chunk + metadata），五 chunks 約 1,728/日，遠低於 100,000/日；KV 不再有 cron lock/state write，只保留舊狀態相容讀取與通知狀態。→ tick 路徑新增持久化時仍須先計算每日用量。
   **「動到 tick/掃描/KV 路徑」的機械判準**：你的 diff 是否改變了每次 tick 的外部 fetch 次數或 KV write 次數？是 → 逐條核對本節；否（純計算邏輯、UI、文案）→ 不需。
2. **掃描與 subrequest 預算**：完整 scan plan ≤ 16 個 K-line；含 8 個持倉、三市場 universe、BTC 情境和最多 16 個最新成交價時，掃描 tick 最壞約 44 個外部 subrequests，低於 Free 50。持倉 K-line 正常抓 8 根，落後時同一個 subrequest 動態擴大到最多 300 根；超過 300 根也只在每次 tick 抓一個錨定 chunk，不能在單次 invocation 內迴圈補完。→ 不要加不設上限的迴圈 fetch。
3. **Subrequest 上限**：通知走 Queue 就是為了避開掃描路徑的 subrequest 限制。→ 不要把通知改回掃描時同步直發。
4. **Worker 端禁用 Binance**（403）。Worker 使用 OKX + Gate，瀏覽器獨立模式才能用 Binance。
5. **策略行為改動**（停損/停利/分批/開倉條件）屬於使用者的交易決策 → 除非使用者明確要求，不要「順手優化」。
