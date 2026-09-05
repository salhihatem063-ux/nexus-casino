/**
 * ledger.js — سجلّكم المحلي للأرصدة (محفظتكم).
 * يُستخدم في وضع SEAMLESS (نداءات الرهان/الربح) وللعرض المحلي في وضع TRANSFER.
 * في الإنتاج: استبدل التخزين بقاعدة بياناتكم.
 */
const fs = require('fs');
const path = require('path');
const FILE = path.join(__dirname, 'ledger-store.json');

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { players: {} }; } };
const save = (d) => fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function createPlayer(login, currency = 'UAH', balance = 0) {
  const d = load();
  if (!d.players[login]) {
    d.players[login] = { balance, currency, tx: [], nexusBalance: null, createdAt: Date.now() };
    save(d);
  }
  return d.players[login];
}

/** تحديث الرصيد كما يردّه Nexus (user_balance) + ملاحظة */
function setNexusBalance(login, nexusBalance) {
  const d = load();
  if (!d.players[login]) createPlayer(login);
  if (nexusBalance !== undefined && nexusBalance !== null) d.players[login].nexusBalance = nexusBalance;
  save(d);
}

/** قائمة اللاعبين الذين تعاملت معهم لوحتكم */
function listPlayers() {
  const d = load();
  return Object.entries(d.players)
    .map(([code, p]) => ({
      userCode: code,
      currency: p.currency,
      localBalance: p.balance,
      nexusBalance: p.nexusBalance,
      txCount: (p.tx || []).length,
      createdAt: p.createdAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
function getBalance(login) {
  const p = load().players[login];
  return p ? { balance: p.balance, currency: p.currency } : { balance: null };
}
function deposit(login, amount, ref) {
  const d = load();
  const p = d.players[login];
  if (!p) throw new Error('player not found');
  p.balance = r2(p.balance + Number(amount));
  p.tx.push({ id: ref || 'dep_' + Date.now(), type: 'deposit', amount: Number(amount), ts: Date.now() });
  save(d);
  return p.balance;
}

/**
 * نداء المحفظة (SEAMless): type = bet | win | rollback
 * idempotent عبر transactionId.
 */
function processGameTransaction(req) {
  const { transactionId, type, amount, playerLogin, userId, refId, currency } = req;
  const login = playerLogin || userId;
  if (!transactionId || !type || !login) throw new Error('missing required fields');
  const d = load();
  const p = d.players[login];
  if (!p) throw new Error('player not found');
  if (p.tx.some((t) => t.id === transactionId)) return { balance: p.balance, currency: p.currency, duplicated: true };

  const amt = r2(Number(amount || 0));
  switch (type) {
    case 'bet':
      if (p.balance < amt) { const e = new Error('insufficient balance'); e.code = 'INSUFFICIENT_FUNDS'; throw e; }
      p.balance = r2(p.balance - amt);
      break;
    case 'win':
      p.balance = r2(p.balance + amt);
      break;
    case 'rollback': {
      const ref = p.tx.find((t) => t.id === refId);
      if (ref && ref.type === 'bet') p.balance = r2(p.balance + ref.amount);
      break;
    }
    default:
      throw new Error('unknown tx type: ' + type);
  }
  p.tx.push({ id: transactionId, type, amount: amt, refId: refId || null, ts: Date.now() });
  save(d);
  return { balance: p.balance, currency: currency || p.currency, duplicated: false };
}

module.exports = { createPlayer, getBalance, deposit, processGameTransaction, setNexusBalance, listPlayers };
