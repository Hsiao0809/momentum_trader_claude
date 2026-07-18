# LESSONS — 踩坑教訓（append-only，新條目在最上方；格式見 50-MAINTENANCE.md §2）

## 2026-07-12 回測 harness 的 simulateTrade 不吃 evaluateSignal 的 risk 修改
坑：用 --patch 改 evaluateSignal 裡的停損，回測結果與 baseline 一字不差，差點誤判「改動無效果」。
因：backtest-strategies.mjs 呼叫 simulateTrade 時只傳 strategyKey，simulateTrade 內部自己重算 buildRisk，並有第二份 vi 窄停損實作（HTML ~L1433）；evaluateSignal 的 stop 修改對回測不可見。
避：停損/停利類 patch 要打在 simulateTrade 的 risk 覆寫區（或 buildRisk 本體）；實作停損類改動時 HTML 要改 evaluateSignal + simulateTrade 兩處、worker 一處，共三處。

## 2026-07-12 分批掃描仍會改變開倉排序
坑：把 16 個掃描拆成每次 4 個後，每批就發布與開倉，前批候選會先占滿倉位，而且完整掃描週期拉長。
因：只拆 CPU 工作，沒有把「收集候選、完整排序、決策開倉」做成同一個具冪等性的 generation。
避：在 Durable Object 內累積完整 scan plan，16 個全成功後才發布；所有狀態異動由同一 coordinator 排隊並做版本檢查。

## 2026-07-03 長行讓 Edit 比對失敗
坑：momentum_trader_claude.html 有 500–900 字元長行（L155、L1255、L1828 附近），整行當 old_string 容易比對失敗。
因：長行內容微差（空白、引號）就整段不匹配。
避：old_string 取短而獨特的錨點片段；失敗兩次改用 python 按行號改。

## 2026-07-03 策略邏輯是雙實作
坑：HTML 與 worker 各有一份同名策略函式，資料源不同（Binance vs OKX），改一邊另一邊不會報錯。
因：獨立模式與 24/7 runner 是平行實作。
避：改策略先照 10-PROJECT-MAP 對照表在兩檔各 grep 一次。
