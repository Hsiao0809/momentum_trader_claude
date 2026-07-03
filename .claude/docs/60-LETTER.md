# 60 — 給未來 session 的信

寫信人：Claude（Fable 5），2026-07-03，制度建立 session。你（讀者）大概率是 Sonnet 等級的模型，這封信講的是規則背後的東西——使用者沒問、但我認為對這個環境最重要的三件事，以及這套制度會怎麼爛掉。

## 三件使用者沒問、但你必須知道的事

### 1. 「merge 了」不等於「上線了」——這個 repo 的部署是手動的

Worker 每 5 分鐘在線上真實運行，但這個沙箱環境**沒有 Cloudflare 憑證**，你改的 code 要等使用者在自己機器上跑 `npm run deploy:all` 才生效（從 README 的 `cmd /c` 慣用法看，使用者在 Windows 上操作）。這有兩個後果：
- 每次交付改動時，回覆最後要提醒使用者「需要部署才生效」，並給確切指令（worker 改動：`npm run worker:deploy`；前端：`npm run deploy`；都改：`deploy:all`）。
- 線上行為可能落後 repo 好幾個版本。debug「線上怎麼跟 code 不一樣」時，第一個假設不是 bug，是**還沒部署**。可以 `curl https://momentum-trader-claude-runner.siaosiao1016.workers.dev/state` 觀察線上實際行為來比對。

### 2. KV 裡的 state 是唯一的交易歷史，把它當生產資料庫對待

紙上交易的所有紀錄（開倉、平倉、統計）只存在 Cloudflare KV 的一份 JSON 裡，沒有備份機制。因此：
- 改 state 結構（新增/改名欄位）＝資料遷移：worker 的 `normalizeState` 必須能吃舊格式，否則部署當下歷史就毀了（HTML 端**沒有** normalizeState，它經由 `applyServerState` 吃 worker 回傳的 state，相容性要另行確認）。改結構前先派 `second-opinion`。
- 永遠不要動 `STATE_KEY` 的值；永遠不要在未經使用者確認下呼叫線上 `/reset`。
- 幫使用者做任何「清理」前，先建議他 `curl .../state > backup.json` 留底。

### 3. 這套制度最值錢的下一步：消滅雙實作（但要使用者點頭）

所有制度裡最貴的規則就是「雙實作檢查」——它是在為架構債付利息。根治法是把策略純函式（`evaluateSignal`、`buildRisk`、stop/TP 系列）抽成單一共用模組，build 時內嵌進 HTML、worker 直接 import。做完後 PROJECT-MAP 的對照表和一半的檢查規則都可以刪掉。這是大重構，**必須使用者主動同意才做**（走 T3 模板＋先派 Plan）；但如果使用者哪天抱怨「又改漏一邊」，就是提這個提案的時機。

## 這套制度最可能的退化方式（與預防）

1. **儀式化**：照樣派 acceptor，但驗收條件寫成「確認改動正確」這種空話——流程都在跑，保護全消失。預防：驗收條件必須可機械判定（`40-TEMPLATES.md` 常見錯誤 2）；你看到空話驗收條件時，當場重寫它。
2. **逐步放寬**：「這次改動很小，跳過 verify 沒關係」→ 三個月後 verify 形同虛設。預防：任何放寬都是「先問使用者」級（`50-MAINTENANCE.md` §1）；「這次特殊」本身就是警訊。
3. **地圖漂移**：repo 演進、PROJECT-MAP 沒跟上，弱模型信了錯地圖比沒地圖更糟。預防：地圖與 grep 現實矛盾時，**永遠信現實**，並當場修地圖（這是可自行改的事實更新）；每季健檢抽查。
4. **規則膨脹**：每踩一坑加三條規則，CLAUDE.md 長到沒人讀完。預防：新教訓先進 LESSONS（四行格式），只有反覆踩的才升格成規則；CLAUDE.md 超過 60 行就要下放內容。

## 誠實條款（我這個等級也補不了的）

- **交易策略的品味**：參數好壞、訊號質量，任何模型（包括我）都不該替使用者拍板。能做的上限是：跑回測給數字、列選項講後果。制度裡所有「策略行為改動要問使用者」的規則，都源於此，不要當成官僚流程刪掉。
- **模糊需求**：拆解與驗證救不了「猜錯使用者要什麼」。收斂成具體選項去問（`30-JUDGMENT.md` §3）比多派三個 agent 便宜且準。
- 我沒能在本 session 查證的事：agent frontmatter 是否支援 effort 欄位（`20-DISPATCH.md` §0 已標註查證方法）；Cloudflare 各項配額的即時數字（以官方文件為準，README 數字是 2026-07 快照）。

## 交接：本 session 未完成事項

無。交付清單 A–G 全部落檔；fresh-context 對抗審查（Fable 等級）找出 7 項必修＋8 項建議修，**全部已修正**（含：TP1 常數錨點錯誤、優先序三處打架、非 trivial 無判準、verify.mjs 的 script regex 缺口）。若你讀到這行，制度已完整且經過一輪對抗驗證，直接照 CLAUDE.md 的最小流程工作即可。
