# NEW ERA — backend (نشر تلقائي)

الملفات دي بتتنشر لوحدها، من غير ما حد ينسخ حاجة بإيده:

| الملف | بيتنشر على |
|---|---|
| `Code.gs` + `appsscript.json` | Google Apps Script (الإشعارات، النسخ الاحتياطي، الذكاء الاصطناعي) |
| `firestore.rules` | قواعد Firestore |
| `storage.rules` | قواعد Firebase Storage |

**إزاي:** السكريبت كل 5 دقايق بيقرا `deploy.json`. لو أي رقم فيه زاد عن آخر مرة اتنشرت، بينشر الحاجة دي.
عشان تنشري تعديل: عدّلي الملف، وزوّدي رقمه في `deploy.json` (firestore / storage / script).

**أول مرة بس:**
1. فعّلي Google Apps Script API: https://script.google.com/home/usersettings
2. حطي `Code.gs` و `appsscript.json` في السكريبت (آخر مرة بالإيد)، واختاري `deployNow` ← Run ← وافقي على الصلاحيات.
