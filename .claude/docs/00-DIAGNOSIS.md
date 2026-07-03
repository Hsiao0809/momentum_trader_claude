# 00 — Harness 診斷：本環境最大的三個弱點與修法

> 寫於 2026-07-03（Fable 5 制度建立 session）。本檔是其他所有 `.claude/docs/` 檔案的依據。
> 讀者：未來在此 repo 工作的任何 Claude session（預設假定是 Sonnet 等級）。

## 弱點 1（最容易出錯）：交易邏輯雙實作，改一邊忘一邊

**事實**：策略邏輯在兩個檔案各有一份獨立實作，函式同名但內容不完全相同：

- `momentum_trader_claude.html`（瀏覽器端，資料源 **Binance** Futures API）
- `worker/src/index.js`（Cloudflare Worker 端，資料源 **OKX** swap API——因為 Binance 對 Workers 回 403）

兩邊都有：`evaluateSignal`、`buildRisk`、`effectiveStopFor`、`stopReasonFor`、`closePosition`、`takeBreakEvenPartial`、`takeTP1`、`positionSize`、`atrPct`、`btcRiskOff`、`scanSignals`、`strategyKey`、`sideForStrategy` 等。

**失效模式**：使用者說「把停損改成 X」，模型只改了 HTML（或只改了 worker），兩邊行為分岔。dashboard 顯示的規則和實際 24/7 跑的規則不同，**且不會有任何錯誤訊息**。這是本 repo 最危險、最無聲的 bug 來源。

**修法（已制度化）**：
1. 任何動到上列函式或策略參數的改動，**必須先用 grep 在兩個檔案各查一次同名函式**，再決定要改一邊還是兩邊，並在回覆裡明說「worker 已同步改 / 不需改，因為＿＿」。
2. 完成定義（見 `30-JUDGMENT.md`）把「雙邊檢查」列為策略類改動的必要驗收項。
3. `10-PROJECT-MAP.md` 有雙實作對照表，動手前先讀。

## 弱點 2（最漏 token）：105KB 單檔巨石 + 每個 session 從零重建認知

**事實**：`momentum_trader_claude.html` 約 2000 行、105KB，含多條 500–900 字元的長行；本 repo 在本次之前**沒有 CLAUDE.md**，每個 session 都要重新讀 README、掃檔案、重推導部署方式與外部約束。

**失效模式**：
- 整檔 Read 進主對話 → 一次吃掉大量 context；改兩次又讀一次，主對話很快脹滿、開始失焦。
- 長行讓 `Edit` 的 old_string 精確比對容易失敗 → 模型重讀整檔重試 → 惡性循環。
- 每 session 重新推導「怎麼 build、怎麼 deploy、為什麼用 OKX」，重複燒掉數千 token 還可能推錯。

**修法（已制度化）**：
1. `CLAUDE.md`（每 session 自動載入）+ `10-PROJECT-MAP.md`（函式索引、雙實作表、指令表）。動手前查地圖，不要盲掃。
2. **grep-first 紀律**：找東西一律先 `Grep` 函式名/字串，再用 `Read` 帶 offset/limit 只讀該區段（±40 行）。禁止無 offset 整檔 Read 這兩個大檔，除非任務本身就是全檔重寫。
3. 大範圍掃描（「找出所有用到 X 的地方」「整理整個檔案的結構」）派 `Explore` subagent，主對話只收結論與 `檔案:行號`。見 `20-DISPATCH.md`。
4. `Edit` 失敗一次，就改用「更短、含獨特錨點字串」的 old_string 重試；失敗兩次改用 Bash 的 python/sed 針對行號改，不要反覆整檔重讀。

## 弱點 3（最容易失焦＋無聲翻車）：沒有任何驗證閘門，而部署目標是正在運行的真實系統

**事實**：repo 沒有測試、沒有 linter、沒有 CI。但 worker 每 5 分鐘被 cron 實際執行，且有硬性外部預算（皆出自 README，改預算相關邏輯前先重讀 README 核對）：

- Cloudflare KV free plan 寫入預算：288 次排程/日 ≈ 576 writes/日（lock+state），手動操作只剩約 424 writes/日。
- 每次掃描 K-line 請求上限 28 次、異常候選上限 20 個；核心高流動性標的每 30 分鐘才輪掃一次。
- Worker 的外部 subrequest 有平台上限（通知因此走 Queue 而非掃描時直接發送）。
- Binance Futures API 在 Workers 上會 403，**worker 端永遠不要改回 Binance**。

**失效模式**：模型改完 code、語法都沒驗就宣告完成；或在 tick 路徑里多加一個 `saveState`/多打幾次 API，語法全對、邏輯看似合理，部署後幾小時內把每日預算燒光，交易停擺。

**修法（已制度化）**：
1. 新增 `npm run verify`（`scripts/verify.mjs`）：worker 語法檢查 + HTML 內嵌 JS 語法檢查 + build 可跑。**任何 code 改動後、宣告完成前必跑**。這只擋語法層錯誤，擋不住邏輯錯，所以還有 2、3。
2. 資源預算檢查表（見 `30-JUDGMENT.md`）：凡改動 `runPaperTick`/`scanSignals`/`scanUniverse`/`saveState` 呼叫路徑，必須數「這個改動讓每次 tick 多幾次 KV write、幾次外部 fetch」，寫進回覆。
3. 驗收派 fresh-context agent 用測資實跑或 read-back，不自驗。見 `20-DISPATCH.md`。

## 次要弱點（一句話帶過，修法已併入上面各檔）

- **README 是唯一文件且混雜使用者指南與開發約束** → 約束已抽進 CLAUDE.md/PROJECT-MAP，README 維持給人看。
- **`main` 沒有分支保護、模型可直接 push** → 制度規定：一律開分支 + draft PR，不直接 push main（見 CLAUDE.md）。
- **HTML 內嵌中文 UI 文案（UTF-8）** → 用 Bash/sed 處理時注意編碼；優先用 Edit 工具。

## 本 harness 的極限（誠實條款）

以下問題**制度補不了**，遇到就照指示做，不要硬撐：

- **策略品味問題**（「這個停損策略好不好」「參數該調多少」）：這是交易判斷，不是工程判斷。任何模型都不該自行拍板——提供分析與選項，讓使用者決定；涉及回測就實跑 `runBacktest` 給數字，不憑感覺。
- **模糊需求**（「讓它更好用」）：先照 `30-JUDGMENT.md` 的「該問使用者」判準收斂成 2–4 個具體選項再問，不要猜完直接做大改。
- **即時市場/交易所 API 規格變動**：訓練資料會過時。懷疑 API 行為時，實際 curl 一次或查官方文件，查不到就明說不確定。
