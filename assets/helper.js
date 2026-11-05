/* ============================================================
   🤖 旅途小幫手（assets/helper.js）
   用文字或語音提問，直接以「行程＋清單資料」就地回答：
   附近替代餐廳／現在有開的店／今天行程與下一站／怎麼去／營業時間／
   推薦點法／地址電話下車點／回飯店叫車／單軌票券／雨天備案…
   內建規則引擎離線可用（不需 API）；另可在 ⚙️ 貼上自己的 Claude API key，
   聽不懂的問題改交給 Claude（帶著整份清單與今天行程當上下文）。
   依賴 app.js 暴露的 window.OKI 介面。
   ============================================================ */
(function () {
  'use strict';
  const K = window.OKI;
  if (!K) return;
  const { esc, fmtT, durTxt, kmTxt, money } = K;
  const $ = s => document.querySelector(s);

  /* ---------- 旅程日期／時間 ---------- */
  const TRIP = [
    { idx: 0, y: 2027, m: 1, d: 20, dow: 3, label: '1/20（三）Day 1' },
    { idx: 1, y: 2027, m: 1, d: 21, dow: 4, label: '1/21（四）Day 2' },
    { idx: 2, y: 2027, m: 1, d: 22, dow: 5, label: '1/22（五）Day 3' },
    { idx: 3, y: 2027, m: 1, d: 23, dow: 6, label: '1/23（六）Day 4' },
    { idx: 4, y: 2027, m: 1, d: 24, dow: 0, label: '1/24（日）Day 5' }
  ];
  const nowMin = () => { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); };
  const autoDay = () => { const n = new Date(); return TRIP.findIndex(t => t.y === n.getFullYear() && t.m === n.getMonth() + 1 && t.d === n.getDate()); };
  const inTrip = () => autoDay() >= 0;
  let pickedDay = +(localStorage.getItem('oki_helper_day') || 0);
  const dayIdx = () => { const a = autoDay(); return a >= 0 ? a : pickedDay; };
  const dayInfo = i => TRIP[Math.max(0, Math.min(4, i))];

  /* ---------- 文字正規化與地點比對 ---------- */
  const z2h = s => String(s || '').replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
  const norm = s => z2h(s).toLowerCase().replace(/\s+/g, '').replace(/[のノ]/g, '之');
  const STOP = new Set(['那霸', '那覇', '沖繩', '沖縄', '國際通', '国際通り', '本店', '那霸店', '那覇店', '國際通店', '名護', '讀谷', '北谷', '恩納', '南城', '糸滿', '浦添', '本部', '今歸仁', '牧志', '松尾', '久茂地', '店', '沖繩麵', '沖縄そば', '美食', '景點', '餐廳', '咖啡', '天婦羅', '阿古豬', '燒肉', '海鮮', '市場', '公園', '世界遺產', '城跡', '食堂', '飯店', '度假村', '燒肉', '焼肉', '居酒屋', '咖啡廳', 'カフェ', '甜點', '牧場']);
  // 候選地點：景點／美食／商品（帶門市）／門市／飯店
  const PLACES = [];
  K.ALL.forEach(it => PLACES.push(it));
  Object.entries(STORES).forEach(([k, s]) => PLACES.push({ id: 'st:' + k, kind: 'store', name: s.name, jp: (s.links || {}).g || '', lat: s.lat, lng: s.lng, zone: s.zone, links: s.links || {}, open: s.open, close: s.close, closedDow: s.closedDow, stay: s.stay, note: s.note }));
  K.HOTEL_LIST.forEach(h => PLACES.push(h));
  const variantsOf = it => {
    const out = new Set();
    const push = v => { v = norm(v); if (v.length >= 2 && !STOP.has(v) && !STOP.has(z2h(v))) out.add(v); };
    [it.name, it.jp, (it.links || {}).g, it.short].forEach(v => { if (v) push(v); });
    const seg = v => { push(v); const nv = norm(v); STOP.forEach(w => { const nw = norm(w); if (nv.length > nw.length + 1) { if (nv.startsWith(nw)) push(nv.slice(nw.length)); if (nv.endsWith(nw)) push(nv.slice(0, -nw.length)); } }); };
    [it.name, it.jp].forEach(s => String(s || '').split(/[（）()・／\/「」【】・、,，\s]+/).forEach(seg));
    return [...out];
  };
  const VARS = PLACES.map(it => ({ it, vs: variantsOf(it) }));
  const vCount = {};
  VARS.forEach(x => x.vs.forEach(v => { vCount[v] = (vCount[v] || 0) + 1; }));
  const ALIAS = { '美麗海': 's01', '水族館': 's01', '首里城': 's07', '傑克': 'f17', 'jack': 'f17', 'a&w': 'f19', 'aw': 'f19', '屋台村': 's14', '萬座毛': 's11', '美國村': 's13', '古宇利': 's04', '賞鯨': 's05', '鯨魚': 's05', '瀨長島': 's09', '唐吉訶德': 'st:donki', '唐吉': 'st:donki', '公設市場': 'st:makishi_mkt', '牧志市場': 'st:makishi_mkt', '齋場御嶽': 's21', 'jungl': 's16', '叢林': 's16', '鳳梨園': 's17', '美術館': 's27', '博物館': 's27' };
  function findPlace(q) {
    const nq = norm(q);
    let best = null, bestLen = 0;
    Object.entries(ALIAS).forEach(([a, id]) => {
      if (nq.includes(norm(a)) && a.length > bestLen) { const it = PLACES.find(p => p.id === id); if (it) { best = it; bestLen = a.length; } }
    });
    VARS.forEach(({ it, vs }) => vs.forEach(v => {
      if (vCount[v] > 3) return;                 // 太常見的片段（如「國際通」）不當店名
      if (v.length > bestLen && nq.includes(v)) { best = it; bestLen = v.length; }
    }));
    return best;
  }
  const hotelPos = () => { const h = K.hotelInfo(); return { lat: h.lat, lng: h.lng, name: h.name, zone: h.zone, id: 'hotel' }; };
  const posOf = it => it ? { lat: it.lat, lng: it.lng, name: it.name, zone: it.zone, id: it.id } : null;

  /* ---------- 營業狀態 ---------- */
  function openStatus(it, di, atMin) {
    const day = dayInfo(di);
    const o = it;
    if (o.closedDow && o.closedDow.indexOf(day.dow) >= 0) return { closed: true, txt: `週${K.DOW_TXT[day.dow]}公休`, cls: 'bad' };
    if (o.closedDates && o.closedDates.indexOf(`1/${day.d}`) >= 0) return { closed: true, txt: `${day.label.slice(0, 4)} 公休`, cls: 'bad' };
    const hrs = (o.open != null || o.close != null) ? `${o.open != null ? fmtT(o.open) : '?'}-${o.close != null ? fmtT(Math.min(o.close, 1439)) : '?'}` : '';
    if (atMin == null) return { closed: false, txt: hrs ? `營業 ${hrs}` : '營業時間以店頭為準', cls: '' };
    if (o.open != null && atMin < o.open) return { closed: false, soon: true, soonMin: o.open - atMin, txt: `${fmtT(o.open)} 才開門`, cls: 'warn' };
    if (o.close != null && atMin > o.close - 30) return { closed: true, txt: o.close <= atMin ? `已打烊（${fmtT(Math.min(o.close, 1439))} 關）` : `快打烊（${fmtT(o.close)} 關）`, cls: atMin >= o.close ? 'bad' : 'warn' };
    return { closed: false, txt: `營業中${hrs ? '（' + hrs + '）' : ''}`, cls: 'ok' };
  }

  /* ---------- 行程讀取 ---------- */
  const plan = () => K.plan();
  function dayStops(di) {
    const p = plan(); if (!p || !p.days[di]) return [];
    const out = [];
    p.days[di].tl.forEach((r, i) => {
      if (r.k === 'item' && r.cell && r.cell.item) out.push({ t: r.t, end: r.end, it: r.cell.item, slot: r.slotKey, suggest: !!r.cell.suggest, row: r });
      else if (r.k === 'item' && r.cell && r.cell.anchor) out.push({ t: r.t, end: r.end, anchor: r.cell.anchor, slot: r.slotKey, row: r });
      else if (r.k === 'store') out.push({ t: r.t, end: r.end, store: r.g.store, storeId: r.g.storeId, row: r });
      else if (r.k === 'd5shop') out.push({ t: r.t, end: r.end, d5shop: true, row: r });
      else if (r.k === 'fixed') out.push({ t: typeof r.t === 'string' ? toMin(r.t) : r.t, fixed: r.text.replace(/<[^>]*>/g, ''), sub: r.sub, row: r });
      else if (r.k === 'hotel') out.push({ t: r.t, hotel: true, pickup: r.pickup, row: r });
    });
    return out;
  }
  const toMin = s => { const m = /(\d{1,2}):(\d{2})/.exec(s); return m ? +m[1] * 60 + +m[2] : 0; };
  const stopName = s => s.it ? s.it.name : s.anchor ? s.anchor.name : s.store ? s.store.name : s.d5shop ? '國際通最終採購' : s.fixed ? s.fixed : s.hotel ? (s.pickup ? '回飯店領行李' : '回到飯店') : '';
  const MEAL_OF_SLOT = { brunch: 'brunch', d5brunch: 'brunch', lunch: 'lunch', latelunch: 'lunch', d5lunch: 'lunch', cafe: 'cafe', pmcafe: 'cafe', sweet: 'cafe', dinner: 'dinner', d1dinner: 'dinner', night: 'supper', d1night: 'supper' };
  function mealStop(di, meal) {
    const stops = dayStops(di).filter(s => s.it && s.it.kind === 'food');
    return stops.find(s => MEAL_OF_SLOT[s.slot] === meal) || null;
  }
  function currentStop(di) {
    const now = nowMin();
    const stops = dayStops(di).filter(s => s.it || s.store || s.anchor);
    return stops.find(s => s.end != null && now <= s.end && now >= s.t - 20) || stops.find(s => s.t >= now) || stops[stops.length - 1] || null;
  }

  /* ---------- 意圖解析 ---------- */
  const MEAL_WORDS = [[/早午餐|brunch/i, 'brunch'], [/早餐|早上吃|morning/i, 'brunch'], [/午餐|中餐|中午|lunch/i, 'lunch'], [/晚餐|晚上吃|dinner/i, 'dinner'], [/宵夜|消夜|深夜/i, 'supper'], [/下午茶|咖啡|甜點|冰|蛋糕|鬆餅|cafe|coffee/i, 'cafe']];
  const CAT_WORDS = [[/沖繩麵|沖縄そば|そば|蕎麥|麵/i, 'soba'], [/燒肉|烤肉|和牛|牛肉|燒烤/i, 'yakiniku'], [/阿古|豬|涮涮|火鍋|しゃぶ/i, 'agu'], [/海鮮|魚|刺身|生魚片|丼|天婦羅|蝦/i, 'seafood'], [/牛排|steak|洋食/i, 'steak'], [/漢堡|美式|塔可|taco|burger/i, 'burger'], [/海景咖啡|咖啡|cafe|coffee/i, 'cafe'], [/早餐|輕食|飯糰|三明治/i, 'brunch'], [/甜點|冰淇淋|冰|鬆餅|蛋糕|塔/i, 'dessert'], [/拉麵|ramen|關東煮/i, 'ramen'], [/居酒屋|食堂|定食|沖繩料理|三線|民謠|酒/i, 'izakaya']];
  const SLOT_FIT = { brunch: ['brunch'], lunch: ['lunch', 'meal'], dinner: ['dinner', 'meal', 'supper'], supper: ['supper', 'dinner'], cafe: ['cafe', 'dessert'] };
  function parseDay(q) {
    const di = dayIdx();
    if (/今天|今日|today/i.test(q)) return di;
    if (/明天|明日|tomorrow/i.test(q)) return Math.min(4, di + 1);
    if (/後天/.test(q)) return Math.min(4, di + 2);
    let m = /day\s*([1-5])/i.exec(q) || /第\s*([一二三四五1-5])\s*天/.exec(q);
    if (m) return '一二三四五'.indexOf(m[1]) >= 0 ? '一二三四五'.indexOf(m[1]) : +m[1] - 1;
    m = /(週|星期|禮拜)([一二三四五六日天])/.exec(q);
    if (m) { const dow = '日一二三四五六'.indexOf(m[2] === '天' ? '日' : m[2]); const t = TRIP.find(x => x.dow === dow); if (t) return t.idx; }
    m = /1\s*[\/／]\s*(2[0-4])/.exec(q);
    if (m) return +m[1] - 20;
    return null;
  }
  function parse(q) {
    const nq = norm(q);
    const place = findPlace(q);
    const meal = (MEAL_WORDS.find(([re]) => re.test(q)) || [])[1] || null;
    const cat = (CAT_WORDS.find(([re]) => re.test(q)) || [])[1] || null;
    const day = parseDay(q);
    const wantsNow = /現在|此刻|馬上|立刻|等一下|現在有開|有開/.test(q);
    const useGeo = /我的位置|我這裡|我這邊|這附近|附近|周邊|離我|目前位置|這裡/.test(q);
    const t = (res) => Object.assign({ q, place, meal, cat, day, wantsNow, useGeo }, res);
    if (!nq) return t({ intent: 'help' });
    if (/^(help|幫助|說明|你會什麼|可以問什麼|怎麼用|能做什麼)/.test(nq)) return t({ intent: 'help' });
    if (/謝謝|感謝|thank/i.test(nq)) return t({ intent: 'thanks' });
    const nearbyRe = /附近|周邊|旁邊|鄰近|最近的|走路|其他|其它|別家|替代|換一家|換個|換別|排隊|太久|人太多|客滿|沒位|沒開|關門|公休|休息|推薦|有什麼|有哪些|哪裡吃|哪裡有|哪裡可以|還有|選擇|備案/;
    const spotRe = /景點|逛|玩|散步|走走|看海|公園|遺產|室內|雨天/;
    if (/雨|下雨|雨天/.test(q) && !place) return t({ intent: 'rain' });
    if (/單軌|ゆいレール|yui|交通卡|okica|suica|一日券|儲值|感應|票券|票/i.test(q) && !/門票|入場/.test(q)) return t({ intent: 'metro' });
    if (/包車|司機|接送|超時/.test(q)) return t({ intent: 'charter' });
    if (/天氣|氣溫|溫度|幾度|冷|穿什麼|穿搭|衣服/.test(q)) return t({ intent: 'weather' });
    if (/航班|飛機|班機|起飛|報到|登機|回程|去程/.test(q)) return t({ intent: 'flight' });
    if (/花費|預算|多少錢|費用|總共/.test(q) && !place) return t({ intent: 'budget' });
    if (/回飯店|回旅館|飯店在哪|飯店地址|飯店怎麼/.test(q)) return t({ intent: 'hotel' });
    if (place && /訂位|預約|訂桌|訂得到|要訂/.test(q)) return t({ intent: 'reserve' });
    if (place && /點什麼|點餐|必點|招牌|怎麼點|菜單|套餐|推薦吃|吃什麼|點法/.test(q)) return t({ intent: 'order' });
    if (place && /地址|住址|電話|聯絡|下車|停車|集合|在哪|位置/.test(q)) return t({ intent: 'info' });
    if (place && /怎麼去|怎麼走|怎麼到|如何去|路線|搭什麼|交通|多遠|多久|車程|叫車|uber|導航|去的話/i.test(q)) return t({ intent: 'route' });
    if (place && /有開|開門|打烊|關門|營業|幾點開|幾點關|公休|休息|開到|開嗎|有沒有開/.test(q) && !nearbyRe.test(q.replace(/有開|沒開|關門|公休|休息/g, ''))) return t({ intent: 'hours' });
    if (nearbyRe.test(q) || meal || cat || spotRe.test(q)) return t({ intent: 'nearby', kind: spotRe.test(q) && !meal && !cat ? 'spot' : 'food' });
    if (/下一站|接下來|等一下去|再來|然後/.test(q)) return t({ intent: 'next' });
    if (/行程|安排|幾點|時間表|今天|明天|後天|day\s*\d|第.天|整天|晚上去|早上去|下午去|整個/i.test(q)) return t({ intent: 'plan' });
    if (place) return t({ intent: 'info' });
    return t({ intent: 'search' });
  }

  /* ---------- 工具：距離／交通描述 ---------- */
  function transFrom(from, to) {
    try { return K.transCalc(from, to, false); } catch (e) { return null; }
  }
  const transShort = tr => tr ? (tr.mode === 'walk' ? `🚶 步行約${tr.mins}分` : tr.mode === 'metro' ? `🚝 單軌約${tr.mins}分` : `🚕 計程車約${tr.mins}分（${K.cabInfo().cabs}台約${money(tr.fare2)}）`) : '';

  /* ---------- 卡片 ---------- */
  function placeCard(it, extra, act) {
    const ci = K.catInfo(it) || {};
    const price = it.price ? `<div class="hp-meta">💰 ${esc(it.price)}</div>` : '';
    const wait = it.wait ? `<div class="hp-meta sub">⏱ ${esc(it.wait)}</div>` : '';
    const order = it.order ? K.orderHtml(it) : '';
    return `<div class="hp-card">
      <div class="hp-name">${ci.icon || ''} ${esc(it.name)}${it.jp && it.jp !== it.name ? ` <small>${esc(it.jp)}</small>` : ''}</div>
      ${extra || ''}${price}${wait}${order}
      ${K.linkRow(it.links, K.imgQ(it), K.posOfItem(it))}
      ${act ? `<div class="hp-act">${act}</div>` : ''}
    </div>`;
  }

  /* ---------- 各意圖的回答 ---------- */
  function answerNearby(p, geo) {
    const di = p.day != null ? p.day : dayIdx();
    const pl = plan();
    let anchor = null, anchorStop = null, why = '';
    if (p.place && p.place.kind !== 'shop') { anchor = posOf(p.place); why = `以「${p.place.name}」為中心`; anchorStop = dayStops(di).find(s => s.it && s.it.id === p.place.id) || null; }
    if (!anchor && geo) { anchor = { lat: geo.lat, lng: geo.lng, name: '你的位置' }; why = '以你目前的位置為中心'; }
    if (!anchor && pl && p.meal) { anchorStop = mealStop(di, p.meal); if (anchorStop) { anchor = posOf(anchorStop.it); why = `以 Day ${di + 1} ${K.SLOT_LABELS[anchorStop.slot] || ''}「${anchorStop.it.name}」為中心`; } }
    if (!anchor && pl) { const cs = currentStop(di); if (cs && (cs.it || cs.store)) { anchor = cs.it ? posOf(cs.it) : { lat: cs.store.lat, lng: cs.store.lng, name: cs.store.name, zone: cs.store.zone }; anchorStop = cs.it ? cs : null; why = `以 Day ${di + 1} 行程中的「${stopName(cs)}」為中心`; } }
    if (!anchor) { anchor = hotelPos(); why = `以飯店「${K.hotelInfo().name}」為中心`; }
    const kind = p.kind || 'food';
    const excl = new Set([anchor.id, anchorStop && anchorStop.it && anchorStop.it.id, p.place && p.place.id].filter(Boolean));
    const inPlan = new Set(dayStops(di).filter(s => s.it).map(s => s.it.id));
    const liveNow = p.wantsNow && inTrip();
    const atMin = liveNow ? nowMin() : anchorStop ? anchorStop.t : null;
    let cands = K.ALL.filter(it => it.kind === kind && !excl.has(it.id));
    if (kind === 'food') {
      if (p.cat) cands = cands.filter(it => it.cat === p.cat);
      if (p.meal && SLOT_FIT[p.meal]) cands = cands.filter(it => SLOT_FIT[p.meal].indexOf(it.slot) >= 0 || (p.cat && it.cat === p.cat));
    }
    cands = cands.map(it => ({ it, km: K.havKm(anchor, it), st: openStatus(it, di, atMin) }))
      .filter(x => !(x.st.closed && atMin != null) && !(x.st.closed && x.st.txt.includes('公休')) && !(x.st.soon && x.st.soonMin > 60))
      .sort((a, b) => a.km - b.km);
    const top = cands.slice(0, 5);
    const label = kind === 'spot' ? '景點' : (p.meal ? ({ brunch: '早餐', lunch: '午餐', dinner: '晚餐', supper: '宵夜', cafe: '咖啡甜點' })[p.meal] : '餐廳');
    if (!top.length) return `<p>${esc(why)}，清單裡找不到符合條件、${liveNow ? '現在有開' : '當時有營業'}的${label}。試試放寬條件，例如「附近有什麼吃的」。</p>`;
    const slotLbl = anchorStop && MEAL_OF_SLOT[anchorStop.slot] ? (K.SLOT_LABELS[anchorStop.slot] || '') : '';
    const planned = anchorStop && anchorStop.it && anchorStop.it.kind === kind ? `<p>Day ${di + 1} ${esc(slotLbl)}原本安排的是 <b>${fmtT(anchorStop.t)} ${esc(anchorStop.it.name)}</b>${anchorStop.it.wait ? `（${esc(anchorStop.it.wait)}）` : ''}。</p>` : '';
    const filt = liveNow ? `只列現在 ${fmtT(nowMin())} 有開或一小時內開門的` : atMin != null ? `Day ${di + 1} ${fmtT(atMin)} 前後有營業的` : `Day ${di + 1} 有營業的`;
    const head = planned + `<p><b>${esc(why)}</b>，清單內最近的${label}（${filt}）：</p>`;
    const cards = top.map(({ it, km, st }) => {
      const tr = transFrom(anchor, it);
      const extra = `<div class="hp-meta"><b>📏 ${kmTxt(km)}</b>　${esc(transShort(tr))}</div><div class="hp-meta sub"><span class="hp-st ${st.cls}">${esc(st.txt)}</span>${inPlan.has(it.id) ? '　<span class="hp-st">已在今天行程</span>' : ''}</div>`;
      let act = '';
      if (pl && anchorStop && anchorStop.it && anchorStop.it.kind === kind) act += `<button class="hp-btn go" data-hswap="${esc(anchorStop.it.id)}|${esc(it.id)}|${di}|${esc(anchorStop.slot || '')}">🔁 換掉「${esc(anchorStop.it.name.slice(0, 10))}」改去這家</button>`;
      if (pl && !inPlan.has(it.id)) act += `<button class="hp-btn" data-hadd="${esc(it.id)}|${di}">✚ 加進 Day ${di + 1}</button>`;
      if (!pl && !K.state.sel.has(it.id)) act += `<button class="hp-btn" data-hsel="${esc(it.id)}">✚ 加入勾選</button>`;
      return placeCard(it, extra, act);
    }).join('');
    const foot = anchorStop && anchorStop.it && anchorStop.it.kind === kind ? `<p class="hp-tip">按「🔁 換掉…」會把原本那站換成新店、整天重新排時間；按「✚ 加進」則兩家都留著。</p>` : '';
    return head + cards + foot;
  }
  function answerPlan(p) {
    const pl = plan();
    if (!pl) return `<p>還沒有產生行程——先回到勾選頁勾好景點與美食，按「✨ 產生專屬行程」，我就能回答今天幾點去哪。</p>`;
    const di = p.day != null ? p.day : dayIdx();
    const d = pl.days[di];
    const rows = dayStops(di).map(s => `<div class="hp-row"><span class="hp-t">${fmtT(s.t)}</span>${esc(stopName(s))}${s.suggest ? ' <small>（推薦補位）</small>' : ''}</div>`).join('');
    return `<p><b>Day ${di + 1}｜${esc(d.date)}｜${esc(d.theme)}</b>${inTrip() || p.day != null ? '' : '（目前以你在上方選的日子為準）'}</p><div class="hp-rows">${rows}</div><p class="hp-tip">想改順序或換店，直接問我「附近還有什麼」，或回行程表用每站的「調整」列。</p>`;
  }
  function answerNext(p, geo) {
    const pl = plan();
    if (!pl) return answerPlan(p);
    const di = dayIdx();
    const now = nowMin();
    const stops = dayStops(di).filter(s => s.it || s.store || s.anchor || s.hotel || s.d5shop);
    const cur = stops.find(s => s.end != null && now >= s.t && now <= s.end);
    const next = stops.find(s => s.t > now) || null;
    if (!inTrip()) return `<p>現在不在旅程期間（${esc(TRIP[0].label.slice(0, 4))}–${esc(TRIP[4].label.slice(0, 4))}），「下一站」要旅程中依時間才算得出來。先看看整天：</p>` + answerPlan(p);
    if (!next) return `<p>Day ${di + 1} 的行程已經走完了，今晚好好休息 😴</p>`;
    const from = geo ? { lat: geo.lat, lng: geo.lng, name: '你的位置' } : (cur && cur.it ? posOf(cur.it) : hotelPos());
    const to = next.it ? posOf(next.it) : next.store ? { lat: next.store.lat, lng: next.store.lng, name: next.store.name, zone: next.store.zone } : next.hotel ? hotelPos() : null;
    const tr = to ? transFrom(from, to) : null;
    const it = next.it || null;
    const head = `<p>${cur ? `現在是「${esc(stopName(cur))}」（到 ${fmtT(cur.end)}）。` : ''}<b>下一站 ${fmtT(next.t)}：${esc(stopName(next))}</b>${tr ? `——從${esc(from.name)}${esc(transShort(tr))}` : ''}</p>`;
    return head + (it ? placeCard(it, `<div class="hp-meta sub"><span class="hp-st ${openStatus(it, di, now).cls}">${esc(openStatus(it, di, now).txt)}</span></div>`) : next.store ? `<div class="hp-card"><div class="hp-name">🛍️ ${esc(next.store.name)}</div>${K.linkRow(next.store.links, null, K.posOfStore(next.store))}</div>` : next.hotel ? hotelCard(geo) : '');
  }
  function hotelCard(geo) {
    const h = K.hotelInfo();
    const tr = geo ? transFrom({ lat: geo.lat, lng: geo.lng, name: '你的位置' }, h) : null;
    const hl = K.HOTEL_LIST.find(x => x.hkey === K.state.hotel) || K.HOTEL_LIST[0];
    return `<div class="hp-card"><div class="hp-name">🏨 ${esc(h.name)}</div>
      <div class="hp-meta sub">${esc(h.area)}${tr ? `　｜　從你的位置 ${esc(transShort(tr))}` : ''}</div>
      ${K.linkRow(h.links, null, K.posOfItem(hl))}</div>`;
  }
  function answerHotel(p, geo) {
    return `<p>回飯店最省事的方式：按黑色「🚗 Uber 直接設目的地」，或複製日文地址給司機看。</p>` + hotelCard(geo);
  }
  function answerRoute(p, geo) {
    const it = p.place;
    const di = p.day != null ? p.day : dayIdx();
    const from = geo ? { lat: geo.lat, lng: geo.lng, name: '你的位置' } : (plan() && currentStop(di) && currentStop(di).it && inTrip() ? posOf(currentStop(di).it) : hotelPos());
    const to = it.kind === 'shop' ? (it._store ? { lat: it._store.lat, lng: it._store.lng, name: it._store.name, zone: it._store.zone } : null) : posOf(it);
    if (!to) return `<p>「${esc(it.name)}」是商品，沒有固定地點——到它所屬的門市買就好。</p>`;
    const tr = transFrom(from, to);
    const km = K.havKm(from, to);
    const charter = ['north', 'central'].indexOf(it.cluster) >= 0 && km > 15;
    return `<p><b>從${esc(from.name)}到「${esc(it.name)}」：直線約 ${kmTxt(km)}</b>，${esc(transShort(tr))}${charter ? '。這一帶屬包車日路線，若當天有包車請直接請司機載過去' : ''}。按「🧭 Google 導航到這」會從你現在的位置規劃路線。</p>` +
      placeCard(it.kind === 'shop' ? it._store : it, it.links && it.links.drop ? '' : '');
  }
  function answerHours(p) {
    const it = p.place;
    const di = p.day != null ? p.day : dayIdx();
    const o = it.kind === 'shop' ? it._store : it;
    const st = openStatus(o, di, (p.wantsNow || inTrip()) ? nowMin() : null);
    const stDay = openStatus(o, di, null);
    const lines = [`<p><b>${esc(it.name)}</b>　<span class="hp-st ${st.cls}">${esc(st.txt)}</span></p>`];
    if (o.closedDow && o.closedDow.length) lines.push(`<p>固定公休：週${o.closedDow.map(d => K.DOW_TXT[d]).join('・')}${stDay.closed ? `——<b>Day ${di + 1}（${esc(TRIP[di].label.slice(0, 7))}）剛好公休</b>` : ''}</p>`);
    if (it.wait) lines.push(`<p>⏱ ${esc(it.wait)}</p>`);
    return lines.join('') + placeCard(it.kind === 'shop' ? it._store : it);
  }
  function answerInfo(p) {
    const it = p.place;
    const o = it.kind === 'shop' ? (it._store || it) : it;
    const L = o.links || {};
    const bits = [];
    if (L.addr) bits.push(`🚕 日文地址：${esc(L.addr)}${L.addrX ? `（${esc(L.addrX)}）` : ''}`);
    if (L.tel) bits.push(`📞 電話：${esc(L.tel)}`);
    if (L.drop) bits.push(`🚖 下車點：${esc(L.drop)}`);
    if (it.area) bits.push(`📌 ${esc(it.area)}`);
    return `<p><b>${esc(it.name)}</b></p>${bits.map(b => `<p>${b}</p>`).join('')}` + placeCard(o);
  }
  function answerOrder(p) {
    const it = p.place;
    if (!it.order) return `<p>「${esc(it.name)}」沒有建檔的推薦點法——卡片上的介紹通常已寫招牌：</p>` + placeCard(it);
    return `<p><b>${esc(it.name)}</b> 的推薦點法：</p>` + placeCard(it);
  }
  function answerReserve(p) {
    const it = p.place;
    const L = it.links || {};
    const bits = [];
    if (L.rs) bits.push(`📅 有線上訂位頁（${esc(L.rsN || '')}）：下方按鈕直接開。`);
    if (L.tel) bits.push(`📞 電話 ${esc(L.tel)}（日本國碼 +81，去掉開頭 0）。`);
    if (it.wait) bits.push(`⏱ ${esc(it.wait)}`);
    if (!L.rs && !L.tel) bits.push('這家沒有建檔的訂位方式，請用 Google 店家頁的電話或現場候位。');
    return `<p><b>${esc(it.name)}</b></p>${bits.map(b => `<p>${b}</p>`).join('')}` + placeCard(it);
  }
  function answerMetro() {
    const pl = plan();
    let line = '';
    if (pl) {
      const rides = pl.days.reduce((s, d) => s + ((d.modeCnt || {}).metro || 0), 0);
      const cap = pl.days.reduce((s, d) => s + Math.min(800, d.metroYen || 0), 0);
      line = rides ? `<p>這份行程共搭單軌 ${rides} 段，每人約 ${cap.toLocaleString('en-US')} 円。</p>` : '<p>這份行程沒有排到單軌（以步行／計程車／包車為主）。</p>';
    }
    return line + `<p><b>單軌不用買票也不用儲值</b>：刷感應式信用卡（Visa／Mastercard／JCB／銀聯，一人一張，手機錢包也可）直接進出站，同一張卡每日自動封頂 800 円，比 24 小時券（1,000 円）更省。現行單程 250-390 円。沒有感應卡才考慮在售票機買 QR 一日券。</p>`;
  }
  function answerCharter(p) {
    const ch = K.charterInfo();
    const di = p.day != null ? p.day : dayIdx();
    const pl = plan();
    const d = pl && pl.days[di];
    const txt = d && d.charter ? `<p>Day ${di + 1} 是包車日：08:30 於飯店出發，${esc(ch.label)}，費用${esc(ch.costTxt)}。${d.charterCost ? '' : ''}</p>` : `<p>Day ${di + 1} 不是包車日（市區以步行、單軌與計程車為主）。北部／中部遠征日才全程包車：${esc(ch.label)}，${esc(ch.costTxt)}。</p>`;
    return txt + `<p>包車 10 小時基準、自上車起算；超時約每 30 分 3,500 円現金付司機。中文司機檔期熱門，請提前 2-3 個月預訂；景點門票與美麗海入場券可請司機代買（許田道之驛有折扣票）。</p>`;
  }
  function answerWeather() {
    return `<p>${esc(CONFIG.holidayNote)}</p><p>防風外套、毛帽、好走的鞋三樣必帶；海邊與岬角（萬座毛、知念岬、殘波岬）風最大，長輩可縮短停留。下雨的話問我「雨天備案」。</p>`;
  }
  function answerRain() {
    const ids = ['s27', 's01', 's10', 's20', 's14', 's16'];
    const items = ids.map(id => K.DB[id]).filter(Boolean);
    const stores = ['parco', 'aeon_rycom', 'dfs', 'mainplace', 'donki'].map(k => STORES[k]).filter(Boolean);
    return `<p><b>雨天／強風備案（全室內或有遮蔽）：</b></p>` + items.map(it => placeCard(it, `<div class="hp-meta sub">${esc(it.area || '')}</div>`)).join('') +
      `<p>購物中心也都是室內：${stores.map(s => esc(s.name)).join('、')}。首里城、美麗海以室內館為主也能走；海邊與岬角、賞鯨船、浮潛遇強風可能取消。</p>`;
  }
  function answerFlight() {
    const fi = K.flightInfo();
    const t = CONFIG.trip;
    return `<p>✈️ 去程 ${esc(t.outbound.date)} ${fmtT(fi.obDep)} 出發 → ${fmtT(fi.obArr)} 抵達那霸（日本時間）<br>✈️ 回程 ${esc(t.inbound.date)} ${fmtT(fi.ibDep)} 那霸出發 → ${fmtT(fi.ibArr)} 抵達台灣（台灣時間）</p><p>回程建議 ${fmtT(fi.ibDep - 120)} 前抵達那霸機場；行程表最後一天已依此反推幾點要離開飯店。航班時間可在結果頁上方的摘要卡修改。</p>`;
  }
  function answerBudget() {
    const pl = plan();
    if (!pl) return '<p>先產生行程，我才能算這份行程的花費。</p>';
    return `<p>💰 每人餐飲＋門票約 ${money(pl.cost)}；🚕 交通約 ${money(pl.transTotal)}（${K.PARTY()} 人合計，含包車日包車費）${pl.shopCost ? `；🛍️ 購物清單全買約 ${money(pl.shopCost)}` : ''}。不含機票、住宿。</p>`;
  }
  function answerSearch(p) {
    const nq = norm(p.q);
    const toks = nq.split(/[，,。！!？?、\s]+/).filter(t => t.length >= 2 && !/^(請問|幫我|我想|想要|一下|可以|有沒有|哪裡|什麼|推薦)$/.test(t));
    const hits = K.ALL.filter(it => toks.some(t => (it._hay || '').includes(t))).slice(0, 5);
    if (!hits.length) return null;
    return `<p>清單裡和「${esc(p.q)}」相關的項目：</p>` + hits.map(it => placeCard(it, `<div class="hp-meta sub">${esc(it.area || it.buy || '')}</div>`, !K.state.sel.has(it.id) ? `<button class="hp-btn" data-hsel="${esc(it.id)}">✚ 加入勾選</button>` : '')).join('');
  }
  const HELP = `<p>我可以用文字或 🎤 語音回答這些事（都用你勾選的清單與行程資料）：</p>
    <ul class="hp-ul"><li>「午餐那家排太久，附近還有什麼？」→ 以那一站為中心列出最近的餐廳，可一鍵換進行程</li>
    <li>「現在附近有開的咖啡廳」「這附近有什麼景點」→ 開啟 📍 我的位置後用 GPS 找</li>
    <li>「今天行程」「下一站怎麼去」「Day 3 晚上吃什麼」</li>
    <li>「傑克牛排現在有開嗎」「首里城怎麼去」「EIBUN 要點什麼」「琉球之牛怎麼訂位」「美麗海地址」</li>
    <li>「回飯店」「單軌要買票嗎」「包車幾點出發」「天氣」「雨天備案」「航班」「花費」</li></ul>
    <p class="hp-tip">旅程期間會自動依今天日期與時間回答；現在可先在上方選「Day N」試算。⚙️ 裡可貼上自己的 Claude API key，聽不懂的問題會改交給 Claude 回答。</p>`;

  /* ---------- 主流程 ---------- */
  const log = [];   // { role:'user'|'bot', html, text }
  let geoOn = localStorage.getItem('oki_helper_geo') === '1';
  let ttsOn = localStorage.getItem('oki_helper_tts') === '1';
  let lastGeo = null;
  function getGeo() {
    return new Promise(res => {
      if (!geoOn || !navigator.geolocation) return res(null);
      if (lastGeo && Date.now() - lastGeo.t < 60000) return res(lastGeo);
      navigator.geolocation.getCurrentPosition(
        pos => { lastGeo = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now() }; res(lastGeo); },
        () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
    });
  }
  async function answer(q) {
    const p = parse(q);
    const needGeo = geoOn && (p.useGeo || p.intent === 'next' || p.intent === 'hotel' || p.intent === 'route');
    const geo = needGeo ? await getGeo() : null;
    const geoNote = (p.useGeo && geoOn && !geo) ? '<p class="hp-tip">拿不到你的位置（未授權或沒有訊號），改用行程或飯店當中心。</p>' : '';
    let html = null;
    switch (p.intent) {
      case 'help': html = HELP; break;
      case 'thanks': html = '<p>不客氣，旅途愉快 🌺</p>'; break;
      case 'nearby': html = geoNote + answerNearby(p, geo); break;
      case 'plan': html = answerPlan(p); break;
      case 'next': html = geoNote + answerNext(p, geo); break;
      case 'hotel': html = answerHotel(p, geo); break;
      case 'route': html = geoNote + answerRoute(p, geo); break;
      case 'hours': html = answerHours(p); break;
      case 'info': html = answerInfo(p); break;
      case 'order': html = answerOrder(p); break;
      case 'reserve': html = answerReserve(p); break;
      case 'metro': html = answerMetro(); break;
      case 'charter': html = answerCharter(p); break;
      case 'weather': html = answerWeather(); break;
      case 'rain': html = answerRain(); break;
      case 'flight': html = answerFlight(); break;
      case 'budget': html = answerBudget(); break;
      case 'search': html = answerSearch(p); break;
    }
    if (html) return { html, p, builtin: true };
    // 規則引擎聽不懂：有 API key 就交給 Claude，否則給提示
    if (AI.key()) {
      const r = await askClaude(q, p);
      if (r.ok) return { html: `<div class="hp-ai">${mdLite(r.text)}</div><p class="hp-tip">— Claude 依清單與行程資料回答，店家最新狀況仍以現場為準</p>`, p, ai: true, text: r.text };
      return { html: `<p>Claude 沒有回應（${esc(r.err)}）。</p>` + HELP, p };
    }
    return { html: `<p>我不太確定你的意思，換個說法試試，或直接問下面這些：</p>` + HELP, p };
  }

  /* ---------- Claude API（選用）：瀏覽器直連，key 只存在這支手機 ---------- */
  const AI = {
    key: () => localStorage.getItem('oki_ai_key') || '',
    model: () => localStorage.getItem('oki_ai_model') || 'claude-opus-5-5',
    always: () => localStorage.getItem('oki_ai_always') === '1'
  };
  let dataBlockCache = null;
  function dataBlock() {
    if (dataBlockCache) return dataBlockCache;
    const items = K.ALL.map(it => {
      const o = { id: it.id, kind: it.kind, name: it.name, jp: it.jp, cat: it.cat, cluster: it.cluster, area: it.area, zone: it.zone };
      if (it.kind !== 'shop') { Object.assign(o, { lat: it.lat, lng: it.lng, open: it.open != null ? fmtT(it.open) : null, close: it.close != null ? fmtT(Math.min(it.close, 1439)) : null, closedDow: it.closedDow || null, slot: it.slot, stay: it.stay, price: it.price, wait: it.wait, order: it.order, addr: (it.links || {}).addr, tel: (it.links || {}).tel, drop: (it.links || {}).drop, desc: (it.desc || '').slice(0, 160) }); }
      else Object.assign(o, { buy: it.buy, price: it.price, store: it.store, safe: it.safe });
      return o;
    });
    const stores = Object.entries(STORES).map(([k, s]) => ({ key: k, name: s.name, zone: s.zone, open: s.open != null ? fmtT(s.open) : null, close: s.close != null ? fmtT(Math.min(s.close, 1439)) : null, closedDow: s.closedDow || null, note: s.note, addr: (s.links || {}).addr }));
    const hotels = Object.entries(HOTELS).map(([k, h]) => ({ key: k, name: h.name, area: h.area, lat: h.lat, lng: h.lng, addr: (h.links || {}).addr, note: h.note }));
    dataBlockCache = '【清單資料（JSON）】\n' + JSON.stringify({ items, stores, hotels, zones: ZONES, clusters: CLUSTERS, transit: TRANSIT });
    return dataBlockCache;
  }
  async function askClaude(q, p) {
    const key = AI.key();
    const model = AI.model();
    const di = dayIdx();
    const pl = plan();
    const fi = K.flightInfo();
    const facts = `你是「2027 沖繩五天四夜」行程工具內的旅途小幫手。使用者是台灣家庭（${K.PARTY()} 位大人，含 55-60 歲父母與兩對 30 歲夫妻），不自駕，住那霸「${K.hotelInfo().name}」。旅程 2027/1/20（三）～1/24（日）；去程 ${fmtT(fi.obDep)} 出發 ${fmtT(fi.obArr)} 抵那霸，回程 ${fmtT(fi.ibDep)} 那霸出發。
回答規則：只用提供的清單資料與行程資料回答（距離用座標概算：那霸市區 1 公里步行約 15 分、計程車每公里約 3 分＋5 分候車）；不在清單內的店不要推薦，但可以說清單裡沒有。繁體中文、口語、簡潔（手機上看），先講結論再講理由；給替代店時列出店名、距離、營業時間與一句推薦點法。無法確定的事（例如今天是否臨時公休）要說「以店家公告為準」。`;
    const dyn = `【現在】${inTrip() ? `旅程中 Day ${di + 1}` : `尚未出發（使用者目前選 Day ${di + 1} 試算）`}，裝置時間 ${fmtT(nowMin())}${lastGeo ? `，使用者位置 ${lastGeo.lat.toFixed(5)},${lastGeo.lng.toFixed(5)}` : ''}。
【行程】${pl ? K.planText(pl).replace(/🔗 互動版連結.*$/m, '') : '（尚未產生行程）'}`;
    // 對話歷史：同角色連續訊息合併，確保 user／assistant 交替（API 要求）
    const history = [];
    log.filter(m => m.text).slice(-10).forEach(m => {
      const role = m.role === 'user' ? 'user' : 'assistant';
      if (history.length && history[history.length - 1].role === role) history[history.length - 1].content += '\n' + m.text;
      else history.push({ role, content: m.text });
    });
    if (history.length && history[history.length - 1].role === 'user') history[history.length - 1].content += '\n' + q;
    else history.push({ role: 'user', content: q });
    if (history[0].role !== 'user') history.shift();
    const messages = history;
    const body = {
      model, max_tokens: 1200,
      system: [
        { type: 'text', text: facts },
        { type: 'text', text: dataBlock(), cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dyn }
      ],
      messages,
      output_config: { effort: 'low' }
    };
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-dangerous-direct-browser-access': 'true' };
    if (/^claude-(opus|sonnet)-5/.test(model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'; }
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
      if (!r.ok) {
        let msg = r.status === 401 ? 'API key 無效' : r.status === 429 ? '請求太頻繁，稍後再試' : r.status === 400 ? '請求被拒絕（400）' : `HTTP ${r.status}`;
        try { const j = await r.json(); if (j.error && j.error.message) msg += '：' + j.error.message.slice(0, 120); } catch (e) {}
        return { ok: false, err: msg };
      }
      const j = await r.json();
      if (j.stop_reason === 'refusal') return { ok: false, err: 'Claude 拒絕回答這個問題' };
      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return text ? { ok: true, text } : { ok: false, err: '空白回應' };
    } catch (e) {
      return { ok: false, err: '連不上網路或 API（' + (e && e.message ? e.message.slice(0, 60) : '') + '）' };
    }
  }
  const mdLite = t => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/^[-•]\s+/gm, '• ').replace(/\n/g, '<br>');

  /* ---------- 語音 ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;
  function startVoice() {
    if (!SR) { K.toast('這個瀏覽器不支援語音輸入——iPhone 請用 Safari 開啟，Android 用 Chrome'); return; }
    if (listening) { try { rec.stop(); } catch (e) {} return; }
    rec = new SR(); rec.lang = 'zh-TW'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    const input = $('#hpIn'), mic = $('#hpMic');
    let finalTxt = '';
    rec.onstart = () => { listening = true; mic.classList.add('on'); input.placeholder = '請說話…'; };
    rec.onresult = e => { let t = ''; for (let i = e.resultIndex; i < e.results.length; i++) { t += e.results[i][0].transcript; if (e.results[i].isFinal) finalTxt += e.results[i][0].transcript; } input.value = finalTxt || t; };
    rec.onerror = e => { listening = false; mic.classList.remove('on'); input.placeholder = PH; if (e.error === 'not-allowed') K.toast('請允許瀏覽器使用麥克風'); };
    rec.onend = () => { listening = false; mic.classList.remove('on'); input.placeholder = PH; const v = (finalTxt || input.value).trim(); if (v) submit(v); };
    try { rec.start(); } catch (e) { K.toast('語音啟動失敗，請再按一次'); }
  }
  function speak(text) {
    if (!ttsOn || !('speechSynthesis' in window)) return;
    const clean = text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').slice(0, 400);
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(clean); u.lang = 'zh-TW'; u.rate = 1.05;
      const v = speechSynthesis.getVoices().find(x => /zh[-_]TW/i.test(x.lang)); if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) {}
  }
  const PH = '問我：午餐那家排太久，附近還有什麼？';

  /* ---------- UI ---------- */
  const CHIPS = ['午餐附近還有什麼', '現在附近有開的餐廳', '今天行程', '下一站怎麼去', '回飯店', '單軌要買票嗎', '雨天備案', '天氣穿什麼'];
  function mount() {
    const fab = document.createElement('button');
    fab.id = 'helperFab'; fab.className = 'no-print'; fab.type = 'button'; fab.innerHTML = '🤖 小幫手';
    const box = document.createElement('div');
    box.id = 'helper'; box.className = 'no-print'; box.hidden = true;
    box.innerHTML = `
      <div class="hp-head">
        <b>🤖 旅途小幫手</b>
        <select id="hpDay" title="旅程中會自動依日期；現在可先選一天試算">${TRIP.map(t => `<option value="${t.idx}">${t.label}</option>`).join('')}</select>
        <button type="button" id="hpGeo" title="用手機 GPS 當「附近」的中心">📍</button>
        <button type="button" id="hpTts" title="朗讀回答">🔊</button>
        <button type="button" id="hpSet" title="設定（Claude API key）">⚙️</button>
        <button type="button" id="hpClose" title="收起">✕</button>
      </div>
      <div class="hp-set" id="hpSetBox" hidden>
        <div class="hp-set-row"><label>Claude API key（選填）<input type="password" id="hpKey" placeholder="sk-ant-…" autocomplete="off"></label></div>
        <div class="hp-set-row"><label>模型 <select id="hpModel"><option value="claude-opus-5-5">Claude Opus 5.5（預設）</option><option value="claude-sonnet-5-5">Claude Sonnet 5.5（較省）</option><option value="claude-haiku-5-5">Claude Haiku 5.5（最省）</option></select></label>
          <label><input type="checkbox" id="hpAlways"> 所有問題都交給 Claude</label></div>
        <div class="hp-tip">key 只存在這支手機的瀏覽器裡、直接連 Anthropic，不經過任何中間伺服器；每次提問會把整份清單與行程當作上下文（已啟用快取，重複提問很便宜）。沒有 key 也能用內建的規則回答。</div>
        <div class="hp-set-row"><button type="button" class="hp-btn go" id="hpSave">儲存</button><button type="button" class="hp-btn" id="hpClear">清除 key</button></div>
      </div>
      <div class="hp-log" id="hpLog"></div>
      <div class="hp-chips" id="hpChips">${CHIPS.map(c => `<button type="button" class="hp-chip" data-q="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="hp-input">
        <input id="hpIn" type="text" placeholder="${PH}" autocomplete="off" enterkeyhint="send">
        <button type="button" id="hpMic" title="語音輸入">🎤</button>
        <button type="button" id="hpSend" class="go">送出</button>
      </div>`;
    document.body.appendChild(fab); document.body.appendChild(box);
    $('#hpDay').value = String(dayIdx());
    if (autoDay() >= 0) $('#hpDay').disabled = true;
    $('#hpGeo').classList.toggle('on', geoOn);
    $('#hpTts').classList.toggle('on', ttsOn);
    $('#hpKey').value = AI.key(); $('#hpModel').value = AI.model(); $('#hpAlways').checked = AI.always();

    fab.addEventListener('click', () => { box.hidden = !box.hidden; fab.classList.toggle('open', !box.hidden); if (!box.hidden) { if (!log.length) push('bot', HELP, ''); setTimeout(() => $('#hpIn').focus(), 50); } });
    $('#hpClose').addEventListener('click', () => { box.hidden = true; fab.classList.remove('open'); });
    $('#hpDay').addEventListener('change', e => { pickedDay = +e.target.value; localStorage.setItem('oki_helper_day', String(pickedDay)); });
    $('#hpGeo').addEventListener('click', async () => {
      geoOn = !geoOn; localStorage.setItem('oki_helper_geo', geoOn ? '1' : '0'); $('#hpGeo').classList.toggle('on', geoOn);
      if (geoOn) { const g = await getGeo(); K.toast(g ? `已取得你的位置（誤差視訊號而定），「附近」會以它為中心` : '拿不到位置——請允許瀏覽器使用定位；沒訊號時改用行程或飯店當中心'); }
      else K.toast('已關閉定位，「附近」改以行程中的那一站或飯店為中心');
    });
    $('#hpTts').addEventListener('click', () => { ttsOn = !ttsOn; localStorage.setItem('oki_helper_tts', ttsOn ? '1' : '0'); $('#hpTts').classList.toggle('on', ttsOn); if (!ttsOn) try { speechSynthesis.cancel(); } catch (e) {} K.toast(ttsOn ? '會用語音朗讀回答' : '已關閉朗讀'); });
    $('#hpSet').addEventListener('click', () => { const s = $('#hpSetBox'); s.hidden = !s.hidden; });
    $('#hpSave').addEventListener('click', () => {
      const k = $('#hpKey').value.trim();
      if (k && !/^sk-ant-/.test(k)) { K.toast('這看起來不是 Anthropic 的 API key（應以 sk-ant- 開頭）'); return; }
      localStorage.setItem('oki_ai_key', k); localStorage.setItem('oki_ai_model', $('#hpModel').value); localStorage.setItem('oki_ai_always', $('#hpAlways').checked ? '1' : '0');
      $('#hpSetBox').hidden = true; K.toast(k ? '已儲存，聽不懂的問題會交給 Claude' : '已清除 key，改用內建回答');
    });
    $('#hpClear').addEventListener('click', () => { $('#hpKey').value = ''; localStorage.removeItem('oki_ai_key'); K.toast('已清除 key'); });
    $('#hpSend').addEventListener('click', () => submit($('#hpIn').value));
    $('#hpIn').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit($('#hpIn').value); } });
    $('#hpMic').addEventListener('click', startVoice);
    $('#hpChips').addEventListener('click', e => { const b = e.target.closest('.hp-chip'); if (b) submit(b.dataset.q); });
    // 回答裡的動作鈕：換店／加進行程／加入勾選
    $('#hpLog').addEventListener('click', e => {
      const sw = e.target.closest('[data-hswap]');
      if (sw) { const [oldId, newId, d, s] = sw.dataset.hswap.split('|'); swapStop(oldId, newId, +d, s || null); return; }
      const ad = e.target.closest('[data-hadd]');
      if (ad) { const [id, d] = ad.dataset.hadd.split('|'); addStop(id, +d); return; }
      const sl = e.target.closest('[data-hsel]');
      if (sl) { K.state.sel.add(sl.dataset.hsel); K.save(); if (K.plan()) K.reflow(`已把「${K.DB[sl.dataset.hsel].name}」加進勾選並重排`); else { K.refreshPick(); K.toast(`已加入勾選「${K.DB[sl.dataset.hsel].name}」`); } return; }
    });
  }
  function swapStop(oldId, newId, d, slot) {
    const st = K.state;
    st.sel.add(newId);
    st.pins[newId] = { d, s: slot && /^(brunch|lunch|cafe|sweet|dinner|night|latelunch|pmcafe|d1dinner|d1night|d5brunch|d5lunch)$/.test(slot) ? slot : null, t: Date.now() };
    st.sel.delete(oldId); delete st.pins[oldId]; delete st.at[oldId];
    let note = '';
    if (!K.ready()) { st.sel.add(oldId); note = '（至少要保留 6 家餐飲，原本那家先留在勾選裡、沒有釘在當天）'; }
    K.reflow(`已把「${K.DB[oldId].name}」換成「${K.DB[newId].name}」，整天重新排好了${note}`);
    push('bot', `<p>✅ 已把「${esc(K.DB[oldId].name)}」換成「${esc(K.DB[newId].name)}」，Day ${d + 1} 的時間重新排好了${esc(note)}。</p>`, '');
  }
  function addStop(id, d) {
    const st = K.state;
    st.sel.add(id); st.pins[id] = { d, s: null, t: Date.now() };
    K.reflow(`已把「${K.DB[id].name}」加進 Day ${d + 1}，行程重新排好了`);
    push('bot', `<p>✅ 已把「${esc(K.DB[id].name)}」加進 Day ${d + 1}。</p>`, '');
  }
  function push(role, html, text) {
    log.push({ role, html, text });
    const el = document.createElement('div');
    el.className = 'hp-msg ' + role;
    el.innerHTML = html;
    $('#hpLog').appendChild(el);
    $('#hpLog').scrollTop = $('#hpLog').scrollHeight;
    return el;
  }
  let busy = false;
  async function submit(q) {
    q = String(q || '').trim();
    if (!q || busy) return;
    busy = true;
    $('#hpIn').value = '';
    push('user', `<p>${esc(q)}</p>`, q);
    const wait = push('bot', '<p class="hp-wait">思考中…</p>', '');
    try {
      let r;
      if (AI.key() && AI.always()) {
        const p = parse(q);
        const ai = await askClaude(q, p);
        r = ai.ok ? { html: `<div class="hp-ai">${mdLite(ai.text)}</div><p class="hp-tip">— Claude 依清單與行程資料回答，店家最新狀況仍以現場為準</p>`, text: ai.text } : await answer(q);
      } else r = await answer(q);
      wait.innerHTML = r.html;
      log[log.length - 1].text = r.text || wait.innerText.slice(0, 600);
      speak(r.text || wait.innerText);
    } catch (e) {
      wait.innerHTML = `<p>出了點問題：${esc(e && e.message || e)}</p>`;
    }
    busy = false;
    $('#hpLog').scrollTop = $('#hpLog').scrollHeight;
  }

  let mounted = false;
  const mountOnce = () => { if (!mounted) { mounted = true; mount(); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountOnce); else mountOnce();
})();
