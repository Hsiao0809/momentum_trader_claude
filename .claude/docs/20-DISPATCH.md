# 20 — 模型調度守則（主對話 = 指揮官，不下場幹粗活）

> 目的：省 token、保持主對話聚焦、讓驗證獨立於執行。全部規則 Sonnet 等級即可執行。

## 0. 本環境實際可用的資源（先核對，不憑印象）

- **subagent 模型**（Agent 工具的 `model` 參數）：`haiku`、`sonnet`、`opus`、`fable`。
  ⚠️ `fable` 只在 2026-07 的制度建立 session 確認可用，之後未必；**每次以你自己 system prompt 裡 Agent 工具的 enum 為準**。若某型號呼叫被拒，降回下一級，不要重試同型號。
- **agent 類型**（system prompt 的 "Available agent types" 清單，可能隨版本變動）：
  - `Explore`：唯讀搜尋，適合大範圍掃 repo。
  - `Plan`：出實作計畫，不改檔。
  - `general-purpose` / `claude`：全工具，可改檔、上網。
  - `claude-code-guide`：查 Claude Code / API 本身的問題（如「frontmatter 支不支援某欄位」）。
  - 本 repo 自訂（`.claude/agents/`）：`acceptor`（sonnet，fresh-context 驗收）、`second-opinion`（opus，高風險方案審查）。
- **effort 參數**：本環境的 Agent 工具**沒有** effort 參數；effort 只能由 agent 定義檔控制，而 frontmatter 是否支援 effort 欄位未經查證。需要時派 `claude-code-guide` 查，**不要自己發明欄位名**。
- 內建 skill：交 PR 前可用 `/code-review`；動到安全敏感面用 `/security-review`。

## 1. 指揮官不下場：什麼一定要派出去

主對話（指揮官）只做：理解需求、拆任務、派工、整合結論、對使用者回報、小而精準的編輯。以下情況**一律派 subagent**，主對話只收結論：

| 情境 | 判準（達標就派） | 派給 |
|---|---|---|
| 掃 repo / 找用法 | 預估要開 >5 次搜尋，或要看 >3 個檔案才有答案 | `Explore`（在 prompt 內指定 breadth） |
| 大量讀取 | 需要讀超過 ~400 行才能回答 | `Explore` 或 `general-purpose` + `model: haiku` |
| 查網頁 / 外部文件 | 任何需要 WebSearch/WebFetch 的研究 | `general-purpose` + `model: sonnet` |
| 批次機械改檔 | 同一模式要套 >3 處/檔 | `general-purpose` + `model: haiku`（附已驗證的範例 diff） |
| 出實作計畫 | 改動跨兩檔以上或有架構取捨 | `Plan` |
| 驗收 | 任何非 trivial 改動完成後 | `acceptor` |
| 高風險方案 | 見 §5 | `second-opinion` |

反例（不要派）：改一行、讀一個已知位置的函式、跑一個指令——直接做，派工的開銷比省下的還多。

## 2. 派工三件套（缺一不發）

每個派工 prompt 必含三段（模板見 `40-TEMPLATES.md`）：

1. **目標與動機**：要什麼、為什麼要（讓 agent 能在細節上自行取捨）。
2. **驗收條件**：逐條、可機械判定（「grep 得到 X」「`npm run verify` 通過」「兩檔都改到」），不寫「品質要好」這種空話。
3. **回報格式**：明定結構與長度上限。

另外必附：相關檔案路徑、本 repo 的雷（至少提醒讀 `10-PROJECT-MAP.md` 的雙實作表與硬性約束）。subagent 是冷啟動，**你沒寫的它都不知道**。

## 3. 回報合約

- subagent 只回：結論、逐條驗收結果、`檔案:行號` 引用。
- 長產物（報告、大 diff、掃描清單）**落檔**到 `/tmp/claude-0/...scratchpad/`（暫用）或 `.claude/docs/`（要留的），回報只傳路徑 + 三行摘要。
- 禁止 subagent 把整段檔案內容貼回主對話。派工 prompt 裡要明寫這條。
- subagent 的回報使用者看不到；重要結論要由主對話用自己的話轉述給使用者。

## 4. 升降級路徑

- **haiku 錯一次** → 直接升 `sonnet` 重派，不給 haiku 第二次機會。
- **sonnet 在同一子任務連錯兩次** → 升 `opus` 重派，且 prompt 必須附完整失敗軌跡（兩次嘗試各做了什麼、錯誤訊息原文、已排除的假設），不是只說「前面失敗了」。
- **主對話自己（通常是 sonnet）卡住兩輪** → 同上邏輯：派 `opus` 的 `second-opinion` 或 `Plan` 求解，帶完整失敗軌跡。
- **降級**：一旦某個模式被解出並驗證（例如一種改法在一處通過驗收），把「已驗證的範例 + 逐步指令」交給 `haiku` 批次套用到其餘位置，再由 `acceptor` 整批驗收。
- **重試上限**：同一件事同一條路最多兩輪。第三輪前必須換路（換方案、換模型、或按 `30-JUDGMENT.md` 停下來問使用者）。「換個字重跑同樣的指令」不算換路。

## 5. 驗證不自驗

寫 code 的人不能當自己的驗收員（會沿用同一套錯誤假設）：

- **檔案落地** → `acceptor` read-back：讀回檔案原文核對，不看主對話的記憶。
- **程式碼行為** → `acceptor` 實跑：至少 `npm run verify`；有可實跑的入口（如 worker 的 `/tick`、HTML 的 `runBacktest`）就設法實跑或寫一次性 harness 跑該函式。
- **高風險判斷**（動策略邏輯、動 KV/掃描預算、資料格式遷移、任何不可逆操作）→ 動手**前**派 `second-opinion`；若問題是「多解擇優」型（例如兩種修法選一），可平行派兩個 subagent 各出一案，再派第三個唯讀 agent 評審選優。
- 驗收 FAIL → 回到執行者修，修完**再驗一次**；不可由執行者口頭聲明「已修好」結案。

## 6. 誠實條款（調度的極限）

- 派工、驗收、多樣本評審能補**執行品質**，補不了**模糊需求與品味判斷**。需求本身模糊時，先按 `30-JUDGMENT.md` §3 收斂選項問使用者，不要靠多派幾個 agent 硬猜。
- subagent 回報也可能錯。驗收條件寫得越可機械判定，回報越可信；「它說沒問題」不等於沒問題，關鍵改動要求它附證據（指令輸出、行號）。
