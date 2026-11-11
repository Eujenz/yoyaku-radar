# 預購雷達 (Yoyaku Radar)

公仔與動漫周邊的預購截止日提醒網站。全自動：GitHub Actions 每天兩次抓取官方資料、檢查、重建並部署到 GitHub Pages。沒有伺服器，沒有相依套件（只需要 Node 22）。

## 運作方式

| 步驟 | 檔案 | 說明 |
|---|---|---|
| 抓取 | `scraper/gsc.mjs` | 讀取 Good Smile Company 官網的預購清單與商品頁結構化資料，寫入 `data/items.json` |
| 檢查 | `scripts/check.mjs` | 資料或網站異常時中止部署（件數過少、欄位缺漏、壞連結、JSON 無效） |
| 產生 | `site/build.mjs` | 產生 `dist/`：頁面、Atom、iCalendar、JSON API、`llms.txt`、sitemap |
| 排程 | `.github/workflows/update.yml` | 每天 09:17 與 19:17（日本時間）執行，失敗時自動開 issue |

```bash
npm run scrape   # 抓資料（每秒不到 1 次請求，首次約 8 分鐘）
npm run build    # 產生 dist/
npm run check    # 檢查資料與網站
npm run serve    # 本機預覽
```

## 設定

在 GitHub 的 Settings → Secrets and variables → Actions → Variables 設定，全部都是選填：

| 變數 | 用途 |
|---|---|
| `SITE_URL` | 正式網址，未設定時使用 GitHub Pages 預設網址 |
| `SITE_NAME` | 網站名稱 |
| `CONTACT_EMAIL` | 顯示在「關於」頁的聯絡信箱 |
| `THREADS_URL` | Threads 帳號網址 |
| `NEWSLETTER_FORM_ACTION` | 電子報訂閱表單的送出網址 |
| `GOOGLE_SITE_VERIFICATION` | Google Search Console 驗證碼 |
| `INDEXNOW_KEY` | IndexNow 金鑰，設定後新頁面會自動通知 Bing 等搜尋引擎 |

## 資料來源原則

- 只讀取官方公開的事實資料：名稱、作品、製造商、價格、JAN、規格、預購期間。
- 不複製圖片與商品介紹文字，每件商品都連回官方頁面。
- 抓取程式以 `YoyakuRadarBot` 自我標示，請求間隔 1.2 秒，每個商品頁最多每兩天讀一次。
- 有機器人驗證（例如 Cloudflare challenge）的網站一律不收錄。
