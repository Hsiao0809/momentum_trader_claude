# LESSONS — 踩坑教訓（append-only，新條目在最上方；格式見 50-MAINTENANCE.md §2）

## 2026-07-03 長行讓 Edit 比對失敗
坑：momentum_trader_claude.html 有 500–900 字元長行（L155、L1255、L1828 附近），整行當 old_string 容易比對失敗。
因：長行內容微差（空白、引號）就整段不匹配。
避：old_string 取短而獨特的錨點片段；失敗兩次改用 python 按行號改。

## 2026-07-03 策略邏輯是雙實作
坑：HTML 與 worker 各有一份同名策略函式，資料源不同（Binance vs OKX），改一邊另一邊不會報錯。
因：獨立模式與 24/7 runner 是平行實作。
避：改策略先照 10-PROJECT-MAP 對照表在兩檔各 grep 一次。
