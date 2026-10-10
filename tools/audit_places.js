/* 地點資料複核工具（出發前再跑一次）：node tools/audit_places.js [--refresh] [--only s01,f17]
 *
 * 逐一以 Google 地圖搜尋端點的第一筆結果，比對 assets/data.js 裡的
 *   ① 座標（偏差 > 60 m 列出）② Google place id（links.gpid 是否仍指向同一家）
 *   ③ 歇業狀態（閉業／臨時休業）④ 每週營業時間與公休（和 META 的 open／close／closedDow 差 30 分以上列出）
 * 只列出「有出入」的項目；全部一致就只印總結。結果僅供人工判讀——Google 的營業時間偶爾有誤，
 * 請再以官網或店家社群確認後才改 data.js。
 *
 * 低頻率逐筆查詢（每筆間隔約 2 秒）、回應快取在 tools/.cache/（已 gitignore）；--refresh 會重抓。
 * 2026/10/5 首次全面校正：101 個地點中 98 個座標偏差 > 40 m（最大 5 km），已全數修正。 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const only = (() => { const i = args.indexOf('--only'); return i >= 0 ? new Set(args[i + 1].split(',')) : null; })();
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

const src = fs.readFileSync(path.join(ROOT, 'assets/data.js'), 'utf8');
const D = vm.runInContext(src + '\n;({CONFIG,SPOTS,FOODS,META,STORES,HOTELS,ANCHORS,ANCHOR_META})', vm.createContext({ console }));

/* 查詢字覆寫：店名單獨搜不到、或刻意改指「實際下車點」的地點 */
const QUERY = {
  s04: '古宇利ふれあい広場', s05: '三重城港 待合室 那覇', s07: '首里城公園 首里杜館 那覇市首里金城町',
  s08: '壺屋やちむん通り 那覇市壺屋 壺屋焼物博物館', s11: '万座毛周辺活性化施設', s12: '残波岬灯台',
  s13: 'デポアイランド 北谷町美浜', s14: '国際通り屋台村 牧志', s15: '識名園', s21: '南城市地域物産館',
  f02: '首里そば 那覇市首里赤田町1-7', f05: '浜屋 そば 北谷町宮城2-99', f06: '焼肉もとぶ牧場 那覇店 久茂地',
  f09: 'しゃぶしゃぶ我那覇 那覇市前島', f12: 'ちぬまん 国際通り牧志店 那覇市牧志1丁目2-26', f14: '花笠食堂 那覇市牧志3丁目',
  f18: 'やっぱりステーキ 3rd がじゅまる店', f27: 'ブルーシール 国際通り店 那覇市牧志1丁目',
  f75: 'キングタコス 金武本店 沖縄県国頭郡金武町金武4244-4', f81: '焼肉もとぶ牧場 国際通り店 松尾',
  'st:dfs': 'Tギャラリア 沖縄 by DFS 那覇市おもろまち4丁目', 'st:suisavon': 'SuiSavon 首里石鹸 国際通り松尾',
  'st:kokusai_st': 'むつみ橋交差点 那覇', 'an:kokusai': 'むつみ橋交差点 那覇', 'h:loisir': 'Loisir Hotel Naha'
};
const SKIP = new Set(['st:cvs']);            // 泛稱超商不核
const NO_PID_CHECK = new Set(['s21']);       // 座標刻意指向售票處（物產館），place id 仍是齋場御嶽本體

const places = [];
D.SPOTS.concat(D.FOODS).forEach(it => { const m = D.META[it.id] || {}; places.push({ key: it.id, name: it.name, links: it.links || {}, lat: m.lat, lng: m.lng, meta: m }); });
Object.entries(D.STORES).forEach(([k, s]) => places.push({ key: 'st:' + k, name: s.name, links: s.links || {}, lat: s.lat, lng: s.lng, meta: s }));
Object.entries(D.HOTELS).forEach(([k, h]) => places.push({ key: 'h:' + k, name: h.name, links: h.links || {}, lat: h.lat, lng: h.lng, meta: {} }));
Object.entries(D.ANCHORS).forEach(([k, a]) => { const m = D.ANCHOR_META[k] || {}; places.push({ key: 'an:' + k, name: a.name, links: a.links || {}, lat: m.lat, lng: m.lng, meta: {} }); });

const hav = (a, b) => { const d = Math.PI / 180, R = 6371000; const s = Math.sin((b.lat - a.lat) * d / 2) ** 2 + Math.cos(a.lat * d) * Math.cos(b.lat * d) * Math.sin((b.lng - a.lng) * d / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(s)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* feature id（0x…:0x…）→ place id（ChIJ…）：place id 是兩個 64-bit 小端整數的 protobuf base64url */
function fidToPid(fid) {
  const m = /^0x([0-9a-f]+):0x([0-9a-f]+)$/i.exec(fid || ''); if (!m || /^0+$/.test(m[1])) return '';
  const le = h => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt('0x' + h)); return b; };
  return Buffer.concat([Buffer.from([0x0a, 0x12, 0x09]), le(m[1]), Buffer.from([0x11]), le(m[2])])
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function parse(text) {
  let j; try { j = JSON.parse(text.replace(/^\)\]\}'\s*/, '')); } catch (e) { return null; }
  const list = j[0] && Array.isArray(j[0][1]) ? j[0][1] : [];
  const p = (list.find(e => e && e[14] && e[14][9]) || [])[14];
  if (p) {
    const hrs = p[203] && p[203][0] ? p[203][0].map(d => d && d[0] ? d[0] + (d[3] ? ' ' + d[3].map(x => x && x[0]).join('/') : '') : '').filter(Boolean) : [];
    return { name: p[11], addr: p[39] || '', lat: p[9][2], lng: p[9][3], tel: p[178] && p[178][0] ? p[178][0][0] : '', status: (p[88] && p[88][0]) || '', pid: p[78] || '', hrs };
  }
  const g = j[37] && j[37][2] && j[37][2][0];   // 單一地理編碼格式
  if (g && g[3] && typeof g[3][2] === 'number') return { name: '(geocode) ' + (j[37][1] || ''), addr: j[37][1] || '', lat: g[3][2], lng: g[3][3], tel: '', status: '', pid: fidToPid(g[2]), hrs: [] };
  return null;
}
const toMin = s => { const m = String(s).match(/(\d{1,2})時(\d{2})分/); return m ? +m[1] * 60 + +m[2] : null; };
function week(hrs) {
  const DOW = { '日曜日': 0, '月曜日': 1, '火曜日': 2, '水曜日': 3, '木曜日': 4, '金曜日': 5, '土曜日': 6 };
  const days = {};
  hrs.forEach(h => {
    const [d, ...r] = h.split(' '); const rest = r.join(' ');
    if (DOW[d] == null) return;
    if (/定休日|休業/.test(rest)) { days[DOW[d]] = 'closed'; return; }
    if (/24 ?時間/.test(rest)) { days[DOW[d]] = [0, 1440]; return; }
    const parts = rest.split('/').map(p => { const [a, b] = p.split('～'); const o = toMin(a || ''); let c = toMin(b || ''); if (o != null && c != null && c <= o) c += 1440; return [o, c]; }).filter(x => x[0] != null && x[1] != null);
    if (parts.length) days[DOW[d]] = [Math.min(...parts.map(x => x[0])), Math.max(...parts.map(x => x[1]))];
  });
  return days;
}
const fm = x => x == null ? '--' : String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0');

(async () => {
  const issues = [];
  let n = 0;
  for (const p of places) {
    if (SKIP.has(p.key) || (only && !only.has(p.key))) continue;
    const q = QUERY[p.key] || p.links.g || p.name;
    const cf = path.join(CACHE, p.key.replace(':', '_') + '.txt'), qf = cf + '.q';
    let text;
    if (!REFRESH && fs.existsSync(cf) && fs.existsSync(qf) && fs.readFileSync(qf, 'utf8') === q) text = fs.readFileSync(cf, 'utf8');
    else {
      const r = await fetch('https://www.google.com/search?tbm=map&hl=ja&gl=jp&q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, 'Accept-Language': 'ja' } });
      if (r.status !== 200) { issues.push(`${p.key}\t${p.name}\tHTTP ${r.status}（被限流就晚點再跑）`); await sleep(5000); continue; }
      text = await r.text(); fs.writeFileSync(cf, text); fs.writeFileSync(qf, q);
      await sleep(1800 + Math.random() * 900);
    }
    n++;
    const g = parse(text);
    if (!g) { issues.push(`${p.key}\t${p.name}\t查無結果（查詢字：${q}）`); continue; }
    const out = [];
    const dist = Math.round(hav(p, g));
    if (dist > 60) out.push(`座標偏 ${dist} m → Google ${g.lat.toFixed(5)},${g.lng.toFixed(5)}`);
    if (!NO_PID_CHECK.has(p.key) && p.links.gpid && g.pid && p.links.gpid !== g.pid) out.push(`place id 不同（data ${p.links.gpid} ／ Google ${g.pid}「${g.name}」）`);
    if (/閉業|休業/.test(g.status)) out.push(`⚠️ Google 標示：${g.status}`);
    const days = week(g.hrs);
    if (Object.keys(days).length >= 5) {
      const m = p.meta || {};
      const opens = Object.values(days).filter(x => x !== 'closed');
      const gOpen = opens.length ? Math.min(...opens.map(x => x[0])) : null, gClose = opens.length ? Math.max(...opens.map(x => x[1])) : null;
      const gClosed = Object.entries(days).filter(([, v]) => v === 'closed').map(([k]) => +k).sort();
      const mClosed = (m.closedDow || []).slice().sort();
      if (m.open != null && gOpen != null && Math.abs(m.open - gOpen) > 30) out.push(`開門 data ${fm(m.open)}／Google ${fm(gOpen)}`);
      if (m.close != null && gClose != null && Math.abs(Math.min(m.close, 1440) - Math.min(gClose, 1440)) > 30) out.push(`打烊 data ${fm(m.close)}／Google ${fm(gClose)}`);
      if (JSON.stringify(gClosed) !== JSON.stringify(mClosed)) out.push(`公休 data [${mClosed}]／Google [${gClosed}]（0=週日）`);
    }
    if (out.length) issues.push(`${p.key}\t${p.name.slice(0, 20)}\t${out.join('；')}`);
  }
  console.log(`已複核 ${n} 個地點（data.js 版本 ${D.CONFIG.build}）；有出入 ${issues.length} 筆${issues.length ? '：' : '，全部一致 ✅'}`);
  if (issues.length) console.log(issues.join('\n'));
})();
