/**
 * server.js — نظام Nexus المتكامل.
 *   واجهة اللاعب /           : تسجيل دخول بحساب + كل الألعاب + تشغيل
 *   لوحة الوكيل /admin       : إنشاء حسابات، إضافة رصيد، سحب، تصفير
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { GameClient } = require('./nexus-client');
const ledger = require('./ledger');

const OFFICE_API = process.env.OFFICE_API || 'https://my.nexusggr.dev';
const GAME_API   = process.env.GAME_API   || 'https://api.nexusggr.dev';
const AGENT_CODE  = process.env.AGENT_CODE  || '';
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_SECRET = process.env.AGENT_SECRET || '';
const CURRENCY = process.env.CURRENCY || 'UAH';
const PORT = process.env.PORT || 3100;

const game = new GameClient({ gameApiBase: GAME_API, agentCode: AGENT_CODE, token: AGENT_TOKEN, secretKey: AGENT_SECRET, currency: CURRENCY });

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${u.pathname}`;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }

  try {
    /* ---------- الحالة ---------- */
    if (route === 'GET /api/status')
      return json(res, 200, { ok: true, agentCode: AGENT_CODE, currency: CURRENCY, gameApi: GAME_API });

    /* ---------- فحص الاتصال والـ IP ---------- */
    if (route === 'GET /api/health') {
      const prov = await game.providerList();
      const ip = await new Promise((resolve) => {
        http.get('http://ip-api.com/json', (r) => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d).query);}catch{resolve(null);}}); }).on('error',()=>resolve(null));
      });
      const blocked = isBlocked(prov);
      return json(res, 200, { gameApiReachable: prov.status === 1, blockedByCloudflare: blocked, serverIp: ip,
        action: blocked ? `أضف ${ip} في لوحة Nexus → /app/cloudflare` : 'كل شيء يعمل ✅' });
    }

    /* ---------- وكلاء الدخول (تستخدمها الواجهة واللوحة) ---------- */

    // قائمة المزودين
    if (route === 'GET /api/providers') {
      const r = await game.providerList();
      return json(res, isBlocked(r) ? 403 : 200, { ok: r.status === 1, blocked: isBlocked(r), providers: r.providers || [], msg: r.msg });
    }
    // قائمة ألعاب مزود
    if (route === 'GET /api/games') {
      const r = await game.gameList({ providerCode: u.searchParams.get('provider') });
      return json(res, isBlocked(r) ? 403 : 200, { ok: r.status === 1, blocked: isBlocked(r), games: r.games || [], msg: r.msg });
    }

    /* ================= لوحة الوكيل ================= */

    // إنشاء حساب لاعب جديد
    if (route === 'POST /api/agent/accounts') {
      const b = await body(req);
      const code = (b.code || '').trim();
      if (!code) return json(res, 400, { ok: false, error: 'كود الحساب مطلوب' });
      const { created, account } = ledger.createAccount(code, { label: b.label, password: b.password, currency: CURRENCY });
      return json(res, 200, { ok: true, created, code: account.code, label: account.label });
    }

    // قائمة الحسابات + رصيد كل حساب من Nexus
    if (route === 'GET /api/agent/accounts') {
      const accs = ledger.listAccounts();
      // جلب رصيد الوكيل
      const info = await game.moneyInfo({});
      const agentBalance = info.agent ? info.agent.balance : null;
      const withBal = [];
      for (const a of accs) {
        let nexusBalance = null;
        try {
          const mi = await game.moneyInfo({ userCode: a.code });
          const u = mi.user || {};
          nexusBalance = u.balance !== undefined ? u.balance : 0;
        } catch { nexusBalance = null; }
        withBal.push({ ...a, nexusBalance });
      }
      return json(res, 200, { ok: true, agentBalance, accounts: withBal });
    }

    // إضافة رصيد (user_deposit) — من رصيد الوكيل
    if (route === 'POST /api/agent/deposit') {
      const b = await body(req);
      const code = (b.code || '').trim(); const amount = Number(b.amount || 0);
      if (!code || amount <= 0) return json(res, 400, { ok: false, error: 'كود الحساب ومبلغ صحيح مطلوبان' });
      if (!ledger.getAccount(code)) ledger.createAccount(code, { currency: CURRENCY });
      const r = await game.depositUser({ userCode: code, amount });
      if (r.status === 1) ledger.logTx(code, 'deposit', amount);
      return json(res, isBlocked(r) ? 403 : 200, {
        ok: r.status === 1, blocked: isBlocked(r), agentBalance: r.agent_balance, userBalance: r.user_balance, msg: r.msg });
    }

    // سحب رصيد (user_withdraw) — يعود لرصيد الوكيل
    if (route === 'POST /api/agent/withdraw') {
      const b = await body(req);
      const code = (b.code || '').trim();
      if (!ledger.getAccount(code)) return json(res, 404, { ok: false, error: 'الحساب غير موجود' });
      let r;
      if (b.all || b.reset) {
        r = await game.resetUser({ userCode: code });
        if (r.status === 1) ledger.logTx(code, 'withdraw_reset', r.user ? r.user.withdraw_amount : 0);
      } else {
        const amount = Number(b.amount || 0);
        if (amount <= 0) return json(res, 400, { ok: false, error: 'مبلغ صحيح مطلوب أو اختر "سحب الكل"' });
        r = await game.withdrawUser({ userCode: code, amount });
        if (r.status === 1) ledger.logTx(code, 'withdraw', amount);
      }
      return json(res, isBlocked(r) ? 403 : 200, {
        ok: r.status === 1, blocked: isBlocked(r), result: r, msg: r.msg });
    }

    /* ================= واجهة اللاعب ================= */

    // دخول اللاعب بالكود
    if (route === 'POST /api/player/login') {
      const b = await body(req);
      const v = ledger.verifyLogin((b.code || '').trim(), b.password || '');
      return json(res, v.ok ? 200 : 404, v.ok ? { ok: true, code: v.account.code, label: v.account.label } : { ok: false, error: v.reason });
    }

    // رصيد اللاعب الحالي (من Nexus)
    if (route === 'GET /api/player/balance') {
      const code = u.searchParams.get('code');
      if (!code) return json(res, 400, { ok: false, error: 'كود الحساب مطلوب' });
      const r = await game.moneyInfo({ userCode: code });
      const usr = r.user || {};
      return json(res, 200, { ok: true, code, agentBalance: r.agent ? r.agent.balance : null, balance: usr.balance !== undefined ? usr.balance : 0 });
    }

    // إطلاق لعبة
    if (route === 'POST /api/player/launch') {
      const b = await body(req);
      const code = (b.code || '').trim();
      if (!ledger.getAccount(code)) return json(res, 404, { ok: false, error: 'الحساب غير موجود — أنشئه من لوحة الوكيل أولاً.' });
      const info = await game.moneyInfo({ userCode: code });
      const usr = info.user || {}; const bal = usr.balance !== undefined ? Number(usr.balance) : 0;
      const r = await game.launchGame({
        userCode: code, providerCode: b.providerCode, gameCode: b.gameCode,
        lang: b.lang || 'ar', lobbyUrl: b.lobbyUrl, live: b.live, rtp: b.rtp });
      const blocked = isBlocked(r);
      return json(res, blocked ? 403 : 200, {
        ok: r.status === 1, blocked, launchUrl: r.launch_url, token: r.token, balance: bal, msg: r.msg,
        note: r.status === 1
          ? (bal > 0 ? 'اللعبة جاهزة والرصيد متاح للرهان.' : 'اللعبة فتُحت برصيد 0 — للرهان بأموال اطلب من الوكيل إضافة رصيد.')
          : 'تعذّر فتح اللعبة: ' + (r.msg || '') });
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

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Nexus app on port ${PORT} (agent=${AGENT_CODE || '(env?)'}, currency=${CURRENCY})`));
