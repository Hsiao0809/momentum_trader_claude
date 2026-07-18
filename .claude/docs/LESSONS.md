# LESSONS — 踩坑教訓（append-only，新條目在最上方；格式見 50-MAINTENANCE.md §2）

## 2026-07-18 不可回測的機制至少要做實盤窗口重放
坑：提案「trail/lock 獲利出場後同標的冷卻 12h」（防 AKE 追高回入），harness 測不了（候選生成已含 24h 全出場冷卻）就以「依型態判斷」直接實作進 PR；使用者一句「為什麼 12h」逼出重放驗算——同窗口它會殺掉 US +32.9 與 AKE +21.8 兩筆連環贏單，只擋掉一筆 -11.9，淨 -42.8，且那筆輸單本來就被延伸罰分擋住（誤區 D 重疊）。已撤。
因：動能策略的獲利有一塊來自連續騎同一隻強勢幣，一刀切冷卻正砍在獲利來源；「不可回測」被當成「免驗證」。
避：harness 測不了的機制，最低標準是拿實盤窗口把「會被擋掉的所有單」列出來算淨效果（贏家和輸家都要算），並檢查同批改動是否已有機制覆蓋同一案例。

## 2026-07-18 backtest harness 抽取清單會漂移
坑：跑 backtest-strategies.mjs 直接 ReferenceError: stopAtBarOpen is not defined——HTML 後來新增的函式沒進 harness 的抽取 names 清單。
因：harness 用 new Function() 抽取固定名單的函式，HTML 新增依賴時名單不會自動更新。
避：harness 掛掉先看是不是 names 清單缺函式（本次補了 stopAtBarOpen/effectiveStopFor/stopReasonFor）；改 simulateTrade/updatePositions 依賴鏈時順手檢查名單。

## 2026-07-18 「保守恢復」直覺被回測推翻
坑：直覺提案「連損暫停恢復後提高 paperMinScore +10 直到出現真獲利」，聽起來穩健；回測消融顯示大幅有害（PnL 288→124、勝率 52→43）。
因：實盤 148 筆已證明分數對勝率無鑑別力（96-100 分桶反而是最差的一桶），拉高分數門檻不是提質是砍量，且會鎖死在保守模式（低分單被擋→沒有機會出現獲利單來解鎖）。
避：任何「用分數當品質開關」的機制先跑回測；風控要用倉位/暫停等資金面手段，不要用分數面手段。

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
