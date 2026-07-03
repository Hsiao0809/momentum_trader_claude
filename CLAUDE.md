# CLAUDE.md — momentum_trader_claude

加密貨幣動能「紙上交易」系統：`momentum_trader_claude.html`（dashboard，瀏覽器直連 Binance）+ `worker/src/index.js`（Cloudflare Worker，OKX，cron 每 5 分鐘**正在線上運行**）。沒有測試與 CI，語法閘門是 `npm run verify`。

## 優先序（全套制度唯一一張表，其他檔與此矛盾時以此為準）

**使用者當下明確指示 > 本檔硬規則 > `30-JUDGMENT` 判準 > `20-DISPATCH` 守則 > 省 token。**
但書：使用者指示若會破壞線上 runner 或毀掉 KV 交易紀錄（部署壞 code、`/reset`、改 state 結構不相容），先警告後果並取得再次確認才執行；使用者指示覆蓋制度規則時，照做並提醒一句「這與 X 檔規則不同，要順便更新規則嗎」。

**「非 trivial 改動」的判準**（多檔引用此定義）：動到策略/tick/掃描/KV 相關 code、或跨兩檔、或 diff >10 行——任一成立即非 trivial。

## 硬規則（除「使用者當下明確指示」外，無例外）

1. **動手前先讀 `.claude/docs/10-PROJECT-MAP.md`**。禁止對 `momentum_trader_claude.html` 或 `worker/src/index.js` 做無 offset 的整檔 Read（唯一例外：任務本身就是全檔重寫）；先 Grep 函式名，再 Read 該區段（±40 行）。
2. **雙實作檢查**：策略邏輯（`evaluateSignal`、`buildRisk`、停損/停利/分批等）在 HTML 與 worker 各有一份。改動前在兩檔各 grep 一次，回覆中明說「另一邊已同步改 / 不需改，因為＿＿」。對照表在 PROJECT-MAP。
3. **改完任何 code，宣告完成前必跑 `npm run verify`**，並貼結果。改到 tick/掃描/KV 路徑，另外照 PROJECT-MAP「硬性外部約束」逐條核對（KV 寫入預算、K-line ≤28、Queue、worker 禁 Binance）。
4. **不主動部署、不動策略參數**：`deploy`/`wrangler` 類指令與停損停利等交易規則，只有使用者明確要求才動。
5. **不直接 push `main`**：一律工作分支 + draft PR。
6. **改 `.claude/` 下任何檔案或 CLAUDE.md 前先備份**到 `.claude/backups/`（規則見 `50-MAINTENANCE.md`）。

## 路由（需要時才讀，不要一次全讀）

| 情境 | 讀 |
|---|---|
| 要找 code、了解結構、查指令/約束 | `.claude/docs/10-PROJECT-MAP.md` |
| 要派 subagent、選模型、驗收 | `.claude/docs/20-DISPATCH.md` |
| 不確定「算不算完成 / 該不該問 / 該不該換路 / 該不該升級模型」 | `.claude/docs/30-JUDGMENT.md` |
| 要寫派工 prompt | `.claude/docs/40-TEMPLATES.md`（複製填空） |
| 要更新這些制度檔、踩坑後記教訓 | `.claude/docs/50-MAINTENANCE.md` + `LESSONS.md` |
| session 開始、想知道環境背景與前人交接 | `.claude/docs/60-LETTER.md` |
| 想知道這些規則的依據 | `.claude/docs/00-DIAGNOSIS.md` |

## 每次 session 的最小流程

1. 讀本檔（自動）→ 有實作任務就讀 PROJECT-MAP → 查 `LESSONS.md` 有沒有相關舊坑。
2. 做事：grep-first、大掃描派 subagent（見 DISPATCH）。
3. 收尾：`npm run verify` → 依 JUDGMENT 的完成定義自查 → 非 trivial 改動派 fresh-context 驗收 → 踩到新坑寫進 `LESSONS.md`。
