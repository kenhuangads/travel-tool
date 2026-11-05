/* ============================================================
   🤖 旅途小幫手 AI 代理（Cloudflare Worker）  worker/ai-proxy.js
   網頁（assets/helper.js）把「系統提示＋清單資料＋當天行程＋對話」POST 到這裡，
   這裡用放在 Cloudflare 的 API key 轉問 Gemini（預設）或 Claude，再把回答傳回去。
   家人的手機不必設定任何 key；key 只存在 Cloudflare 的 Secrets。

   部署步驟見 worker/README.md。環境變數（Worker → Settings → Variables and Secrets）：
     GEMINI_KEY        Secret・必要：Google AI Studio 的 API key（免費方案即可）
     ANTHROPIC_KEY     Secret・選填：設了就能用 Claude——PROVIDER=anthropic 時主用，否則當 Gemini 失敗時的備援
     PROVIDER          gemini（預設）｜anthropic
     GEMINI_MODELS     逗號分隔、依序嘗試；預設 gemini-3.8-flash,gemini-3.5-flash-lite（前者免費額度用完就自動換後者）
     GEMINI_THINKING   選填：強制思考深度（minimal／low／medium／high）；留空字串＝不送
     ANTHROPIC_MODEL   預設 claude-haiku-5-5
     ALLOWED_ORIGINS   允許的網頁來源，逗號分隔；預設 https://kenhuangads.github.io；填 * 允許全部
     DAILY_LIMIT       每日總次數上限，預設 400（要綁 KV 命名空間 COUNTER 才會計數；沒綁就不限）
   ============================================================ */

const DEFAULTS = {
  PROVIDER: 'gemini',
  GEMINI_MODELS: 'gemini-3.8-flash,gemini-3.5-flash-lite',
  ANTHROPIC_MODEL: 'claude-haiku-5-5',
  ALLOWED_ORIGINS: 'https://kenhuangads.github.io',
  DAILY_LIMIT: '400'
};
const cfg = (env, k) => (env[k] != null && String(env[k]).trim() !== '' ? String(env[k]).trim() : DEFAULTS[k]);
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = originAllowed(origin, cfg(env, 'ALLOWED_ORIGINS'));
    const cors = corsHeaders(allowed ? origin : '');
    if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (req.method === 'GET') {
      const provider = cfg(env, 'PROVIDER');
      return json({
        ok: true, service: 'oki-helper-ai', provider,
        models: provider === 'anthropic' ? [cfg(env, 'ANTHROPIC_MODEL')] : list(cfg(env, 'GEMINI_MODELS')),
        geminiKey: !!env.GEMINI_KEY, anthropicKey: !!env.ANTHROPIC_KEY, dailyCounter: !!env.COUNTER,
        allowedOrigins: cfg(env, 'ALLOWED_ORIGINS')
      }, 200, cors);
    }
    if (req.method !== 'POST') return json({ ok: false, error: '只接受 POST' }, 405, cors);
    if (origin && !allowed) return json({ ok: false, error: `這個網頁來源不在允許名單：${origin}（到 Worker 的 ALLOWED_ORIGINS 加上它）` }, 403, cors);

    let body;
    try { body = await req.json(); } catch (e) { return json({ ok: false, error: '請求不是 JSON' }, 400, cors); }
    const sys = (Array.isArray(body.system) ? body.system : [body.system]).map(s => String(s || '')).filter(Boolean);
    const msgs = foldMessages(Array.isArray(body.messages) ? body.messages : []);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return json({ ok: false, error: '缺少問題' }, 400, cors);
    if (sys.join('').length > 400000 || msgs.some(m => m.content.length > 8000)) return json({ ok: false, error: '內容太長' }, 413, cors);

    const limitMsg = await checkDaily(env);
    if (limitMsg) return json({ ok: false, error: limitMsg }, 429, cors);

    const primary = cfg(env, 'PROVIDER') === 'anthropic' && env.ANTHROPIC_KEY ? 'anthropic' : 'gemini';
    const tried = [];   // 中途失敗的嘗試（模型：原因）——回給網頁當備註，也印到 Cloudflare 的即時記錄
    let r = primary === 'gemini' ? await askGemini(env, sys, msgs, tried) : await askAnthropic(env, sys, msgs, tried);
    if (!r.ok && r.retryable) {   // 主要供應商額度用完／當機 → 換另一個（有 key 才會）
      if (primary === 'gemini' && env.ANTHROPIC_KEY) r = await askAnthropic(env, sys, msgs, tried);
      else if (primary === 'anthropic' && env.GEMINI_KEY) r = await askGemini(env, sys, msgs, tried);
    }
    if (tried.length) console.log('[oki-helper-ai] fallback:', tried.join(' | '), '→', r.ok ? r.model : 'FAILED');
    if (r.ok) return json({ ok: true, text: r.text, provider: r.provider, model: r.model, note: tried.length ? `（${tried.join('；')}，改用 ${r.model}）` : '' }, 200, cors);
    return json({ ok: false, error: r.error }, r.status || 502, cors);
  }
};

/* ---------- 共用 ---------- */
function originAllowed(origin, allowedList) {
  const allowed = list(allowedList);
  if (allowed.includes('*')) return true;
  if (!origin) return true;                       // 非瀏覽器（沒有 Origin）——例如用網址列直接開 GET 檢查
  return allowed.some(a => a.replace(/\/+$/, '').toLowerCase() === origin.toLowerCase());
}
function corsHeaders(origin) {
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (origin) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
/* 對話歷史：只留 user／assistant 文字，同角色連續合併、必須以 user 開頭（兩家 API 都要求交替） */
function foldMessages(raw) {
  const out = [];
  raw.forEach(m => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return;
    const c = m.content.trim(); if (!c) return;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += '\n' + c;
    else out.push({ role: m.role, content: c });
  });
  while (out.length && out[0].role !== 'user') out.shift();
  return out.slice(-12);
}
async function checkDaily(env) {
  if (!env.COUNTER) return '';
  const limit = parseInt(cfg(env, 'DAILY_LIMIT'), 10) || 0;
  if (!limit) return '';
  const key = 'd:' + new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 以日本時間計日
  try {
    const n = parseInt(await env.COUNTER.get(key), 10) || 0;
    if (n >= limit) return `今天的小幫手 AI 次數已達上限（${limit} 次），先用內建回答，明天再試`;
    await env.COUNTER.put(key, String(n + 1), { expirationTtl: 172800 });
  } catch (e) { /* KV 暫時故障不擋人 */ }
  return '';
}

/* ---------- Gemini（generateContent） ---------- */
function thinkingLevel(env, model) {
  if (env.GEMINI_THINKING != null) return String(env.GEMINI_THINKING).trim().toLowerCase();   // 空字串＝不送
  if (!/^gemini-3/.test(model)) return '';
  return /lite/.test(model) ? 'minimal' : 'low';
}
async function askGemini(env, sys, msgs, tried) {
  if (!env.GEMINI_KEY) return { ok: false, error: 'Worker 還沒設定 GEMINI_KEY', status: 500 };
  const models = list(cfg(env, 'GEMINI_MODELS'));
  const base = {
    systemInstruction: { parts: [{ text: sys.join('\n\n') }] },
    contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
  };
  let last = null;
  for (const model of models) {
    let gc = { maxOutputTokens: 2000 };
    const lvl = thinkingLevel(env, model);
    if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
    for (let attempt = 0; attempt < 2; attempt++) {
      let r, j;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
          body: JSON.stringify({ ...base, generationConfig: gc })
        });
        j = await r.json().catch(() => ({}));
      } catch (e) { last = { ok: false, error: '連不上 Gemini：' + (e && e.message || ''), retryable: true, status: 502 }; break; }
      if (!r.ok) {
        const msg = (j.error && (j.error.message || j.error.status)) || `HTTP ${r.status}`;
        if (r.status === 400 && gc.thinkingConfig && /think/i.test(msg) && attempt === 0) { gc = { maxOutputTokens: gc.maxOutputTokens }; continue; }   // 這個模型不吃 thinkingLevel → 不送再試一次
        const keyBad = r.status === 400 && /api key/i.test(msg) || r.status === 403;
        const retryable = r.status === 429 || r.status === 404 || r.status >= 500;
        last = { ok: false, error: `Gemini（${model}）${r.status === 429 ? '額度用完或太頻繁' : keyBad ? 'API key 無效' : '錯誤 ' + r.status}：${String(msg).slice(0, 160)}`, retryable, status: r.status === 429 ? 429 : keyBad ? 500 : 502 };
        break;
      }
      if (j.promptFeedback && j.promptFeedback.blockReason) return { ok: false, error: `Gemini 拒絕回答（${j.promptFeedback.blockReason}）`, status: 422 };
      const c = (j.candidates || [])[0];
      const text = c && c.content && Array.isArray(c.content.parts) ? c.content.parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim() : '';
      if (text) return { ok: true, text, provider: 'gemini', model };
      last = { ok: false, error: `Gemini（${model}）沒有回文字（${(c && c.finishReason) || '沒有候選回答'}）`, retryable: true, status: 502 };
      break;
    }
    if (last && !last.retryable) return last;
    if (last && tried) tried.push(last.error.replace(/：.*$/, ''));
  }
  return last || { ok: false, error: '沒有設定任何 Gemini 模型', status: 500 };
}

/* ---------- Claude（Messages API） ---------- */
async function askAnthropic(env, sys, msgs, tried) {
  if (!env.ANTHROPIC_KEY) return { ok: false, error: 'Worker 還沒設定 ANTHROPIC_KEY', status: 500 };
  const model = cfg(env, 'ANTHROPIC_MODEL');
  let longest = 0; sys.forEach((t, i) => { if (t.length > sys[longest].length) longest = i; });
  const system = sys.map((t, i) => (i === longest && sys.length > 1 ? { type: 'text', text: t, cache_control: { type: 'ephemeral' } } : { type: 'text', text: t }));
  const body = { model, max_tokens: 1200, system, messages: msgs.map(m => ({ role: m.role, content: m.content })), output_config: { effort: 'low' } };
  const headers = { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2026-10-21' };
  if (/^claude-(opus|sonnet)-5/.test(model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
  let r, j;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    j = await r.json().catch(() => ({}));
  } catch (e) { return { ok: false, error: '連不上 Anthropic：' + (e && e.message || ''), retryable: true, status: 502 }; }
  if (!r.ok) {
    const msg = (j.error && j.error.message) || `HTTP ${r.status}`;
    const retryable = r.status === 429 || r.status === 529 || r.status >= 500;
    const err = { ok: false, error: `Claude（${model}）${r.status === 401 ? 'API key 無效' : r.status === 429 ? '請求太頻繁或額度用完' : '錯誤 ' + r.status}：${String(msg).slice(0, 160)}`, retryable, status: r.status === 429 ? 429 : r.status === 401 ? 500 : 502 };
    if (retryable && tried) tried.push(err.error.replace(/：.*$/, ''));
    return err;
  }
  if (j.stop_reason === 'refusal') return { ok: false, error: 'Claude 拒絕回答這個問題', status: 422 };
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return text ? { ok: true, text, provider: 'anthropic', model } : { ok: false, error: 'Claude 回了空白', retryable: true, status: 502 };
}
