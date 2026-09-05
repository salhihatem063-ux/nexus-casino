/**
 * currency.js — طبقة تحويل العملة.
 *
 * المبدأ:
 *  • التسوية الداخلية عند المزوّد تكون بعملة الوكيل (SEMITTED currency، غالباً UAH).
 *  • العرض والإدخال يكون بعملة الموقع (DISPLAY currency، افتراضياً TND).
 *  • الأسعار تُجلب من /api/currency في اللوحة (rate لكل عملة مقابل USD).
 *  • إن تعذّر الجلب تُستخدم أسعار احتياطية.
 *
 * التحويل:  amount_in_TO = amount_in_FROM * (rate[TO] / rate[FROM])
 * (rate = عدد الوحدات مقابل 1 USD).
 */

// أسعار احتياطية (مقابل USD) — من جدول /api/currency
const FALLBACK_RATES = {
  USD: 1, EUR: 0.861067, UAH: 44.35, TND: 2.91005, AED: 3.673, GBP: 0.739508,
  SAR: 3.75, MAD: 9.3693, TRY: 48.4357, RUB: 85.825, JPY: 156.245,
};

let rates = { ...FALLBACK_RATES };
let lastUpdate = 0;

const r2 = (n) => Math.round((n + Number.EPSILON) * 100000) / 100000;
const rMoney = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** جلب الأسعار من لوحة التحكم (قد تفشل جلسة الزائر — تُستخدم الاحتياطية) */
async function refreshRates(officeApi) {
  try {
    const res = await fetch(`${officeApi.replace(/\/$/, '')}/api/currency`, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    });
    const data = await res.json();
    if (data && Array.isArray(data.currencies)) {
      const next = { USD: 1 };
      for (const c of data.currencies) {
        const r = parseFloat(c?.config?.rate);
        if (!Number.isNaN(r) && r > 0) next[c.code] = r;
      }
      if (next.TND && next.UAH) { rates = { ...FALLBACK_RATES, ...next }; lastUpdate = Date.now(); }
    }
  } catch {
    /* تبقى الأسعار الاحتياطية */
  }
  return rates;
}

/** سعر التحويل من عملة إلى أخرى */
function rate(from, to) {
  const rf = rates[from] || FALLBACK_RATES[from];
  const rt = rates[to] || FALLBACK_RATES[to];
  if (!rf || !rt) return null;
  return rt / rf;
}

/** حوّل مبلغاً */
function convert(amount, from, to) {
  if (from === to) return rMoney(amount);
  const r = rate(from, to);
  if (r === null) return rMoney(amount);
  return rMoney(r2(Number(amount) * r));
}

/** تنسيق مبلغ للعرض */
function fmt(amount, code) {
  return `${Number(amount || 0).toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

module.exports = { refreshRates, convert, rate, fmt, get rates() { return rates; }, lastUpdate: () => lastUpdate };
