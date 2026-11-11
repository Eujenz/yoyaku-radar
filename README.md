# Yoyaku

公仔與動漫周邊的預購截止日提醒網站。全自動：GitHub Actions 每天兩次抓取官方資料、檢查、重建並部署到 GitHub Pages。沒有伺服器，只需要 Node 22；網頁字體子集化另需 Python 的 fonttools（`pip install fonttools brotli`），沒裝時本機建站會改用系統字體。

## 運作方式

| 步驟 | 檔案 | 說明 |
|---|---|---|
| 抓取 | `scraper/gsc.mjs` | 讀取 Good Smile Company 官網的預購清單與商品頁結構化資料，寫入 `data/items.json` |
| 檢查 | `scripts/check.mjs` | 資料或網站異常時中止部署（件數過少、欄位缺漏、壞連結、JSON 無效） |
| 產生 | `site/build.mjs` | 產生 `dist/`：頁面、Atom、iCalendar、JSON API、`llms.txt`、sitemap |
| 互動 | `site/app.js` | 收藏（我的展示櫃）、即時倒數、搜尋篩選排序，資料只存在訪客瀏覽器 |
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
| `AFFILIATE_ACTIVE` | 設為 `1` 後，頁尾顯示聯盟行銷揭露，店家連結加上 `sponsored` |
| `GOOGLE_SITE_VERIFICATION` | Google Search Console 驗證碼 |
| `INDEXNOW_KEY` | IndexNow 金鑰，設定後新頁面會自動通知 Bing 等搜尋引擎 |

## 資料來源原則

- 讀取官方公開的資料：名稱、作品、製造商、價格、JAN、規格、預購期間、圖片網址。
- 圖片不存進本 repo，由訪客瀏覽器直接向官方網站載入；商品介紹文字不轉載。每件商品都連回官方頁面。
- 抓取程式以 `YoyakuBot` 自我標示，請求間隔 1.2 秒，每個商品頁最多每兩天讀一次。
- 有機器人驗證（例如 Cloudflare challenge）的網站一律不收錄。

## 字體

使用 LINE Seed TW，並以 LINE Seed JP 補足日文漢字，兩者皆為 SIL OFL 1.1 授權（見 `fonts/OFL.txt`）。原始字體檔在 `fonts/`，每次建站由 `scripts/subset_fonts.py` 依網站實際用到的字切出子集，約 340 KB。

## 變現

導購連結集中在 `site/config.mjs` 的 `PARTNERS`。取得聯盟行銷帳號後，把該店家的網址換成追蹤連結，並設定 `AFFILIATE_ACTIVE=1`。
