/**
 * server.js — نظام Nexus المتكامل.
 *  • واجهة اللاعب   : /         (كل الألعاب، بحث، إطلاق)
 *  • لوحة الوكيل   : /admin    (إضافة رصيد، اللاعبون، سحب/تصفير)
 *  • واجهة برمجية  : /api/...
 *
 * البيانات:
 *   AGENT_CODE / AGENT_TOKEN / AGENT_SECRET : من لوحة Nexus (صفحة البروفايل)
 *   GAME_API    : https://api.nexusggr.dev
 *   PORT        : المنفذ (Render يضبطه تلقائياً عبر PORT)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OfficeClient, GameClient, verifyCallbackSignature } = require('./nexus-client');
const ledger = require('./ledger');

const OFFICE_API = process.env.OFFICE_API || 'https://my.nexusggr.dev';
const GAME_API   = process.env.GAME_API   || 'https://api.nexusggr.dev';
// بيانات الاعتماد تُضبط عبر متغيرات البيئة في Render (لا تُكتب في الكود)
const AGENT_CODE  = process.env.AGENT_CODE  || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const AGENT_PASS  = process.env.AGENT_PASSWORD || '';
const CURRENCY = process.env.CURRENCY || 'UAH';
const PORT = process.env.PORT || 3100;

if (!AGENT_CODE || !AGENT_TOKEN) {
  console.warn('⚠️  AGENT_CODE / AGENT_TOKEN غير مضبوطين — عيّنهما في متغيرات البيئة (Render → Environment).');
}

const game = new GameClient({ gameApiBase: GAME_API, agentCode: AGENT_CODE, token: AGENT_TOKEN, secretKey: AGENT_SECRET, currency: CURRENCY });
const office = new OfficeClient(OFFICE_API);

// ---------- أدوات ----------
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}
const body = (req) => new Promise((resolve) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
});
const rawBody = (req) => new Promise((r) => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>r(d)); });
function isBlocked(r) { return r && (r.httpStatus === 403 || (typeof r.raw === 'string' && r.raw.includes('Cloudflare'))); }
function serve(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(__dirname, 'public', file)));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${u.pathname}`;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }

  try {
    // ============ حالة النظام ============
    if (route === 'GET /api/status') {
      return json(res, 200, { ok: true, agentCode: AGENT_CODE, currency: CURRENCY, gameApi: GAME_API });
    }

    // ============ قائمة المزودين ============
    if (route === 'GET /api/providers') {
      const r = await game.providerList();
      return json(res, isBlocked(r) ? 403 : 200, {
        ok: r.status === 1, blocked: isBlocked(r), providers: r.providers || [],
        msg: r.msg, hint: isBlocked(r) ? 'IP الخادم غير مضاف للقائمة البيضاء (/app/cloudflare).' : undefined,
      });
    }

    // ============ قائمة ألعاب مزود ============
    if (route === 'GET /api/games') {
      const provider = u.searchParams.get('provider');
      const r = await game.gameList({ providerCode: provider });
      return json(res, isBlocked(r) ? 403 : 200, {
        ok: r.status === 1, blocked: isBlocked(r), games: r.games || [], msg: r.msg,
        hint: isBlocked(r) ? 'IP الخادم غير مضاف للقائمة البيضاء.' : undefined,
      });
    }

    // ============ رصيد لاعب (money_info) — يبدأ 0 ============
    if (route === 'GET /api/user-balance') {
      const userCode = u.searchParams.get('user');
      const r = await game.moneyInfo({ userCode });
      const user = r.user || {};
      return json(res, 200, {
        ok: r.status === 1,
        agentBalance: r.agent ? r.agent.balance : null,
        userCode,
        // لاعب جديد: user={} ⇒ رصيده 0
        userBalance: (user && (user.balance !== undefined ? user.balance : 0)) ?? 0,
        raw: user,
      });
    }

    // ============ إطلاق لعبة ============
    if (route === 'POST /api/launch') {
      const b = await body(req);
      // تحقق من رصيد اللاعب أولاً (لأن المزوّد يرفض الإطلاق برصيد 0)
      const info = await game.moneyInfo({ userCode: b.userCode });
      const u = info.user || {};
      const bal = u.balance !== undefined ? Number(u.balance) : 0;
      const r = await game.launchGame({
        userCode: b.userCode, providerCode: b.providerCode, gameCode: b.gameCode,
        lang: b.lang || 'ar', lobbyUrl: b.lobbyUrl, live: b.live, rtp: b.rtp,
      });
      const needCredit = r.status !== 1 && !isBlocked(r);
      return json(res, isBlocked(r) ? 403 : 200, {
        ok: r.status === 1, blocked: isBlocked(r), launchUrl: r.launch_url, token: r.token,
        msg: r.msg, userBalance: bal,
        needCredit,
        note: r.status === 1
          ? 'اللعبة جاهزة. (في TRANSFER الدوران بالرصيد المودَع.)'
          : 'لا يمكن فتح اللعبة برصيد 0 — يجب أن يضيف الوكيل رصيداً للاعب أولاً.',
        hint: isBlocked(r) ? 'IP غير مضاف للقائمة البيضاء.' : undefined,
      });
    }

    // ============ لوحة الوكيل: إضافة رصيد (user_deposit) ============
    if (route === 'POST /api/admin/credit') {
      const b = await body(req);
      const userCode = b.userCode; const amount = Number(b.amount || 0);
      if (!userCode || amount <= 0) return json(res, 400, { ok: false, error: 'بيانات ناقصة' });
      ledger.createPlayer(userCode, CURRENCY);
      const r = await game.depositUser({ userCode, amount });
      const blocked = isBlocked(r);
      if (r.status === 1) { ledger.deposit(userCode, amount, `dep_${Date.now()}`); ledger.setNexusBalance(userCode, r.user_balance); }
      else ledger.deposit(userCode, 0, `reqfail_${Date.now()}`); // سجل المحاولة
      return json(res, blocked ? 403 : 200, {
        ok: r.status === 1, blocked,
        agentBalance: r.agent_balance, userBalance: r.user_balance, msg: r.msg,
        hint: blocked ? 'IP الخادم غير مضاف للقائمة البيضاء.' : undefined,
      });
    }

    // ============ لوحة الوكيل: سحب / تصفير ============
    if (route === 'POST /api/admin/withdraw') {
      const b = await body(req);
      const r = b.reset
        ? await game.resetUser({ userCode: b.userCode })
        : await game.withdrawUser({ userCode: b.userCode, amount: Number(b.amount || 0) });
      return json(res, isBlocked(r) ? 403 : 200, { ok: r.status === 1, blocked: isBlocked(r), result: r });
    }

    // ============ لوحة الوكيل: قائمة اللاعبين (مدمج: محلي + رصيد Nexus) ============
    if (route === 'GET /api/admin/players') {
      const local = ledger.listPlayers();
      return json(res, 200, { ok: true, players: local });
    }

    // ============ نداء محفظة SEAMLESS (إن بدّل الوكيل للوضع) ============
    if (route === 'POST /api/wallet/callback') {
      const raw = await rawBody(req);
      const sign = req.headers['x-sign'] || '';
      if (!verifyCallbackSignature(raw, sign, AGENT_SECRET, 'md5')) return json(res, 401, { ok: 0, error: 'bad signature' });
      let p = {}; try { p = JSON.parse(raw); } catch { p = Object.fromEntries(new URLSearchParams(raw)); }
      try { const out = ledger.processGameTransaction({ ...p, playerLogin: p.user_code || p.playerLogin }); return json(res, 200, { ok: 1, ...out }); }
      catch (e) { return json(res, 400, { ok: 0, error: e.message, code: e.code }); }
    }

    // ============ فحص سريع للـ IP والقائمة البيضاء ============
    if (route === 'GET /api/health') {
      const [prov, ipResp] = await Promise.all([
        game.providerList(),
        new Promise((resolve) => { http.get('http://ip-api.com/json', (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve({});}}); }).on('error',()=>resolve({})); }),
      ]);
      return json(res, 200, {
        gameApiReachable: prov.status === 1,
        blockedByCloudflare: isBlocked(prov),
        serverIp: ipResp.query,
        action: isBlocked(prov) ? `أضف ${ipResp.query} في لوحة Nexus → /app/cloudflare` : 'كل شيء يعمل ✅',
      });
    }

    // ============ الواجهات ============
    if (route === 'GET /' || route === 'GET /index.html') return serve(res, 'index.html');
    if (route === 'GET /admin' || route === 'GET /admin.html') return serve(res, 'admin.html');
    return json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[server]', err);
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Nexus app on port ${PORT}  (agent=${AGENT_CODE}, currency=${CURRENCY})`);
});
