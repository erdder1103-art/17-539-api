Phase 2.5 Railway Volume 持久化版

這版用途：
1. 將 tracking / result / learning / TG 設定 改為優先寫入 Railway Volume
2. 若 Railway Volume 尚未掛載，會自動 fallback 到專案本地 data/
3. 若第一次切到 Volume，且 Volume 目前為空，會自動把專案內 data/ 的既有檔案複製到 Volume

建議 Railway 設定：
- 建立一個 Volume 並掛載到 /data
- 不需要額外改程式碼
- 若想自訂掛載路徑，可設定環境變數 DATA_DIR=/你的掛載路徑

啟動後檢查：
- 打開 /api/health
- 會看到 storage.dataDir
- 若 volumeMounted=true 且 dataDir=/data，表示已經走 Volume

這版資料會保留：
- tracking.json
- tracking_history.json
- result_history.json
- result_state.json
- learning_state.json
- weekly_stats.json
- bot_config.json
