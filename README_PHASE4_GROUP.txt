Phase 4 群組互動版

本版新增：
1. Telegram 群組互動輪詢（getUpdates）
2. 支援群組文字問答：
   - 這組會不會過？
   - 539 這組會不會過？
   - 天天樂這組穩不穩？
   - 追蹤清單
   - 學習狀態
   - 最近結果
   - 同步正常嗎？
   - /start /help
3. 回覆會直接發回原群組並引用原訊息
4. /api/health 與 /api/bot/runtime 可查看 bot polling 狀態

注意：
- BOT 必須先加入群組並關閉隱私模式（BotFather -> /setprivacy -> Disable），否則群組內一般文字可能收不到。
- 若同一支 bot 之前有 webhook，請先刪除 webhook 後再用 polling。
