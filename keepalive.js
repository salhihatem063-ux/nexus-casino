/**
 * keepalive.js — يمنع خدمة Render المجانية من "النوم" بعد 15 دقيقة خمول.
 *
 * خطة Render المجانية توقف الخدمة (spin down) إن لم تصلها أي طلبات HTTP لمدة
 * 15 دقيقة، وتستغرق نحو دقيقة لإعادة الاستيقاظ عند أول طلب تالٍ — وهذا يسبب
 * شعور اللاعبين بأن "الألعاب لا تفتح" أو تتأخر بشكل غريب.
 *
 * الحل: نرسل لأنفسنا (self-ping) طلباً بسيطاً كل 10 دقائق طوال الوقت،
 * فتبقى الخدمة "نشطة" في نظر Render ولا تنام أبداً.
 *
 * الحساب: 10 دقائق تباعد يعني ~144 طلب/يوم — أقل بكثير من أي حد لعدد الطلبات،
 * ويستهلك من حصة الـ 750 ساعة/شهر المجانية بمعدل التشغيل المستمر الطبيعي
 * (30 يوم × 24 ساعة = 720 ساعة < 750 ساعة المتاحة) — أي لا تكلفة إضافية إطلاقاً.
 *
 * ملاحظة: يعمل هذا فقط إن كان السيرفر يستقبل عنوانه العلني الخاص به
 * (SELF_URL)، والذي نضبطه تلقائياً من متغير RENDER_EXTERNAL_URL الذي
 * توفره منصة Render لكل خدماتها تلقائياً.
 */
const PING_INTERVAL_MS = 10 * 60 * 1000; // كل 10 دقائق
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';

function pingOnce() {
  if (!SELF_URL) return;
  const url = `${SELF_URL.replace(/\/$/, '')}/api/status`;
  fetch(url)
    .then((r) => console.log(`[keepalive] ping ${r.status} → ${url}`))
    .catch((e) => console.warn('[keepalive] ping failed:', e.message));
}

function startKeepAlive() {
  if (!SELF_URL) {
    console.warn('[keepalive] RENDER_EXTERNAL_URL/SELF_URL غير مضبوط — تعطيل نظام منع النوم.');
    return;
  }
  console.log(`[keepalive] تفعيل نظام منع النوم كل ${PING_INTERVAL_MS / 60000} دقيقة على ${SELF_URL}`);
  setInterval(pingOnce, PING_INTERVAL_MS);
}

module.exports = { startKeepAlive };
