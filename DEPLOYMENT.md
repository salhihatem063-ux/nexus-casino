# النشر على Render — دليل التشغيل

## الروابط المنشورة
- **واجهة اللاعب:** https://nexus-casino-80ax.onrender.com/
- **لوحة الوكيل:** https://nexus-casino-80ax.onrender.com/admin
- **مستودع الكود:** https://github.com/salhihatem063-ux/nexus-casino
- **لوحة Render:** https://dashboard.render.com/web/srv-dae8pqqd0e5s73fj6m90

## متغيرات البيئة (Render → Environment)
| المفتاح | القيمة |
|---|---|
| `AGENT_CODE` | رمز الوكيل |
| `AGENT_TOKEN` | توكن الوكيل (صفحة البروفايل) |
| `AGENT_SECRET` | المفتاح السري للوكيل |
| `GAME_API` | https://api.nexusggr.dev |
| `OFFICE_API` | https://my.nexusggr.dev |
| `CURRENCY` | UAH |

> الأرقام السرية تُحفظ في Render (مشفّرة) ولا تُكتب في الكود.

## ⚠️ نقطة حرجة: القائمة البيضاء للـ IP
تتطلب منصة Nexus أن يكون **IP خادمك الخلفي** مضافاً في:
**لوحة Nexus → Cloudflare (IP Whitelist)** `/app/cloudflare` عبر `POST /api/whitelist/add`.

- خطة Render المجانية تستخدم **IP صادر مشترك** لكل منطقة. أُضيف IP الخدمة
  الحالي (`74.220.48.219`، منطقة Oregon).
- إذا تغيّر IP (cold restart / توسّع Render) تُحجب النداءات. الحلول:
  1. **Dedicated IP من Render** (3 عناوين ثابتة، مدفوع) وإضافتها للقائمة البيضاء.
  2. أو **QuotaGuard Static** (بروكسي IP ثابت) عبر `QUOTAGUARDSTATIC_URL`.
  3. فحص دوري: زر `/api/health` يُظهر الـ IP ويحذّر إن حُجبت.

## التحقق السريع بعد أي نشر
```bash
curl https://nexus-casino-80ax.onrender.com/api/health
# gameApiReachable:true, blockedByCloudflare:false ← سليم
```

## نظام الحسابات
- **لوحة الوكيل `/admin`** → تنشئ حسابات لاعبين (كود + اسم + كلمة مرور اختيارية).
- كل حساب يُنشأ برصيد **0** في منصة الألعاب (مؤكَّد: `money_info` يرجع `user:{}`).
- من اللوحة: **إضافة رصيد** (`user_deposit` من رصيد الوكيل) أو **سحب مبلغ** أو **سحب الكل** (`user_withdraw` / `user_withdraw_reset`).
- **واجهة اللاعب `/`** → يسجّل الدخول بكود الحساب (وكلمة المرور إن وُجدت)، فيرى كل الألعاب.
- الألعاب **تُفتح برصيد 0** (يتصفّحها)؛ الرهان الفعلي يتطلب رصيداً يضيفه الوكيل.
- الرصيد يُخصم من رصيد الوكيل ويُعاد إليه عند السحب.

> ملاحظة: مسارات الـ API: `/api/agent/accounts` (إنشاء/قائمة)، `/api/agent/deposit`،
> `/api/agent/withdraw`، `/api/player/login`، `/api/player/balance`، `/api/player/launch`.
> (القرص على Render يُمحى عند إعادة النشر، لذا قائمة الحسابات تُعاد من المنصة؛
> للإنتاج الدائم اربط قاعدة بيانات خارجية.)

## ملاحظة قانونية
الحساب `test_demo` تجريبي (`isTest=1`). للأموال الحقيقية يلزم حساب وكيل إنتاجي
مموَّل وترخيص. المقامرة عبر الإنترنت محظورة في تونس — هذا التكامل للأسواق المرخّصة.
