# تكامل Nexus GGR — رصيد اللاعب يبدأ 0 وأنتم تضيفون من لوحة التحكم

**الجواب: نعم ✅** — هذا هو نموذج العمل الرسمي للمنصة (وضع **TRANSFER**).
اللاعب يبدأ برصيد **صفر** في الواجهة، وأنتم تضيفون له الرصيد من جانبكم
(وكيل/لوحة تحكم) قبل اللعب. الأموال تُخصم من **رصيد الوكيل (agentBalance)**.

## كيف تعمل الدورة (موثَّقة رسمياً على ggr.gitbook.io)

```
1) اللاعب يفتتح رصيد 0
2) [إدارة] إضافة رصيد:  user_deposit   → من رصيد الوكيل ➜ محفظة اللاعب
3) [لعب]   إطلاق لعبة:  game_launch    ➜ رابط اللعبة في iframe
4) [إنهاء] استرجاع المتبقي: user_withdraw_reset ➜ يعود لرصيد الوكيل
   (أو سحب مبلغ محدد: user_withdraw)
```

| المهمة | method | يخصم من |
|---|---|---|
| إضافة رصيد للاعب | `user_deposit` | رصيد الوكيل |
| سحب من لاعب للوكيل | `user_withdraw` | محفظة اللاعب |
| تصفير/استرجاع الكل | `user_withdraw_reset` | محفظة اللاعب ➜ الوكيل |
| إطلاق لعبة | `game_launch` | (يتطلب رصيد مودَع) |
| قائمة المزودين | `provider_list` | — |
| قائمة الألعاب | `game_list` | — |

## تفاصيل النداء (المصادقة)

- **القاعدة:** `POST https://api.nexusggr.dev/` (تُبنى كـ `api.` + نطاق اللوحة).
- **Content-Type:** `application/json`.
- **المصادقة:** `agent_code` + `agent_token` في الجسم (الـ secretKey لتوقيع نداءات SEAMLESS فقط).
- مثال إيداع:
```json
{
  "method": "user_deposit",
  "agent_code": "test_demo",
  "agent_token": "c454eb12291208a56214ddb439ccffd5",
  "user_code": "player_1",
  "amount": 100.00,
  "agent_sign": "UNIQUE_ID"
}
```
الاستجابة: `{ "status":1, "msg":"SUCCESS", "agent_balance":..., "user_balance":100 }`
خطأ شائع: `INSUFFICIENT_AGENT_FUNDS` (رصيد الوكيل لا يكفي).

## ⛔ الشرط الوحيد المتبقي: القائمة البيضاء للـ IP

اختبرت النداء حيّاً: الـ API يردّ **403 Cloudflare** لأن IP خادم الاختبار
غير مسجَّل. الحل (إلزامي من التوثيق):

1. من خادمك الخلفي شغّل: `curl ifconfig.me` لمعرفة IP الخادم.
2. سجّله في اللوحة: **Cloudflare / IP Whitelist** (`/app/cloudflare`).
3. بعدها تنجح كل النداءات (`user_deposit`, `game_launch`, …).

> ⚠️ لا تستدعِ الـ API من متصفح اللاعب — فقط من خادمك الخلفي (إخفاء الـ token).

## حالة الحساب الحالي

- `isTest = 1` (تجريبي) — الأرقام وهمية. للأموال الحقيقية يلزم حساب إنتاجي
  مموَّل عبر صفحة **Payment** (إيداع عملة رقمية لتمويل رصيد الوكيل).

## الملفات

| الملف | الدور |
|---|---|
| `nexus-client.js` | `OfficeClient` (لوحة تحكم) + `GameClient` (user_deposit/withdraw/reset/game_launch/provider_list) |
| `server.js` | نقاط: `/api/credit` (إضافة رصيد)، `/api/reset`، `/api/providers`، `/api/launch`، `/api/agent-balance` |
| `ledger.js` | سجلّ محلي موازٍ للعرض (في الإنتاج مصدر الحقيقة هو المنصة) |
| `public/index.html` | واجهة عربية |

## ملاحظة قانونية

المقامرة عبر الإنترنت محظورة في تونس؛ هذا التكامل للأسواق المرخّصة فقط،
ويشترط حساباً إنتاجياً وترخيصاً سارياً وإضافة IP الخادم للقائمة البيضاء.
