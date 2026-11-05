# 🤖 旅途小幫手 AI 代理（Cloudflare Worker）

讓小幫手的「AI 回答」不用每台手機各貼一次 API key：key 放在 Cloudflare 的 Worker 裡，網頁只呼叫這支代理。預設問 **Gemini**（Google AI Studio 免費方案），也可加 Claude 當備援或主力。Cloudflare Workers 免費方案每天 10 萬次請求，綽綽有餘。

## 一次設定（約 10 分鐘，全部免費、不用信用卡）

1. **申請 Gemini key**：開 https://aistudio.google.com/apikey ，用 Google 帳號登入 → 「Create API key」→ 複製（以 `AIza` 開頭）。免費方案的對話內容 Google 可能用於改進產品；行程問答不含個資，可接受。
2. **建 Worker**：到 https://dash.cloudflare.com 註冊／登入 → 左側 **Compute (Workers)** → **Create** → **Start with Hello World!** → 名稱填 `oki-helper-ai` → **Deploy**。
3. **貼程式碼**：進入剛建好的 Worker → **Edit code** → 把編輯器裡的內容全部刪掉，貼上 [`ai-proxy.js`](ai-proxy.js) 的全部內容 → **Deploy**。
4. **放 key**：Worker → **Settings** → **Variables and Secrets** → **Add** → Type 選 **Secret**、Variable name 填 `GEMINI_KEY`、Value 貼上第 1 步的 key → **Deploy**。
5. **確認**：用瀏覽器打開 Worker 的網址（長得像 `https://oki-helper-ai.某某.workers.dev`），看到 `{"ok":true,"service":"oki-helper-ai","geminiKey":true,…}` 就成功了。
6. **寫進網頁**：把這個網址填到 `assets/data.js` 的 `CONFIG.ai.proxy`（記得同步 bump 版本號）並 push；之後所有人打開網頁就自動透過代理問 AI。臨時測試可在小幫手 ⚙️ 的「共用 AI 代理網址」貼上，只影響那一台裝置。

## 選用設定（Settings → Variables and Secrets）

| 變數 | 說明 |
|---|---|
| `PROVIDER` | `gemini`（預設）或 `anthropic` |
| `GEMINI_MODELS` | 依序嘗試的模型，預設 `gemini-3.8-flash,gemini-3.5-flash-lite`。免費額度是每個模型分開算，前者用完自動換後者；實際額度看 https://aistudio.google.com/rate-limit |
| `GEMINI_THINKING` | 強制思考深度 `minimal`／`low`／`medium`／`high`；預設 Flash 用 low、Flash-Lite 用 minimal（回得快） |
| `ANTHROPIC_KEY` | Secret。設了就能用 Claude：`PROVIDER=anthropic` 時主用，否則在 Gemini 額度用完時自動備援 |
| `ANTHROPIC_MODEL` | 預設 `claude-haiku-5-5`（最省；整趟旅程不到 NT$20） |
| `ALLOWED_ORIGINS` | 允許呼叫的網站，預設只有 `https://kenhuangads.github.io`；要在別的網域（例如 Artifact 版）用，把那個來源加進來（被拒時錯誤訊息會印出來源字串），`*` 代表全部允許 |
| `DAILY_LIMIT` | 每日總次數上限（預設 400）。要生效需綁 KV：**Storage & Databases → KV → Create** 建一個命名空間，再到 Worker → **Settings → Bindings → Add → KV namespace**，Variable name 填 `COUNTER`。沒綁就不計數 |

## 安全性

- key 只存在 Cloudflare Secrets，網頁與手機都看不到。
- 只回應來自允許網站的瀏覽器請求（Origin 檢查），其他網站無法嵌用。
- Gemini 免費方案沒有付費額度可被燒；若另外放 Anthropic key，請在 Anthropic Console 設每月花費上限當保險。

## 命令列部署（替代網頁後台）

```bash
cd worker
npx wrangler login
npx wrangler secret put GEMINI_KEY
npx wrangler deploy
```

本機測試：在 `worker/.dev.vars`（已 gitignore）放 `GEMINI_KEY=...` 與 `ALLOWED_ORIGINS=*`，執行 `npx wrangler dev --port 8787`，再把小幫手 ⚙️ 的代理網址設成 `http://localhost:8787`。
