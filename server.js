/**
 * server.js — نظام Nexus المتكامل مع طبقة تحويل عملة.
 *   DISPLAY_CURRENCY = العملة التي يراها اللاعب (افتراضياً TND)
 *   SETTLE_CURRENCY  = عملة تسوية الوكيل (افتراضياً UAH — حتى يفعّل المشرف TND)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { GameClient } = require('./nexus-client');
const ledger = require('./ledger');
const cur = require('./currency');
const ipGuard = require('./ip-guard');

const OFFICE_API = process.env.OFFICE_API || 'https://my.nexusggr.dev';
const GAME_API   = process.env.GAME_API   || 'https://api.nexusggr.dev';
const AGENT_CODE  = process.env.AGENT_CODE  || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const CURRENCY = process.env.CURRENCY || 'UAH';              // عملة التسوية
const DISPLAY_CURRENCY = process.env.DISPLAY_CURRENCY || 'TND'; // عملة العرض
const PORT = process.env.PORT || 3100;
// مفتاح بوابة النطاقات الخارجية (Maxbet). يُضبط على Render كمتغير GATEWAY_KEY
const GATEWAY_KEY = process.env.GATEWAY_KEY || 'mb-gw-2026-maxbet';
function gwAuth(req, b) {
  const k = (req.headers['x-gw-key'] || (b && b.gwKey) || '');
  return k === GATEWAY_KEY;
}

const game = new GameClient({ gameApiBase: GAME_API, agentCode: AGENT_CODE, token: AGENT_TOKEN, secretKey: AGENT_SECRET, currency: CURRENCY });

// ═══ كتالوج مجمّع لكل المزودين (مع إعادة محاولة عند Rate-Limit وتخزين مؤقت) ═══
const catalogCache = { at: 0, data: null, building: null };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function gamesWithRetry(providerCode, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const r = await game.gameList({ providerCode });
    if (r && r.status === 1) return (r.games || []).filter(g => g.status !== 0);
    const msg = String((r && r.msg) || '').toLowerCase();
    const transient = msg.includes('rate limit') || msg.includes('external') || msg.includes('429');
    if (!transient) return (r && r.games) || [];
    await sleep(900 * (i + 1));
  }
  return [];
}
async function buildCatalog() {
  if (catalogCache.data && Date.now() - catalogCache.at < 10 * 60 * 1000) return catalogCache.data;
  if (catalogCache.building) return catalogCache.building;
  catalogCache.building = (async () => {
    const prov = await game.providerList();
    const slotProviders = (prov.providers || []).filter(p => p.type === 'slot' && p.status === 1);
    const games = []; const providers = [];
    for (const p of slotProviders) {
      const gs = await gamesWithRetry(p.code);
      await sleep(350); // تهدئة بين المزودين لتفادي Rate-Limit
      providers.push({ code: p.code, name: p.name, count: gs.length });
      for (const g of gs) {
        games.push({ providerCode: p.code, providerName: p.name, code: g.game_code, name: g.game_name, banner: g.banner });
      }
    }
    const data = { builtAt: Date.now(), providers, games, total: games.length };
    catalogCache.data = data; catalogCache.at = Date.now(); catalogCache.building = null;
    return data;
  })();
  return catalogCache.building;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
const body = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', c => d += c); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});
function isBlocked(r) { return r && (r.httpStatus === 403 || (typeof r.raw === 'string' && r.raw.includes('Cloudflare'))); }
function serve(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
}
// رصيد بوحدتي العملتين
function dual(amountSettle) {
  const settle = Number(amountSettle || 0);
  return { settle, settleCur: CURRENCY, display: cur.convert(settle, CURRENCY, DISPLAY_CURRENCY), displayCur: DISPLAY_CURRENCY };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${u.pathname}`;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }

  try {
    /* ---------- الحالة + بيانات العملة ---------- */
    if (route === 'GET /api/status')
      return json(res, 200, {
        ok: true, agentCode: AGENT_CODE,
        settleCur: CURRENCY, displayCur: DISPLAY_CURRENCY,
        rate: cur.rate(CURRENCY, DISPLAY_CURRENCY),
        ratesUpdatedAt: cur.lastUpdate(),
      });

    if (route === 'GET /api/health') {
      const prov = await game.providerList();
      const ip = await new Promise((resolve) => {
        http.get('http://ip-api.com/json', (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d).query);}catch{resolve(null);}}); }).on('error',()=>resolve(null));
      });
      const blocked = isBlocked(prov);
      return json(res, 200, { gameApiReachable: prov.status === 1, blockedByCloudflare: blocked, serverIp: ip,
        action: blocked ? `أضف ${ip} في لوحة Nexus → /app/cloudflare` : 'كل شيء يعمل ✅' });
    }

    // فحص/تشغيل يدوي لآلية التسجيل التلقائي لعنوان IP في القائمة البيضاء
    if (route === 'GET /api/ipguard') {
      const r = await ipGuard.ensureIpWhitelisted();
      return json(res, 200, r);
    }

    if (route === 'GET /api/providers') {
      const r = await game.providerList();
      return json(res, isBlocked(r) ? 403 : 200, { ok: r.status === 1, blocked: isBlocked(r), providers: r.providers || [], msg: r.msg });
    }
    if (route === 'GET /api/games') {
      const r = await game.gameList({ providerCode: u.searchParams.get('provider') });
      return json(res, isBlocked(r) ? 403 : 200, { ok: r.status === 1, blocked: isBlocked(r), games: r.games || [], msg: r.msg });
    }

    /* ================= لوحة الوكيل ================= */
    if (route === 'POST /api/agent/accounts') {
      const b = await body(req);
      const code = (b.code || '').trim();
      if (!code) return json(res, 400, { ok: false, error: 'كود الحساب مطلوب' });
      const { created, account } = ledger.createAccount(code, { label: b.label, password: b.password, currency: CURRENCY });
      return json(res, 200, { ok: true, created, code: account.code, label: account.label });
    }

    if (route === 'GET /api/agent/accounts') {
      const accs = ledger.listAccounts();
      const info = await game.moneyInfo({});
      const agentSettle = info.agent ? Number(info.agent.balance) : null;
      const withBal = [];
      for (const a of accs) {
        let settle = null;
        try {
          const mi = await game.moneyInfo({ userCode: a.code });
          const usr = mi.user || {};
          settle = usr.balance !== undefined ? Number(usr.balance) : 0;
        } catch { settle = null; }
        withBal.push({ ...a, balance: dual(settle) });
      }
      return json(res, 200, {
        ok: true,
        agentBalance: dual(agentSettle),
        settleCur: CURRENCY, displayCur: DISPLAY_CURRENCY,
        accounts: withBal,
      });
    }

    // إضافة رصيد — يُرسل المبلغ بالعملة المعروضة (TND) ويُحوّل لعملة التسوية
    if (route === 'POST /api/agent/deposit') {
      const b = await body(req);
      const code = (b.code || '').trim();
      const amtDisplay = Number(b.amount || 0);          // بالمبلغ الظاهر للوكيل (TND)
      const curIn = (b.currency || DISPLAY_CURRENCY).toUpperCase();
      const amountSettle = cur.convert(amtDisplay, curIn, CURRENCY); // لتحويل لعملة الوكيل
      if (!code || amtDisplay <= 0) return json(res, 400, { ok: false, error: 'كود الحساب ومبلغ صحيح مطلوبان' });
      if (!ledger.getAccount(code)) ledger.createAccount(code, { currency: CURRENCY });
      const r = await game.depositUser({ userCode: code, amount: amountSettle });
      if (r.status === 1) ledger.logTx(code, 'deposit', amountSettle);
      const blocked = isBlocked(r);
      return json(res, blocked ? 403 : 200, {
        ok: r.status === 1, blocked,
        requested: { display: amtDisplay, displayCur: curIn, settle: amountSettle, settleCur: CURRENCY },
        settle: { amount: r.user_balance, currency: CURRENCY },
        userBalance: dual(r.user_balance),
        agentBalance: dual(r.agent_balance),
        msg: r.msg,
      });
    }

    // سحب — يُرسل بالمبلغ الظاهر (TND) ويُحوّل
    if (route === 'POST /api/agent/withdraw') {
      const b = await body(req);
      const code = (b.code || '').trim();
      if (!ledger.getAccount(code)) return json(res, 404, { ok: false, error: 'الحساب غير موجود' });
      let r;
      if (b.all || b.reset) {
        r = await game.resetUser({ userCode: code });
      } else {
        const amtDisplay = Number(b.amount || 0);
        const curIn = (b.currency || DISPLAY_CURRENCY).toUpperCase();
        const amountSettle = cur.convert(amtDisplay, curIn, CURRENCY);
        if (amtDisplay <= 0) return json(res, 400, { ok: false, error: 'مبلغ صحيح مطلوب أو اختر سحب الكل' });
        r = await game.withdrawUser({ userCode: code, amount: amountSettle });
      }
      return json(res, isBlocked(r) ? 403 : 200, { ok: r.status === 1, blocked: isBlocked(r), result: r, msg: r.msg });
    }

    /* ================= واجهة اللاعب ================= */
    if (route === 'POST /api/player/login') {
      const b = await body(req);
      const v = ledger.verifyLogin((b.code || '').trim(), b.password || '');
      return json(res, v.ok ? 200 : 404, v.ok ? { ok: true, code: v.account.code, label: v.account.label } : { ok: false, error: v.reason });
    }

    if (route === 'GET /api/player/balance') {
      const code = u.searchParams.get('code');
      if (!code) return json(res, 400, { ok: false, error: 'كود الحساب مطلوب' });
      const r = await game.moneyInfo({ userCode: code });
      const usr = r.user || {};
      const settle = usr.balance !== undefined ? Number(usr.balance) : 0;
      return json(res, 200, { ok: true, code, agentBalance: dual(r.agent ? r.agent.balance : null), balance: dual(settle) });
    }

    if (route === 'POST /api/player/launch') {
      const b = await body(req);
      const code = (b.code || '').trim();
      if (!ledger.getAccount(code)) return json(res, 404, { ok: false, error: 'الحساب غير موجود — أنشئه من لوحة الوكيل أولاً.' });
      const info = await game.moneyInfo({ userCode: code });
      const usr = info.user || {}; const settle = usr.balance !== undefined ? Number(usr.balance) : 0;
      const r = await game.launchGame({
        userCode: code, providerCode: b.providerCode, gameCode: b.gameCode,
        lang: b.lang || 'ar', lobbyUrl: b.lobbyUrl, live: b.live, rtp: b.rtp });
      const blocked = isBlocked(r);
      return json(res, blocked ? 403 : 200, {
        ok: r.status === 1, blocked, launchUrl: r.launch_url, token: r.token,
        balance: dual(settle), msg: r.msg,
        note: r.status === 1
          ? (settle > 0 ? 'اللعبة جاهزة.' : 'اللعبة فتُحت — للرهان يلزم رصيد.')
          : 'تعذّر فتح اللعبة: ' + (r.msg || ''),
      });
    }

    /* ================= بوابة النطاقات الخارجية (Maxbet) =================
       تُطلق الألعاب والسبورتس بوك من Nexus عبر خادمنا (IP مُضاف للقائمة البيضاء).
       تحميها بمفتاح مشترك (X-GW-Key). الألعاب برصيد الوكيل الممول. */

    // كتالوج مجمّع لكل ألعاب المزودين (إعادة محاولة + تخزين مؤقت)
    if (route === 'GET /gw/catalog') {
      const b = await body(req);
      if (!gwAuth(req, b)) return json(res, 401, { ok: false, error: 'bad gateway key' });
      const data = await buildCatalog();
      return json(res, 200, { ok: true, ...data });
    }
    // قائمة المزودين المدعومين (للفلترة في المواقع الخارجية)
    if (route === 'GET /gw/providers') {
      const r = await game.providerList();
      return json(res, 200, { ok: r.status === 1, providers: r.providers || [] });
    }
    // قائمة ألعاب مزود (مع إعادة محاولة عند Rate-Limit)
    if (route === 'GET /gw/games') {
      const providerCode = u.searchParams.get('provider');
      const gs = await gamesWithRetry(providerCode);
      return json(res, 200, { ok: true, games: gs.map(g => ({ ...g, game_code: g.game_code })) });
    }
    // رصيد لاعب (بالعملتين)
    if (route === 'GET /gw/balance') {
      const b = await body(req);
      if (!gwAuth(req, b)) return json(res, 401, { ok: false, error: 'bad gateway key' });
      const code = u.searchParams.get('code') || b.code;
      const r = await game.moneyInfo({ userCode: code });
      const usr = r.user || {};
      return json(res, 200, { ok: true, balance: dual(usr.balance !== undefined ? usr.balance : 0), agentBalance: dual(r.agent ? r.agent.balance : null) });
    }
    // إطلاق لعبة (سلوت/طاولة) — code لاعب، providerCode، gameCode
    if (route === 'POST /gw/launch') {
      const b = await body(req);
      if (!gwAuth(req, b)) return json(res, 401, { ok: false, error: 'bad gateway key' });
      const code = (b.code || '').trim();
      if (!code) return json(res, 400, { ok: false, error: 'code مطلوب' });
      // إنشاء المستخدم ضمن Nexus إن لم يوجد (Transfer)
      try { await game._call('user_create', { user_code: code }); } catch {}
      const r = await game.launchGame({
        userCode: code, providerCode: b.providerCode, gameCode: b.gameCode,
        lang: b.lang || 'ar', lobbyUrl: b.returnUrl, rtp: b.rtp });
      return json(res, 200, { ok: r.status === 1, launchUrl: r.launch_url, msg: r.msg });
    }
    // إطلاق السبورتس بوك (لا يتطلب gameCode)
    if (route === 'POST /gw/sports') {
      const b = await body(req);
      if (!gwAuth(req, b)) return json(res, 401, { ok: false, error: 'bad gateway key' });
      const code = (b.code || '').trim() || 'mb_sports';
      try { await game._call('user_create', { user_code: code }); } catch {}
      const r = await game.launchGame({
        userCode: code, providerCode: 'SPORTSBOOK', lang: b.lang || 'ar', lobbyUrl: b.returnUrl });
      return json(res, 200, { ok: r.status === 1, launchUrl: r.launch_url, msg: r.msg, token: r.token });
    }

    /* ---------- الواجهات ---------- */
    if (route === 'GET /' || route === 'GET /index.html') return serve(res, 'index.html');
    if (route === 'GET /admin' || route === 'GET /admin.html') return serve(res, 'admin.html');
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[server]', err);
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  await cur.refreshRates(OFFICE_API);
  ipGuard.startAutoIpGuard(); // تسجيل تلقائي مستمر لعنوان IP الصادر في القائمة البيضاء لدى Nexus
  console.log(`🚀 Nexus app on port ${PORT}`);
  console.log(`   agent=${AGENT_CODE || '(env?)'} | تسوية: ${CURRENCY} | عرض: ${DISPLAY_CURRENCY} | 1 ${CURRENCY}=${cur.rate(CURRENCY, DISPLAY_CURRENCY)} ${DISPLAY_CURRENCY}`);
});
