這是以 lottery_system_v2 為基礎的自動追蹤兌獎版。

新增功能：
1. API 更新後自動核對 539 / 天天樂最新一期
2. Telegram 自動發送開獎核對結果
3. 自動累積本周統計
4. 新增 API：
   GET /api/weekly/539
   GET /api/weekly/ttl
   GET /api/history/539
   GET /api/history/ttl
   GET /api/health

目前兌獎判定：
- 任一主組命中 3+ 顆：恭喜過關
- 全車號碼命中 3+ 顆：靠3.3倍
- 主組或全車命中 2 顆：再接再厲
- 其餘：沒過
