/**
 * إشعارات تيليجرام التلقائية + النسخ الاحتياطي — نيو إيرا لطب الأسنان
 * بيشتغل على سيرفرات جوجل، من غير ما أي جهاز يكون فاتح السيستم.
 *
 * كل 5 دقايق: حجز أونلاين جديد، كنسل/تأجيل، تعديل ميعاد
 * كل ساعة:     تذكير المعامل، مواعيد متابعة المرضى
 * كل يوم 9 الصبح: ملخص كل فرع + جدول المواعيد (للإدارة/الفروع/الأدمنز، وكل دكتور جدوله)
 * الرسايل المخصصة اللي الأدمن بيعملها من السيستم (في ميعادها)
 * الاستشارات الأونلاين: بتتبعت للدكتور على تيليجرام، ورده (Reply) بيتسجل ويوصل للمريض
 * كل يوم 3 الفجر: نسخة احتياطية كاملة لقاعدة البيانات في جوجل درايف (آخر 30 نسخة)
 * قراءة فواتير المخزن بالذكاء الاصطناعي (محتاجة Deploy كـ Web app مرة واحدة — التفاصيل تحت عند doPost)
 *
 * بيستخدم نفس إعدادات تيليجرام ونفس قوالب الرسائل والصلاحيات اللي في السيستم،
 * ونفس العلامات، فمفيش رسالة بتتبعت مرتين حتى لو السيستم مفتوح.
 *
 * أول مرة: اختاري الدالة setup من فوق ودوسي Run.
 *
 * النشر التلقائي: الملف ده + appsscript.json + قواعد Firebase (firestore.rules / storage.rules)
 * متخزنين على GitHub في NewEra/backend. كل 5 دقايق السكريبت بيبص على backend/deploy.json،
 * ولو فيه رقم أكبر من اللي اتنشر، بيحدّث نفسه وينشر القواعد على Firebase لوحده.
 * أول مرة بس: فعّلي Google Apps Script API من https://script.google.com/home/usersettings
 * وبعدين اختاري الدالة deployNow ودوسي Run ووافقي على الصلاحيات.
 */

const PROJECT_ID = 'new-era-dental-center';
const TZ = 'Africa/Cairo';
const DIGEST_HOUR = 9;       // الافتراضي بس — كل شخص ليه ساعته من السيستم: الإعدادات ← تيليجرام
const SHORT_HOUR = 21;       // الافتراضي لرسالة النواقص المجمّعة
const BACKUP_HOUR = 3;       // ساعة النسخة الاحتياطية اليومية
const BACKUP_KEEP = 30;      // عدد النسخ اللي بتفضل في درايف
const BACKUP_FOLDER = 'نسخ نيو إيرا الاحتياطية';

const ROOT = 'projects/' + PROJECT_ID + '/databases/(default)/documents';
const BASE = 'https://firestore.googleapis.com/v1/' + ROOT;

const DAY_NAMES = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DEFAULT_ROUTES = { main: ['booking', 'online', 'unsched', 'cancel', 'follow', 'lab', 'shortage', 'due', 'schedule', 'reschedule', 'consult'], branch: ['booking', 'online', 'unsched', 'cancel', 'follow', 'lab', 'shortage', 'digest', 'reschedule'] };
const OLD_KINDS = ['booking', 'online', 'cancel', 'follow', 'lab', 'shortage', 'due', 'digest'];
const PERSON_DEFAULT_DOCTOR = ['booking', 'online', 'cancel', 'reschedule', 'schedule'];
const DOCTOR_OWN_KINDS = ['booking', 'online', 'cancel', 'reschedule', 'follow', 'consult'];
const TPL_DEFAULT = {
  tgLab: '⏰ حالة معمل مر عليها {days} — اطلبيها من المعمل\nالمعمل: {lab}\nالمريض: {patient}\nالنوع: {case}\nالفرع: {branch}',
  tgFollow: '📞 موعد متابعة مريض: {patient}\nالخدمة: {service}\nالفرع: {branch}',
  tgOnline: '🌐 حجز أونلاين جديد — فرع {branch}\nالمريض: {patient}\nالموبايل: {phone}\nالموعد: {date} {time}\nالخدمة: {service}\nالدكتور: {doctor}\nكود الحجز: {code}\n\n📊 إجمالي حجوزات {date} في {branch}: {count}',
  tgApp: '📅 حجز جديد — فرع {branch}\nالمريض: {patient}\nالموعد: {date} {time}\nالخدمة: {service}\nالدكتور: {doctor}\nبواسطة: {by}\n\n📊 إجمالي حجوزات {date} في {branch}: {count}',
  tgShortage: '⚠️ نقص جديد — {branch}\nالصنف: {item} ({qty})\nبواسطة: {by}\n\n📊 إجمالي النواقص في {branch}: {count}',
  tgDue: '🧾 فاتورة جديدة — {branch}\nالجهة: {party}\nالمبلغ: {amount} ج\nموعد السداد: {due}\nبواسطة: {by}\n\n📊 إجمالي المستحق في {branch}: {sum} ج ({count} فاتورة)',
  tgUnsched: '⚠️ حجز أونلاين محتاج تظبيط ميعاد — فرع {branch}\nالمريض: {patient}\nالموبايل: {phone}\nاليوم اللي عاوزه: {date} {time}\nالخدمة: {service}\nكود الحجز: {code}\n\nمفيش دكتور مناسب فاضي في الميعاد ده — كلّموه ظبّطوا معاه ميعاد وشجّعوه ييجي 🙏',
  tgShortDaily: '🛒 نواقص {branch} — {date}\n{count} صنف محتاجين يتشتروا:\n{list}',
  tgCancel: '❌ {kind} — فرع {branch}\nالمريض: {patient}\nالموبايل: {phone}\nالموعد كان: {date} {time}\nالخدمة: {service}\nالدكتور: {doctor}\n📞 لو مفيش ميعاد جديد بيتسجل في سجل المتابعات',
  tgResched: '🔄 تعديل ميعاد حجز — فرع {branch}\nالمريض: {patient}\nالموبايل: {phone}\nكان: {oldDate} {oldTime} — {oldDoctor}\nبقى: {date} {time} — {doctor}\nبواسطة: {by}',
  tgSchedHead: '🗓️ مواعيد النهاردة — فرع {branch}\n{date} • {count} حجز {canceled}',
  tgSchedDoctor: '👨‍⚕️ {doctor} ({count})',
  tgSchedLine: '• {time} — {patient} — {service} — {phone} {status} {online}',
  tgSchedEmpty: '🗓️ فرع {branch} — {date}\nمفيش حجوزات النهاردة. {canceled}',
  tgDocSchedHead: '🗓️ مواعيدك النهاردة يا د. {doctor}\n{date} • {count} حجز',
  tgDocSchedLine: '• {time} — {patient} — {service} {online}',
  tgDocSchedEmpty: '🗓️ د. {doctor} — {date}\nمفيش حجوزات ليك النهاردة.',
  tgConsult: '💬 استشارة أونلاين جديدة #{code}\nالمريض: {patient}\nالموبايل: {phone}\nالفرع: {branch}\nالموضوع: {topic}\nلـ: {doctor}\n\n❓ {question}\n\n↩️ اعمل Reply على الرسالة دي واكتب ردك، وهيوصل للمريض.',
  tgConsultReply: '✅ اترد على الاستشارة #{code}\nالمريض: {patient}\nرد {by}:\n{reply}',
  tgDigest: '☀️ صباح الخير — ملخص فرع {branch}\n{date}\n\n📅 حجوزات النهاردة: {today} (أونلاين: {online})\n❓ حجوزات بكرة لسه مش مؤكدة: {tomorrow}\n📞 متابعات مستحقة: {follow}\n⏰ حالات معمل محتاجة تتطلب: {lab}\n⚠️ نواقص مفتوحة: {short}'
};
const APP_ST_TXT = { no_show: '🚫 محضرش', unconfirmed: '❓ مش مؤكد', booked: '❓ مش مؤكد', no_answer: '📵 لم يرد', confirmed: '✅ مؤكد', on_way: '🚗 في الطريق', arrived: '🟢 حضر', done: '✔️ خلص', postponed: '⏸ مؤجل' };

/* ================= التشغيل ================= */

// شغّليها مرة واحدة بس: بتعمل التشغيل التلقائي وتبعت رسالة تجربة وتعمل أول نسخة احتياطية
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('every5min').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('dailyBackup').timeBased().atHour(BACKUP_HOUR).everyDays(1).inTimezone(TZ).create();
  const cfg = tgConfig_();
  if (!cfg.token) throw new Error('مفيش توكن تيليجرام محفوظ — حطيه من السيستم: الإعدادات ← تيليجرام');
  const branches = list_('branches');
  if (cfg.main) post_(cfg, cfg.main, '✅ الإشعارات التلقائية والنسخ الاحتياطي اشتغلوا من سيرفرات جوجل.\nالفروع: ' + branches.map(b => b.name).join('، '));
  const f = backupNow();
  Logger.log('تمام ✓ — الإشعارات كل 5 دقايق، والنسخة الاحتياطية كل يوم الساعة ' + BACKUP_HOUR + '. أول نسخة: ' + f);
}

// لو عايزة توقفي كل حاجة
function stop() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('اتوقف ✓');
}

function every5min() {
  try { autoDeploy_(false); } catch (e) { Logger.log('deploy: ' + e); }
  const cfg = tgConfig_();
  if (!cfg.token) return;
  let ctx0 = null;
  const C = () => ctx0 = ctx0 || ctx_(cfg); // الفروع والقوالب بتتقرا بس لو فيه حاجة هتتبعت (ومحفوظة نص ساعة)

  // بنبعت بس اللي اتعمل بعد ما السكريبت ده اشتغل أول مرة (عشان ميبعتش حاجات قديمة)
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('srvStart')) props.setProperty('srvStart', new Date().toISOString());
  const start = props.getProperty('srvStart'), fresh = x => (x || '') >= start;

  // ===== توفير القراءات: بنسأل بس عن اللي اتغير من آخر مرة (من غير جديد = قراءة واحدة بس) =====
  // 15 دقيقة زيادة احتياطي لو ساعة موبايل حد متأخرة — والعلامة tgSent بتمنع التكرار
  const runAt = new Date().toISOString();
  const last = props.getProperty('wm') || new Date(Date.now() - 30 * 6e4).toISOString();
  const since = new Date(Date.parse(last) - 15 * 6e4).toISOString();

  // 1) حجز جديد: أونلاين، أو من السكرتارية (كل شخص حسب مواعيده: مع كل حجز / بعد جدول يومه)
  query_('appointments', [['createdAt', '>=', since]]).forEach(a => {
    if (a.tgSent) return;
    const ctx = C();
    if (a.source !== 'online') {
      if (!fresh(a.createdAt) || !claim_(a, { tgSent: true })) return;
      const same = query_('appointments', [['date', '==', a.date]]).filter(x => x.status !== 'canceled');
      send_(ctx, fill_(ctx.T.tgApp, { patient: a.patientName, date: a.date, time: a.time || '', service: a.service || '', doctor: a.doctorName || '', branch: ctx.bOf(a.branchId).name, by: a.recordedBy || '', count: same.filter(x => x.branchId === a.branchId).length, countAll: same.length }), a.branchId, 'booking', [a.doctorId], { date: a.date });
      return;
    }
    if (!claim_(a, { tgSent: true })) return;
    if (a.needsSchedule) { send_(ctx, fill_(ctx.T.tgUnsched, { patient: a.patientName, phone: a.phone || '', date: a.date, time: a.time || '', service: a.service || '', code: a.bookingCode || '', branch: ctx.bOf(a.branchId).name }), a.branchId, 'unsched', []); return; }
    const count = query_('appointments', [['date', '==', a.date]]).filter(x => x.branchId === a.branchId && x.status !== 'canceled').length;
    send_(ctx, fill_(ctx.T.tgOnline, { patient: a.patientName, phone: a.phone || '', date: a.date, time: a.time || '', service: a.service || '', doctor: a.doctorName || '', code: a.bookingCode || '', branch: ctx.bOf(a.branchId).name, count }), a.branchId, 'online', [a.doctorId]);
  });

  // 2) كنسل / تأجيل
  const changed = {};
  query_('appointments', [['statusChangedAt', '>=', since]]).concat(query_('appointments', [['canceledAt', '>=', since]])).forEach(a => { changed[a._id] = a; });
  Object.keys(changed).map(k => changed[k]).forEach(a => {
    if (!(a.status === 'canceled' || a.status === 'postponed') || a.tgCancelSent) return;
    if (!claim_(a, { tgCancelSent: true })) return;
    const ctx = C();
    const kind = a.status === 'canceled' ? (a.canceledBy === 'patient' ? 'المريض لغى الحجز أونلاين' : 'كنسل') : (a.postponedTo ? 'أجّل لميعاد جديد (' + a.postponedTo + ')' : 'أجّل من غير ميعاد');
    send_(ctx, fill_(ctx.T.tgCancel, { kind, patient: a.patientName, phone: a.phone || '', date: a.date, time: a.time || '', service: a.service || '', doctor: a.doctorName || '', branch: ctx.bOf(a.branchId).name }), a.branchId, 'cancel', [a.doctorId]);
  });

  // 3) تعديل ميعاد حجز
  query_('appointments', [['rescheduledAt', '>=', since]]).forEach(a => {
    if (a.tgReschedAt === a.rescheduledAt) return;
    if (!claim_(a, { tgReschedAt: a.rescheduledAt })) return;
    const ctx = C(), dn = n => n ? 'د. ' + n : 'بدون دكتور';
    send_(ctx, fill_(ctx.T.tgResched, { patient: a.patientName, phone: a.phone || '', oldDate: a.prevDate || '', oldTime: a.prevTime || '', oldDoctor: dn(a.prevDoctorName), date: a.date, time: a.time || '', doctor: dn(a.doctorName), branch: ctx.bOf(a.branchId).name, by: a.rescheduledBy === 'patient' ? 'المريض أونلاين' : (a.rescheduledBy || '') }),
      a.branchId, 'reschedule', [a.doctorId, a.prevDoctorId !== a.doctorId ? a.prevDoctorId : null]);
  });

  // 3ب) الاستشارات: الجديدة تتبعت، والردود من تيليجرام تتسجل
  consults_(cfg, C, since);

  props.setProperty('wm', runAt);

  // 4) مرة واحدة الصبح: المعامل + المتابعات + المهام + الفواتير الجديدة + تنضيف سلة المحذوفات
  try { daily_(C, fresh); } catch (e) { Logger.log('daily: ' + e); }

  // 4ب) الرسايل المخصصة (إعداداتها محفوظة نص ساعة، والبيانات بتتقرا بس وقت ما رسالة تتبعت)
  customMsgs_(C);

  // 5) الرسايل المجمّعة: جدول المواعيد والملخص الصبح، والنواقص مرة في اليوم في ميعادها
  digests_(C);
}

// مرة واحدة في اليوم، بعد ميعاد جدول الصبح
function daily_(C, fresh) {
  const props = PropertiesService.getScriptProperties(), today = day_(0);
  if (props.getProperty('lastDaily') === today) return;
  const T = templates_();
  if (nowHour_() < T._times.sched) return;
  const prev = props.getProperty('lastDailyAt') || new Date(Date.now() - 864e5).toISOString();
  props.setProperty('lastDaily', today); props.setProperty('lastDailyAt', new Date().toISOString());
  const ctx = C();
  hourly_(ctx);
  try { tasks_(ctx, fresh); } catch (e) { Logger.log('tasks: ' + e); }
  query_('dues', [['createdAt', '>=', prev]]).forEach(x => {
    if (x.tgSent || !fresh(x.createdAt) || !claim_(x, { tgSent: true })) return;
    const unpaid = query_('dues', [['paid', '==', false]]), br = unpaid.filter(y => y.branchId === x.branchId), sum = a => Math.round(a.reduce((t, y) => t + (Number(y.amount) || 0), 0) * 100) / 100;
    send_(ctx, fill_(ctx.T.tgDue, { party: x.party, amount: x.amount, due: x.dueDate || 'بدون موعد', branch: x.branchId === 'store' ? 'المخزن' : ctx.bOf(x.branchId).name, by: x.recordedBy || '', sum: sum(br), count: br.length, sumAll: sum(unpaid), countAll: unpaid.length }), x.branchId, 'due', []);
  });
}

function hourly_(ctx) {
  const today = day_(0);
  // سلة المحذوفات: اللي عدّى عليه 30 يوم بيتمسح نهائي
  try {
    const old = query_('trash', [['deletedAt', '<', new Date(Date.now() - 30 * 864e5).toISOString()]]).slice(0, 300);
    if (old.length) api_('post', BASE + ':commit', { writes: old.map(d => ({ delete: d._name })) });
  } catch (e) { Logger.log('trash purge: ' + e); }
  query_('lab_cases', [['sentDate', '>=', day_(-90)]]).forEach(c => {
    if (c.remindSent || !labDue_(c, today)) return;
    if (!claim_(c, { remindSent: true })) return;
    send_(ctx, fill_(ctx.T.tgLab, { days: daysLabel_(remindDays_(c)), lab: c.labName, patient: c.patientName, case: c.caseType, branch: ctx.bOf(c.branchId).name }), c.branchId, 'lab', []);
  });
  query_('followups', [['followUpDate', '>=', day_(-30)], ['followUpDate', '<=', today]]).forEach(p => {
    if (p.followedAt || p.followRemind) return;
    if (!claim_(p, { followRemind: true })) return;
    const svc = (p.services && p.services.length) ? p.services.join('، ') : (p.service || '');
    send_(ctx, fill_(ctx.T.tgFollow, { patient: p.name, service: svc, branch: ctx.bOf(p.branchId).name }), p.branchId, 'follow', [p.doctorId]);
  });
}

const DIGEST_WINDOW_H = 4; // لو الميعاد فات بأكتر من 4 ساعات (السكريبت كان واقف) مش بيتبعت متأخر

function inWin_(h, at) { return h >= at && h < at + DIGEST_WINDOW_H; }
function nowHour_() { return Number(Utilities.formatDate(new Date(), TZ, 'H')); }

function digests_(C) {
  const cfg0 = tgConfig_(), T0 = templates_();
  const h = nowHour_(), today = day_(0), def = T0._times;
  // بسرعة: لو محدش ميعاده دلوقتي، منقراش أي بيانات
  const raws = [cfg0.mainCfg || {}, {}].concat(Object.keys(cfg0.branchCfg || {}).map(k => cfg0.branchCfg[k] || {}), Object.keys(cfg0.people).map(k => cfg0.people[k] || {}));
  if (!raws.some(o => { const t = timing_(o, def); return inWin_(h, t.schedHour) || inWin_(h, t.shortHour); })) return;
  const props = PropertiesService.getScriptProperties();
  // لو كل اللي ميعادهم دلوقتي استلموا خلاص النهاردة، منقراش حاجة
  const ctx = C(), c = ctx.cfg, T = ctx.T;
  const pend = recipients_(ctx).filter(r => (inWin_(h, r.schedHour) && (props.getProperty('dg_sched_' + r.key) !== today || props.getProperty('dg_digest_' + r.key) !== today)) || (inWin_(h, r.shortHour) && props.getProperty('dg_shorts_' + r.key) !== today));
  if (!pend.length) return;
  // كل جزء بيتقرا بس لو هيتبعت
  const D = {};
  const shortCounts = () => JSON.parse(props.getProperty('shortCounts') || '{}'); // عدد النواقص من آخر رسالة نواقص (عشان الملخص ميقراش النواقص تاني)
  const data = {
    get apps() { return D.apps = D.apps || query_('appointments', [['date', '>=', today], ['date', '<=', day_(1)]]); },
    get pats() { return D.pats = D.pats || query_('followups', [['followUpDate', '>=', day_(-60)], ['followUpDate', '<=', today]]); },
    get labs() { return D.labs = D.labs || query_('lab_cases', [['sentDate', '>=', day_(-90)]]); },
    get shorts() {
      if (!D.shorts) { D.shorts = list_('shortages'); const cnt = {}; D.shorts.forEach(x => { cnt[x.branchId] = (cnt[x.branchId] || 0) + 1; }); props.setProperty('shortCounts', JSON.stringify(cnt)); }
      return D.shorts;
    },
    get inv() { return D.inv = D.inv || list_('inv_items'); },
    get tools() { return D.tools = D.tools || list_('inv_tools'); },
    shortCount: id => D.shorts ? D.shorts.filter(x => x.branchId === id).length : (shortCounts()[id] || 0)
  };
  const once = (what, r) => { const pk = 'dg_' + what + '_' + r.key; if (props.getProperty(pk) === today) return false; props.setProperty(pk, today); return createOnce_('tg_log/' + what + '_' + r.key + '_' + today); };
  pend.forEach(r => {
    const scope = scope_(ctx, r), msgs = [];
    if (inWin_(h, r.schedHour)) {
      if (r.kinds.indexOf('schedule') >= 0 && r.schedMode !== 'instant' && on_(c, 'schedule') && once('sched', r)) schedFor_(ctx, r, scope, data, today).forEach(m => msgs.push(m));
      if (r.kinds.indexOf('digest') >= 0 && on_(c, 'digest') && once('digest', r)) scope.forEach(b => msgs.push(digestText_(ctx, b, data, today)));
    }
    if (inWin_(h, r.shortHour) && r.kinds.indexOf('shortage') >= 0 && on_(c, 'shortage') && T._deleted.indexOf('tgShortDaily') < 0 && once('shorts', r)) {
      const sc = (r.type === 'main' || r.type === 'admin') ? scope.concat([{ _id: 'store', name: 'المخزن' }]) : scope;
      sc.forEach(b => { const list = data.shorts.filter(x => x.branchId === b._id); if (list.length) msgs.push(shortText_(ctx, b, list, today)); });
      if (r.type === 'main' || r.type === 'admin') { const m = lowStockText_(data, today); if (m) msgs.push(m); }
    }
    msgs.forEach(m => post_(c, String(r.chat), m));
  });
}

// الفروع اللي تخص الشخص: الإدارة/الأدمن = كل الفروع، جروب الفرع/السكرتيرة = فرعها، الدكتور = فروعه
function scope_(ctx, r) {
  if (r.type === 'group') return ctx.branches.filter(b => b._id === r.branch);
  if (r.brs) return ctx.branches.filter(b => r.brs.indexOf(b._id) >= 0);
  if (r.type === 'doctor') { const ids = doctorBranchIds_(r.st, ctx.branches); return ctx.branches.filter(b => ids.indexOf(b._id) >= 0); }
  return ctx.branches;
}

function schedFor_(ctx, r, scope, d, today) {
  const c = ctx.cfg;
  if (r.type === 'doctor') {
    if (c.noDocSched) return [];
    if (c.quiet.doctor && !hasSched_(d.apps, a => a.doctorId === r.key, today)) return [];
    return [doctorScheduleMessage_(ctx, r.key, r.name || '', d.apps, today)];
  }
  if (c.noSched) return [];
  const out = [];
  scope.filter(b => !c.quiet.branch || hasSched_(d.apps, a => a.branchId === b._id, today)).forEach(b => scheduleMessages_(ctx, b, d.apps, today).forEach(m => out.push(m)));
  return out;
}

function digestText_(ctx, b, d, today) {
  const tmr = day_(1), mine = x => x.branchId === b._id;
  const todays = d.apps.filter(a => mine(a) && a.date === today && a.status !== 'canceled');
  return fill_(ctx.T.tgDigest, {
    branch: b.name, date: dayTxt_(today), today: todays.length, online: todays.filter(a => a.source === 'online').length,
    tomorrow: d.apps.filter(a => mine(a) && a.date === tmr && (!a.status || a.status === 'unconfirmed' || a.status === 'booked' || a.status === 'no_answer')).length,
    follow: d.pats.filter(p => mine(p) && !p.followedAt).length,
    lab: d.labs.filter(x => mine(x) && labDue_(x, today)).length,
    short: d.shortCount ? d.shortCount(b._id) : d.shorts.filter(mine).length
  });
}

function shortText_(ctx, b, list, today) {
  return fill_(ctx.T.tgShortDaily, {
    branch: b._id === 'store' ? 'المخزن' : 'فرع ' + b.name, date: dayTxt_(today), count: list.length,
    list: list.map(x => '• ' + x.itemName + (x.quantity ? ' — ' + x.quantity : '') + (x.requestedBy ? ' (' + x.requestedBy + ')' : '')).join('\n')
  });
}

// المخزن: الأصناف اللي وصلت للحد الأدنى + الأجهزة اللي صيانتها قربت (بيتبعت مع ملخص النواقص للإدارة/الأدمن)
function lowStockText_(d, today) {
  const n = v => Number(v) || 0, q = v => String(Math.round(n(v) * 100) / 100);
  const low = (d.inv || []).filter(i => n(i.minQty) > 0 && n(i.stock) <= n(i.minQty)).sort((a, b) => n(a.stock) - n(b.stock));
  const soon = day_(7), tools = (d.tools || []).filter(t => t.nextMaint && t.status !== 'مستبعد' && t.nextMaint <= soon);
  if (!low.length && !tools.length) return '';
  const out = ['📦 المخزن — ' + dayTxt_(today) + ''];
  if (low.length) {
    out.push('', '⚠️ ' + low.length + ' صنف وصل للحد الأدنى:');
    low.slice(0, 40).forEach(i => out.push('• ' + i.name + ' — الموجود ' + q(i.stock) + (i.unit ? ' ' + i.unit : '') + ' (الحد ' + q(i.minQty) + ')' + (n(i.stock) <= 0 ? ' ⛔ خلصان' : '')));
    if (low.length > 40) out.push('... و' + (low.length - 40) + ' صنف كمان');
  }
  if (tools.length) {
    out.push('', '🔧 صيانة مستحقة:');
    tools.forEach(t => out.push('• ' + t.name + ' — ' + t.nextMaint + (t.nextMaint < today ? ' (فاتت!)' : '')));
  }
  return out.join('\n');
}

/* ================= المهام ================= */
// شات الشخص لو المهام شغالة عنده (من جدول "مين يوصله إيه") ومش موقوف
function taskChat_(ctx, staffId) {
  const per = ctx.cfg.people[staffId];
  if (!per || !per.chat || per.paused) return '';
  if (ctx.cfg.tasksV1 && (per.kinds || []).indexOf('task') < 0) return '';
  return String(per.chat);
}
function taskDue_(due) {
  if (!due) return 'بدون ميعاد';
  const p = due.split('T'), d = p[0], t = p[1], today = day_(0);
  const dl = d === today ? 'النهاردة' : d === day_(1) ? 'بكرة' : dayTxt_(d);
  if (!t) return dl;
  const h = Number(t.slice(0, 2)), m = t.slice(3, 5);
  return dl + ' الساعة ' + ((h % 12) || 12) + ':' + m + (h < 12 ? ' ص' : ' م');
}
function tasks_(ctx, fresh) {
  const nowL = day_(0) + 'T23:59'; // بتشتغل مرة الصبح: بتفكّر بكل اللي ميعاده النهاردة
  query_('tasks', [['status', '==', 'open']]).forEach(t => {
    const to = (t.assignees || [])[0];
    // مهمة جديدة
    if (!t.notifiedAt && fresh(t.createdAt)) {
      if (claim_(t, { notifiedAt: new Date().toISOString() })) {
        const ch = taskChat_(ctx, to);
        if (ch) post_(ctx.cfg, ch, '📝 مهمة جديدة' + (t.priority === 'high' ? ' 🔴 مهم' : '') + '\n' + t.title + (t.details ? '\n\n' + t.details : '') + '\n\n⏰ ' + taskDue_(t.due) + (t.repeat === 'daily' ? ' (كل يوم)' : t.repeat === 'weekly' ? ' (كل أسبوع)' : '') + '\nمن: ' + (t.createdRole === 'doctor' ? 'د. ' : '') + (t.createdBy || '') + '\n\n✅ لما تخلّصيها علّمي عليها من السيستم ← المهام');
      }
      return;
    }
    // جه ميعادها
    if (t.due && t.remindedFor !== t.due) {
      const dueAt = t.due.indexOf('T') > 0 ? t.due : t.due + 'T09:00';
      if (dueAt <= nowL && claim_(t, { remindedFor: t.due })) {
        const ch = taskChat_(ctx, to);
        if (ch) post_(ctx.cfg, ch, '⏰ تذكير بمهمة' + (t.priority === 'high' ? ' 🔴' : '') + '\n' + t.title + (t.details ? '\n' + t.details : '') + '\n\nلما تخلّصيها علّمي عليها من السيستم ← المهام');
      }
    }
    // مهمة بتتكرر واتعملت مرة كمان ← للي بعتها
    const n = (t.history || []).length;
    if (t.repeat && t.repeat !== 'none' && n > Number(t.doneCount || 0) && claim_(t, { doneCount: n })) {
      const h = t.history[n - 1] || {}, ch = taskChat_(ctx, t.createdById);
      if (ch) post_(ctx.cfg, ch, '✅ ' + (h.by || t.assigneeName || '') + ' عملت: ' + t.title + (h.note ? '\n💬 ' + h.note : ''));
    }
  });
  // خلصت ← للي بعتها
  query_('tasks', [['status', '==', 'done'], ['doneNotified', '==', false]]).forEach(t => {
    if (!claim_(t, { doneNotified: true })) return;
    const ch = taskChat_(ctx, t.createdById);
    if (ch) post_(ctx.cfg, ch, '✅ المهمة خلصت\n' + t.title + '\nخلّصتها: ' + (t.doneBy || t.assigneeName || '') + (t.doneNote ? '\n💬 ' + t.doneNote : ''));
  });
}

/* ================= الرسايل المخصصة ================= */

const CM_COUNT_VARS = ['حجوزات_النهاردة', 'حجوزات_بكرة', 'غير_مؤكد_بكرة', 'أونلاين_النهاردة', 'كنسل_النهاردة', 'متابعات_مستحقة', 'معامل_متأخرة', 'نواقص'];
const CM_WINDOW_MIN = 180;

function customMsgs_(C) {
  const doc = cached_('cfg_cm', 1800, () => get_('private_config/custom_msgs'));
  const list = (doc && doc.list) || [];
  const now = new Date(), today = day_(0);
  const dow = Number(Utilities.formatDate(now, TZ, 'u')) % 7;
  const mins = Number(Utilities.formatDate(now, TZ, 'H')) * 60 + Number(Utilities.formatDate(now, TZ, 'm'));
  const due = list.filter(m => {
    if (!m || !m.on || !String(m.text || '').trim() || !m.time) return false;
    if (m.when === 'weekly' && (m.days || []).indexOf(dow) < 0) return false;
    if (m.when === 'once' && m.date !== today) return false;
    const p = m.time.split(':').map(Number), at = p[0] * 60 + (p[1] || 0);
    return mins >= at && mins < at + CM_WINDOW_MIN;
  });
  if (!due.length) return;
  const ctx = C();
  let data = null;
  due.forEach(m => {
    if (!createOnce_('tg_log/custom_' + m.id + '_' + today)) return;
    data = data || {
      apps: query_('appointments', [['date', '>=', today], ['date', '<=', day_(1)]]),
      patients: query_('followups', [['followUpDate', '>=', day_(-60)], ['followUpDate', '<=', today]]),
      labs: query_('lab_cases', [['sentDate', '>=', day_(-90)]]),
      shortages: list_('shortages')
    };
    cmRecipients_(m, ctx).forEach(r => {
      const vals = cmValues_(r, ctx, data, today, day_(1));
      if (m.skipZero && CM_COUNT_VARS.indexOf(m.skipZero) >= 0 && !Number(vals[m.skipZero])) return;
      post_(ctx.cfg, String(r.chat), String(m.text).replace(/\{([^{}]+)\}/g, (all, k) => { k = k.trim().replace(/\s+/g, '_'); return vals[k] === undefined ? all : String(vals[k]); }));
    });
  });
}

function cmRecipients_(m, ctx) {
  const cfg = ctx.cfg, allB = ctx.branches.map(b => b._id);
  const scope = (m.branchIds && m.branchIds.length) ? m.branchIds.filter(id => allB.indexOf(id) >= 0) : allB;
  const out = [], to = m.to || {};
  if (to.main && cfg.main && !(cfg.mainCfg && cfg.mainCfg.paused)) out.push({ chat: cfg.main, branchIds: scope });
  if (to.branches) scope.forEach(id => { const b = ctx.bOf(id); const c = cfg.branches[id] || (b.name && cfg.branches[b.name]); if (c && !((cfg.branchCfg || {})[id] || {}).paused) out.push({ chat: c, branchIds: [id] }); });
  Object.keys(cfg.people).forEach(k => {
    const per = cfg.people[k];
    if (!per || !per.chat || per.paused) return;
    const st = ctx.staff().find(x => x._id === k);
    if (to.admins && (per.manual || (st && (st.role === 'admin' || st.role === 'superadmin')))) out.push({ chat: per.chat, branchIds: scope });
    if (to.doctors && st && st.role === 'doctor') { const br = doctorBranchIds_(st, ctx.branches).filter(id => scope.indexOf(id) >= 0); if (br.length) out.push({ chat: per.chat, doctorId: k, name: st.name, branchIds: br }); }
  });
  // أشخاص بعينهم (زي تذكير ليا أنا)
  (m.people || []).forEach(k => { const per = cfg.people[k]; if (per && per.chat && !per.paused) out.push({ chat: per.chat, branchIds: scope }); });
  const seen = {};
  return out.filter(r => { const k = String(r.chat); if (seen[k]) return false; seen[k] = 1; return true; });
}

function cmValues_(r, ctx, d, today, tmr) {
  const inB = x => r.branchIds.indexOf(x.branchId) >= 0, mine = x => inB(x) && (!r.doctorId || x.doctorId === r.doctorId);
  const live = a => a.status !== 'canceled';
  const ap = d.apps.filter(mine);
  return {
    'الدكتور': r.name || '', 'الفرع': r.branchIds.map(id => ctx.bOf(id).name).filter(Boolean).join('، '), 'التاريخ': dayTxt_(today),
    'حجوزات_النهاردة': ap.filter(a => a.date === today && live(a)).length,
    'حجوزات_بكرة': ap.filter(a => a.date === tmr && live(a)).length,
    'غير_مؤكد_بكرة': ap.filter(a => a.date === tmr && (!a.status || a.status === 'unconfirmed' || a.status === 'booked' || a.status === 'no_answer')).length,
    'أونلاين_النهاردة': ap.filter(a => a.date === today && live(a) && a.source === 'online').length,
    'كنسل_النهاردة': ap.filter(a => a.date === today && a.status === 'canceled').length,
    'متابعات_مستحقة': d.patients.filter(p => mine(p) && !p.followedAt).length,
    'معامل_متأخرة': d.labs.filter(c => inB(c) && labDue_(c, today)).length,
    'نواقص': d.shortages.filter(inB).length
  };
}

/* ================= الاستشارات ================= */

function consultChats_(ctx, c) {
  const chats = [];
  if (!on_(ctx.cfg, 'consult')) return chats;
  const recs = recipients_(ctx), t = c.targets || [];
  t.forEach(id => { const r = recs.find(x => x.key === id); if (r) chats.push(String(r.chat)); });
  recs.forEach(r => { if (gets_(ctx, r, 'consult', c.branchId, t)) chats.push(String(r.chat)); });
  return chats.filter((x, i) => chats.indexOf(x) === i);
}

function consults_(cfg, C, since) {
  let ctx = null; const X = () => ctx = ctx || C();
  // 1) استشارات جديدة لسه متبعتتش (لو السيستم مكانش مفتوح)
  query_('consults', [['createdAt', '>=', since]]).forEach(c => {
    if (c.tgSent || c.status !== 'new') return;
    if (!claim_(c, { tgSent: true })) return;
    const ctx = X();
    const text = fill_(ctx.T.tgConsult, { code: c._id, patient: c.name, phone: c.phone || '', branch: ctx.bOf(c.branchId).name || '—', topic: c.topic || '—', doctor: c.doctorName ? 'د. ' + c.doctorName : ((c.targets || []).length ? 'أي دكتور مناسب' : 'الإدارة'), question: c.question });
    const msgs = [];
    consultChats_(ctx, c).forEach(chat => { const r = postId_(ctx.cfg, chat, text); if (r) msgs.push(r); });
    // بنضيف للقديم (لو الاستشارة اتحولت لدكتور تاني، الردود على الرسايل القديمة برضه بتتسجل)
    if (msgs.length) api_('post', BASE + ':commit', { writes: [{ transform: { document: c._name, fieldTransforms: [
      { fieldPath: 'tgMsgs', appendMissingElements: { values: msgs.map(encAny_) } },
      { fieldPath: 'tgKeys', appendMissingElements: { values: msgs.map(m => enc_(m.chat + '_' + m.mid)) } }] } }] });
  });

  // 1ب) رد اتكتب من جوه السيستم → رسالة "اترد على الاستشارة"
  query_('consults', [['answeredAt', '>=', since]]).forEach(c => {
    const last = (c.replies || []).slice(-1)[0];
    if (!last || last.via !== 'system' || c.tgReplyAt === c.answeredAt) return;
    if (!claim_(c, { tgReplyAt: c.answeredAt })) return;
    const ctx = X();
    send_(ctx, fill_(ctx.T.tgConsultReply, { code: c._id, patient: c.name, by: last.by || '', reply: last.text || '' }), c.branchId, 'consult', []);
  });

  // 2) الردود: أي Reply على رسالة استشارة في تيليجرام بيتسجل كرد
  const props = PropertiesService.getScriptProperties();
  const offset = Number(props.getProperty('tgOffset') || 0);
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + cfg.token + '/getUpdates?timeout=0&allowed_updates=%5B%22message%22%5D' + (offset ? '&offset=' + offset : ''), { muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText() || '{}');
  if (!j.ok) { Logger.log('getUpdates: ' + (j.description || r.getResponseCode()) + (r.getResponseCode() === 409 ? ' — البوت متوصّل بـ Webhook: افصليه من السيستم (الإعدادات ← تيليجرام ← هات الشاتات ← فصل الـ Webhook)' : '')); return; }
  let last = offset;
  (j.result || []).forEach(u => {
    last = Math.max(last, u.update_id + 1);
    const m = u.message;
    if (!m || !m.text || !m.reply_to_message) return;
    const key = String(m.chat.id) + '_' + m.reply_to_message.message_id;
    const found = query_('consults', [['tgKeys', 'array-contains', key]]);
    if (!found.length) return;
    const c = found[0], ctx = X();
    const fromChat = String(m.chat.id), fromUser = String((m.from && m.from.id) || '');
    let by = '', byId = '';
    Object.keys(ctx.cfg.people).forEach(k => { const per = ctx.cfg.people[k]; if (per && (String(per.chat) === fromUser || String(per.chat) === fromChat) && !by) { const st = ctx.staff().find(x => x._id === k); byId = k; by = per.manual ? (per.name || '') : st ? ((st.role === 'doctor' ? 'د. ' : '') + st.name) : ''; } });
    if (!by) by = [m.from && m.from.first_name, m.from && m.from.last_name].filter(Boolean).join(' ') || 'الإدارة';
    const at = new Date().toISOString();
    api_('post', BASE + ':commit', { writes: [{
      update: { name: c._name, fields: { status: enc_('answered'), answeredAt: enc_(at) } }, updateMask: { fieldPaths: ['status', 'answeredAt'] },
      updateTransforms: [{ fieldPath: 'replies', appendMissingElements: { values: [encAny_({ by, byId, text: m.text, at, via: 'telegram' })] } }]
    }] });
    post_(ctx.cfg, fromChat, '✅ ردك على استشارة ' + c.name + ' اتسجل، وهيوصل للمريض.');
    send_(ctx, fill_(ctx.T.tgConsultReply, { code: c._id, patient: c.name, by, reply: m.text }), c.branchId, 'consult', []);
  });
  if (last !== offset) props.setProperty('tgOffset', String(last));
}

function postId_(cfg, chat, text) {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + cfg.token + '/sendMessage', { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify({ chat_id: chat, text: text }) });
  Utilities.sleep(350);
  try { const j = JSON.parse(r.getContentText()); return j.ok ? { chat: String(chat), mid: j.result.message_id } : null; } catch (e) { return null; }
}

/* ================= النسخ الاحتياطي ================= */

// نسخة كاملة من قاعدة البيانات في جوجل درايف (نفس شكل ملف "تنزيل نسخة" في السيستم، فبتترجع من هناك)
// بقت كل أسبوع (يوم الجمعة) بدل كل يوم — لأنها بتقرا قاعدة البيانات كلها. لو عايزة نسخة حالاً شغّلي backupNow
const BACKUP_DAY = 5; // 5 = الجمعة
function dailyBackup() {
  if (Number(Utilities.formatDate(new Date(), TZ, 'u')) !== BACKUP_DAY) return 'skip';
  return backupNow();
}
function backupNow() {
  const out = { app: 'new-era-clinic', version: 1, at: new Date().toISOString(), by: 'google-script', collections: {} };
  // صور وملفات الحالات تقيلة — مش بتدخل في النسخة اليومية (عشان النسخة متقفش ودرايف ميتملاش)؛ بيانات الحالات نفسها بتدخل
  const SKIP = ['case_files'];
  const cols = (api_('post', BASE + ':listCollectionIds', { pageSize: 100 }).collectionIds || []).filter(c => SKIP.indexOf(c) < 0);
  cols.forEach(c => {
    out.collections[c] = {};
    let token = '';
    do {
      const r = api_('get', BASE + '/' + c + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
      (r.documents || []).forEach(d => { out.collections[c][d.name.split('/').pop()] = rawObj_(d.fields); });
      token = r.nextPageToken || '';
    } while (token);
  });
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
  const name = 'new-era-backup-' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HH-mm') + '.json';
  folder.createFile(name, JSON.stringify(out), 'application/json');
  // نمسح الأقدم ونسيب آخر BACKUP_KEEP
  const files = []; const fi = folder.getFiles();
  while (fi.hasNext()) { const f = fi.next(); if (/^new-era-backup-/.test(f.getName())) files.push(f); }
  files.sort((a, b) => b.getDateCreated() - a.getDateCreated()).slice(BACKUP_KEEP).forEach(f => f.setTrashed(true));
  return name;
}

function rawVal_(v) {
  if (!v) return null;
  if ('timestampValue' in v) return { __ts: Date.parse(v.timestampValue) };
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(rawVal_);
  if ('mapValue' in v) return rawObj_(v.mapValue.fields);
  if ('nullValue' in v) return null;
  return val_(v);
}
function rawObj_(f) { const o = {}; Object.keys(f || {}).forEach(k => { o[k] = rawVal_(f[k]); }); return o; }

/* ================= تيليجرام ================= */

function tgConfig_() {
  const c = cached_('cfg_tg', 1800, () => get_('private_config/telegram')) || {};
  let routes = DEFAULT_ROUTES;
  if (c.routes) {
    const known = c.routesKnown || OLD_KINDS;
    routes = {};
    ['main', 'branch'].forEach(sd => { routes[sd] = (c.routes[sd] || []).concat(DEFAULT_ROUTES[sd].filter(k => known.indexOf(k) < 0)); });
  }
  const people = Object.assign({}, c.people || {});
  const oldDoc = (c.routes && c.routes.doctor) || PERSON_DEFAULT_DOCTOR;
  Object.keys(c.doctors || {}).forEach(id => { if (c.doctors[id] && !people[id]) people[id] = { chat: c.doctors[id], kinds: oldDoc.slice() }; });
  // النسخة الجديدة (v2): كل شات (الإدارة / جروب كل فرع / كل شخص) ليه اختياراته ومواعيده لوحده.
  // القديمة: الأنواع الموقّفة للكل بتتشال من اختيارات كل واحد
  return { token: c.token || '', main: c.main || '', branches: c.branches || {}, people, routes, mainCfg: c.mainCfg || null, branchCfg: c.branchCfg || null, oldOff: c.v === 2 ? [] : (c.off || []), off: [], quiet: c.quiet || {}, tasksV1: !!c.tasksV1 };
}

const TPL_KIND = { tgApp: 'booking', tgOnline: 'online', tgUnsched: 'unsched', tgCancel: 'cancel', tgResched: 'reschedule', tgFollow: 'follow', tgLab: 'lab', tgShortage: 'shortage', tgDue: 'due', tgDigest: 'digest', tgConsult: 'consult' };
function ctx_(cfg) {
  const branches = cached_('cfg_br', 1800, () => list_('branches'));
  let staff = null;
  const T = templates_();
  // الأنواع اللي قالبها اتحذف بتتعامل كأنها موقّفة
  Object.keys(TPL_KIND).forEach(k => { if (T._deleted.indexOf(k) >= 0 && cfg.off.indexOf(TPL_KIND[k]) < 0) cfg.off.push(TPL_KIND[k]); });
  if (T._quiet) cfg.quiet = T._quiet;
  cfg.noSched = T._deleted.indexOf('grpSched') >= 0;
  cfg.noDocSched = T._deleted.indexOf('grpDocSched') >= 0;
  return {
    cfg, branches, T,
    bOf: id => branches.find(b => b._id === id) || { _id: id, name: '' },
    staff: () => (staff = staff || cached_('cfg_staff', 1800, () => list_('staff_members')))
  };
}

function templates_() {
  const t = cached_('cfg_tpl', 1800, () => get_('settings/templates')) || {};
  const out = {};
  const OLD = { tgCancel: '❌ {kind} — فرع {branch}\nالمريض: {patient}\nالموبايل: {phone}\nالموعد كان: {date} {time}\nالخدمة: {service}\nالدكتور: {doctor}\n📞 اتسجل في سجل المرضى للمتابعة' };
  Object.keys(TPL_DEFAULT).forEach(k => { out[k] = (t[k] && t[k] !== OLD[k]) ? t[k] : TPL_DEFAULT[k]; });
  out._deleted = t._deleted || [];   // قوالب اتحذفت من السيستم = الرسالة دي مش بتتبعت
  out._quiet = t._quiet || null;     // متبعتش الجدول لو فاضي
  const tm = t._times || {};          // مواعيد الإرسال من السيستم
  out._times = { sched: isNaN(Number(tm.sched)) || tm.sched === undefined ? DIGEST_HOUR : Number(tm.sched), short: isNaN(Number(tm.short)) || tm.short === undefined ? SHORT_HOUR : Number(tm.short), shortMode: tm.shortMode || 'daily' };
  return out;
}

// فروع الموظف: null = كل الفروع (الأدمن من غير تحديد)
function staffScope_(s) {
  if (!s || s.role === 'superadmin') return null;
  const ids = (s.branchIds && s.branchIds.length) ? s.branchIds : (s.branchId && s.branchId !== 'all' ? [s.branchId] : []);
  return s.role === 'admin' && !ids.length ? null : ids;
}
function doctorBranchIds_(s, branches) { return (s.branchIds && s.branchIds.length) ? s.branchIds : (s.branchId === 'all' ? branches.map(b => b._id) : [s.branchId]); }

function num_(x, d) { const n = Number(x); return (x === undefined || x === null || x === '' || isNaN(n)) ? d : n; }
// مواعيد كل شخص: الحجوزات (مجمّعة في جدول الساعة X / مع كل حجز) والنواقص (مجمّعة الساعة X / فوراً)
function timing_(o, def) {
  return { schedMode: o.schedMode === 'instant' ? 'instant' : 'daily', schedHour: num_(o.schedHour, def.sched), shortMode: (o.shortMode || def.shortMode) === 'instant' ? 'instant' : 'daily', shortHour: num_(o.shortHour, def.short) };
}
// كل اللي بيستلموا: شات الإدارة + جروب كل فرع + كل شخص (أدمن / سكرتيرة / دكتور / يدوي)
function recipients_(ctx) {
  if (ctx._recs) return ctx._recs;
  const c = ctx.cfg, def = ctx.T._times, strip = k => (k || []).filter(z => c.oldOff.indexOf(z) < 0), out = [];
  const mc = c.mainCfg || { kinds: strip(c.routes.main) };
  out.push(Object.assign({ key: '_main', type: 'main', chat: c.main, paused: !!mc.paused, kinds: mc.kinds || [] }, timing_(mc, def)));
  ctx.branches.forEach(b => {
    const bc = (c.branchCfg || {})[b._id] || { kinds: strip(c.routes.branch) };
    out.push(Object.assign({ key: '_b_' + b._id, type: 'group', branch: b._id, chat: c.branches[b._id] || c.branches[b.name] || '', paused: !!bc.paused, kinds: bc.kinds || [] }, timing_(bc, def)));
  });
  Object.keys(c.people).forEach(k => {
    const per = c.people[k]; if (!per) return;
    const st = per.manual ? null : ctx.staff().find(x => x._id === k);
    const type = per.manual ? 'admin' : !st ? null : st.role === 'doctor' ? 'doctor' : (st.role === 'admin' || st.role === 'superadmin') ? 'admin' : 'secretary';
    if (!type) return; // الموظف اتشال من السيستم
    out.push(Object.assign({ key: k, type: type, st: st, name: per.manual ? (per.name || '') : st.name, brs: (type === 'secretary' || type === 'admin') && st ? staffScope_(st) : null, chat: per.chat || '', paused: !!per.paused, kinds: strip(per.kinds) }, timing_(per, def)));
  });
  // اللي متوقف من جدول التحكم في السيستم مش بيوصله أي حاجة
  return (ctx._recs = out.filter(r => r.chat && !r.paused));
}

function gets_(ctx, r, kind, branchId, doctorIds) {
  if (!r.chat || r.kinds.indexOf(kind) < 0) return false;
  if (r.type === 'group') return !branchId || branchId === r.branch;
  if (r.type === 'main' || r.type === 'admin' || r.type === 'secretary') return !r.brs || !branchId || r.brs.indexOf(branchId) >= 0;
  if (r.type === 'doctor') {
    if (DOCTOR_OWN_KINDS.indexOf(kind) >= 0) return (doctorIds || []).indexOf(r.key) >= 0;
    return !branchId || doctorBranchIds_(r.st, ctx.branches).indexOf(branchId) >= 0;
  }
  return false;
}

// حجز من السيستم: "مع كل حجز" = فوراً، "مجمّعة" = بس لو لنفس اليوم وبعد ميعاد جدوله. النواقص المجمّعة مش بتتبعت فوراً
function timeOk_(r, kind, opts) {
  if (kind === 'booking') return r.schedMode === 'instant' || ((opts || {}).date === day_(0) && nowHour_() >= r.schedHour);
  if (kind === 'shortage') return r.shortMode === 'instant';
  return true;
}

function on_(cfg, kind) { return (cfg.off || []).indexOf(kind) < 0; }
function hasSched_(apps, pred, date) { return apps.some(a => pred(a) && a.date === date && a.status !== 'canceled'); }

function send_(ctx, text, branchId, kind, doctorIds, opts) {
  if (!on_(ctx.cfg, kind)) return;
  const ids = (doctorIds || []).filter(Boolean), chats = [];
  recipients_(ctx).forEach(r => { if (gets_(ctx, r, kind, branchId, ids) && timeOk_(r, kind, opts)) chats.push(String(r.chat)); });
  chats.filter((c, i) => chats.indexOf(c) === i).forEach(chat => post_(ctx.cfg, chat, text));
}

function post_(cfg, chat, text) {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + cfg.token + '/sendMessage', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ chat_id: chat, text: text })
  });
  if (r.getResponseCode() >= 300) Logger.log('تيليجرام رفض الإرسال لـ ' + chat + ': ' + r.getContentText());
  Utilities.sleep(350);
}

function fill_(tpl, v) { return String(tpl || '').replace(/\{(\w+)\}/g, (m, x) => (v[x] === undefined || v[x] === null) ? '' : v[x]); }
// بعد ملء القالب: نشيل الفواصل اللي بقت فاضية
function tidy_(s) { return s.replace(/[ \t]*[—\-|•:،][ \t]*\u0000/g, '').replace(/\u0000/g, '').split('\n').map(l => l.replace(/ {2,}/g, ' ').replace(/\s+$/, '')).join('\n'); }
function fillTidy_(tpl, v) { const m = {}; Object.keys(v).forEach(k => { m[k] = (v[k] === '' || v[k] === null || v[k] === undefined) ? '\u0000' : v[k]; }); return tidy_(fill_(tpl, m)); }

/* ================= جدول المواعيد ================= */

function fmt12_(t) { if (!t) return '--'; const p = t.split(':').map(Number); return (p[0] % 12 || 12) + ':' + String(p[1] || 0).padStart(2, '0') + (p[0] >= 12 ? ' م' : ' ص'); }
function schedLine_(tpl, a) { return fillTidy_(tpl, { time: fmt12_(a.time), patient: a.patientName || '', service: a.service || '', phone: a.phone || '', status: APP_ST_TXT[a.status || 'unconfirmed'] || '', online: a.source === 'online' ? '🌐' : '' }); }
function pack_(head, blocks) { const out = []; let cur = head; blocks.forEach(bk => { if ((cur + '\n\n' + bk).length > 3800) { out.push(cur); cur = bk; } else cur += '\n\n' + bk; }); out.push(cur); return out; }

function scheduleMessages_(ctx, b, apps, date) {
  const T = ctx.T;
  const list = apps.filter(a => a.branchId === b._id && a.date === date && a.status !== 'canceled').sort((x, y) => (x.time || '').localeCompare(y.time || ''));
  const canceled = apps.filter(a => a.branchId === b._id && a.date === date && a.status === 'canceled').length;
  const base = { branch: b.name, date: dayTxt_(date), count: list.length, canceled: canceled ? '• ' + canceled + ' كنسل' : '' };
  if (!list.length) return [fillTidy_(T.tgSchedEmpty, base)];
  const groups = {}, order = [];
  list.forEach(a => { const k = a.needsSchedule ? '⚠️ محتاج تظبيط ميعاد (كلّموه)' : a.doctorName ? 'د. ' + a.doctorName : 'بدون دكتور'; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(a); });
  return pack_(fillTidy_(T.tgSchedHead, base), order.map(k => fillTidy_(T.tgSchedDoctor, { doctor: k, count: groups[k].length }) + '\n' + groups[k].map(a => schedLine_(T.tgSchedLine, a)).join('\n')));
}

function doctorScheduleMessage_(ctx, id, name, apps, date) {
  const T = ctx.T;
  const list = apps.filter(a => a.doctorId === id && a.date === date && a.status !== 'canceled').sort((x, y) => (x.time || '').localeCompare(y.time || ''));
  const base = { doctor: name, date: dayTxt_(date), count: list.length };
  if (!list.length) return fillTidy_(T.tgDocSchedEmpty, base);
  const byB = {}, order = [];
  list.forEach(a => { const n = ctx.bOf(a.branchId).name; if (!byB[n]) { byB[n] = []; order.push(n); } byB[n].push(a); });
  return pack_(fillTidy_(T.tgDocSchedHead, base), order.map(n => '🏥 فرع ' + n + '\n' + byB[n].map(a => schedLine_(T.tgDocSchedLine, a)).join('\n'))).join('\n\n').slice(0, 4000);
}

/* ================= قراءة الفواتير بالذكاء الاصطناعي (المخزن) =================
 * السيستم بيبعت صورة الفاتورة هنا ← السكريبت يتأكد إن اللي باعت أدمن ← يبعتها لـ Gemini أو Claude
 * ← يرجّع الأصناف والكميات والأسعار. مفتاح الـ AI محفوظ في السيستم (للسوبر أدمن بس) ومش بيوصل لأجهزة الموظفين.
 * التشغيل مرة واحدة: Deploy ← New deployment ← Web app ← Execute as: Me ← Who has access: Anyone
 * وانسخي الرابط وحطيه في السيستم: المخزن والجرد ← 📷 فاتورة ← ⚙️ الإعداد
 */
const FIREBASE_WEB_KEY = 'AIzaSyDQ17UevaMBy2aVYxsrLNpdQCvn92uSKi0';
const OWNER_EMAIL = 'neweradentalclinics@gmail.com';
const AI_DAILY_LIMIT = 80; // أقصى عدد فواتير في اليوم (حماية من أي استهلاك زيادة)
const AI_DEFAULT_MODEL = { gemini: 'gemini-flash-latest', claude: 'claude-haiku-5-5' };

function doGet() {
  let d = {}; try { d = JSON.parse(PropertiesService.getScriptProperties().getProperty('deploy_last') || '{}'); } catch (e) {}
  return json_({ ok: true, service: 'new-era-invoice', codeRev: CODE_REV, deploy: d });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (req.action === 'invoice') return json_(invoiceScan_(req));
    if (req.action === 'marketing') return json_(marketing_(req));
    if (req.action === 'caseUpload') return json_(caseUpload_(req));
    if (req.action === 'caseFile') return json_(caseFile_(req));
    if (req.action === 'caseDelete') return json_(caseDelete_(req));
    if (req.action === 'ai') return json_(aiTool_(req));
    if (req.action === 'ping') { authAdmin_(req.idToken); const c = aiCfg_(); return json_({ ok: true, ai: !!c.key, provider: c.provider, model: c.model }); }
    return json_({ ok: false, error: 'طلب مش معروف' });
  } catch (err) { return json_({ ok: false, error: String(err && err.message || err) }); }
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// بيتأكد من تسجيل دخول اللي باعت (توكن فايربيز) وبيرجّع دوره
function authUser_(idToken) {
  if (!idToken) throw new Error('لازم تكون مسجل دخول');
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_WEB_KEY, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('الجلسة انتهت — اعمل تحديث للصفحة وجرب تاني');
  const u = (JSON.parse(r.getContentText()).users || [])[0];
  if (!u) throw new Error('الحساب مش موجود');
  if (u.email === OWNER_EMAIL) return { role: 'superadmin', name: 'الإدارة', staffId: '' };
  const sa = get_('staff_auth/' + u.localId);
  if (!sa || !sa.role) throw new Error('الحساب ده مش متسجل في السيستم');
  return sa;
}
const isAdm_ = u => u.role === 'admin' || u.role === 'superadmin';

/* ================= صور وملفات حالات الدكاترة على جوجل درايف =================
 * بتتحفظ في: حالات نيو إيرا / اسم الدكتور / اسم المريض — خاصة (مش متشيّرة لحد)
 * والفتح من السيستم بيعدّي على هنا: الأدمن يفتح كله، والدكتور ملفات حالاته بس
 */
const CASES_FOLDER = 'حالات نيو إيرا';
function subFolder_(parent, name) {
  name = String(name || 'بدون اسم').replace(/[\\/:*?"<>|#%]+/g, ' ').trim().slice(0, 80) || 'بدون اسم';
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function caseUpload_(req) {
  const u = authUser_(req.idToken);
  if (!isAdm_(u) && !(u.role === 'doctor' && u.staffId && u.staffId === req.doctorId)) throw new Error('مش مسموح');
  if (!req.data) throw new Error('مفيش ملف');
  const root = (() => { const it = DriveApp.getFoldersByName(CASES_FOLDER); return it.hasNext() ? it.next() : DriveApp.createFolder(CASES_FOLDER); })();
  const folder = subFolder_(subFolder_(root, 'د. ' + (req.doctorName || req.doctorId)), req.patientName);
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mime || 'application/octet-stream', String(req.name || 'file').slice(0, 120));
  const f = folder.createFile(blob);
  f.setDescription(JSON.stringify({ app: 'new-era-case', doctorId: req.doctorId || '', logId: req.logId || '', tag: req.tag || '' }));
  return { ok: true, id: f.getId(), size: f.getSize() };
}
function caseAllowed_(u, f) {
  let meta = {}; try { meta = JSON.parse(f.getDescription() || '{}'); } catch (e) {}
  if (meta.app !== 'new-era-case') throw new Error('الملف ده مش من السيستم');
  if (!isAdm_(u) && !(u.role === 'doctor' && u.staffId && u.staffId === meta.doctorId)) throw new Error('مش مسموح تفتح الملف ده');
}
function caseFile_(req) {
  const u = authUser_(req.idToken), f = DriveApp.getFileById(req.id);
  caseAllowed_(u, f);
  const b = f.getBlob();
  return { ok: true, name: f.getName(), mime: b.getContentType(), data: Utilities.base64Encode(b.getBytes()) };
}
function caseDelete_(req) {
  const u = authUser_(req.idToken);
  (req.ids || []).slice(0, 20).forEach(id => { try { const f = DriveApp.getFileById(id); caseAllowed_(u, f); f.setTrashed(true); } catch (e) {} });
  return { ok: true };
}

// بيتأكد إن اللي باعت أدمن/سوبر أدمن (لقراءة الفواتير)
function authAdmin_(idToken) {
  if (!idToken) throw new Error('لازم تكوني مسجلة دخول');
  const r = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_WEB_KEY, { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('الجلسة انتهت — اعملي تحديث للصفحة وجربي تاني');
  const u = (JSON.parse(r.getContentText()).users || [])[0];
  if (!u) throw new Error('الحساب مش موجود');
  if (u.email === OWNER_EMAIL) return { role: 'superadmin', name: 'الإدارة' };
  const sa = get_('staff_auth/' + u.localId);
  if (!sa || ['admin', 'superadmin'].indexOf(sa.role) < 0) throw new Error('قراءة الفواتير للأدمن بس');
  return sa;
}

function aiCfg_() {
  const d = get_('private_config/ai') || {}, key = String(d.key || '').trim();
  const provider = /^sk-ant-/.test(key) ? 'claude' : 'gemini';
  return { key: key, provider: provider, model: String(d.model || '').trim() || AI_DEFAULT_MODEL[provider] };
}

function invoicePrompt_(catalog) {
  return [
    'You read purchase invoices / receipts for a dental clinic in Egypt (printed or handwritten, Arabic and/or English). Several images may be pages of the same invoice.',
    'Return ONLY a JSON object, no markdown, with this shape:',
    '{"supplier":"","invoiceNo":"","date":"YYYY-MM-DD or empty","items":[{"name":"","qty":0,"unit":"","unitPrice":0,"total":0,"match":""}],"discount":0,"total":0,"notes":""}',
    'Rules:',
    '- One entry per purchased product line. Skip subtotal, tax, delivery, balance and payment lines (mention delivery/tax in notes).',
    '- All numbers are plain JSON numbers (convert Arabic-Indic digits ٠١٢٣٤٥٦٧٨٩, remove thousands separators). Unknown = 0.',
    '- If unitPrice is missing but total and qty exist, unitPrice = total / qty. If qty is missing assume 1.',
    '- "name": the product as written (fix obvious OCR errors). "unit": the unit if written (علبة، كرتونة، قطعة، سرنجة، باكو...).',
    '- "match": if the product is clearly the same as one of the clinic catalog names below, copy that catalog name EXACTLY; otherwise "".',
    '- "total" at the top level = final amount payable on the invoice. "discount" = total discount if any.',
    'Clinic catalog names:',
    (catalog || []).slice(0, 700).join(' | ') || '(empty)'
  ].join('\n');
}

function invoiceScan_(req) {
  authAdmin_(req.idToken);
  const c = aiCfg_();
  if (!c.key) throw new Error('مفيش مفتاح ذكاء اصطناعي محفوظ — السوبر أدمن تحطه من: المخزن والجرد ← 📷 فاتورة ← ⚙️ الإعداد');
  const imgs = (req.images || []).filter(x => x && x.data).slice(0, 4);
  if (!imgs.length) throw new Error('مفيش صورة');
  const props = PropertiesService.getScriptProperties(), pk = 'ai_n_' + day_(0), n = Number(props.getProperty(pk) || 0);
  if (n >= AI_DAILY_LIMIT) throw new Error('وصلتي للحد اليومي لقراءة الفواتير (' + AI_DAILY_LIMIT + ') — جربي بكرة');
  props.setProperty(pk, String(n + 1));
  const prompt = invoicePrompt_(req.catalog);
  const text = c.provider === 'claude' ? askClaude_(c, prompt, imgs) : askGemini_(c, prompt, imgs);
  const data = parseJsonLoose_(text);
  if (!data || !Array.isArray(data.items)) throw new Error('مقدرتش أقرا الفاتورة — صوّريها تاني بإضاءة أحسن ومن غير ميل');
  return { ok: true, data: data, provider: c.provider, model: c.model, left: AI_DAILY_LIMIT - n - 1 };
}

/* ================= 🚀 المسوّق الذكي (لوحة الموقع) =================
 * بياخد أهداف صاحبة العيادة + بيانات الموقع ← يرجّع خطة SEO + إعلانات جوجل + فيسبوك + جوجل ماب + محتوى
 * ملتزم بسياسات جوجل للإعلانات الطبية وقواعد الظهور المحلي
 */
const MKT_RULES = [
  'You are a senior healthcare digital marketer, local-SEO specialist and certified Google Ads / Meta Ads media buyer working for a dental clinic group in Greater Cairo, Egypt.',
  'Write all user-facing marketing copy in natural Egyptian Arabic (عامية مصرية مهذبة) unless a field says English. Patients search in Arabic and Franco/English, so keywords must include both.',
  'COMPLIANCE (must follow): Google Ads Healthcare & medicines policy and Meta advertising standards. No guaranteed results, no "100%", no "painless guaranteed", no unverifiable superlatives (الأفضل/رقم 1/الأرخص) unless provided as fact, no before/after imagery claims in ads, no targeting or text that implies knowledge of a personal health condition (Meta: never write "هل عندك تسوس؟" style personal attributes — address the audience generally), no fake urgency, no prices unless the clinic gave them, no doctor names/credentials unless given.',
  'GOOGLE ADS: Search campaigns grouped by service intent; keywords in exact [..] and phrase "..." match (avoid broad unless smart bidding note); include location modifiers (منطقة/فرع) and "near me"/جنبي. Responsive Search Ads: 10-15 headlines each <= 30 characters, 4 descriptions each <= 90 characters, count characters strictly. Add a strong shared negative keyword list (وظائف، شغل، كورس، دبلومة، تدريب، مجانا ببلاش، مستلزمات، جملة، pdf، ماجستير، كلية، ...). Location targeting by radius around each branch, "presence" not "interest". Ad schedule around working hours. Suggest Maximize conversions once tracking exists, otherwise Maximize clicks with CPC cap. Split budget (EGP/day) by priority services. Sitelinks text <= 25 chars, callouts <= 25 chars.',
  'LOCAL SEO: title <= 60 chars, meta description 120-155 chars, include main service + area + brand. Google Business Profile: description <= 750 chars without keyword stuffing, no URLs/phone in description, primary category Dentist, suggest secondary categories that exist on GBP (e.g. Cosmetic dentist, Dental implants periodontist, Orthodontist, Pediatric dentist, Dental clinic). Weekly GBP posts <= 1500 chars with a CTA. NAP consistency. Review generation via WhatsApp message (never offer incentives for reviews).',
  'Service descriptions for the website: 2-3 sentences, helpful, mention benefit + who it is for + area, include 1-2 keywords naturally, Arabic <= 260 chars, English <= 260 chars.',
  'FAQs: real questions patients search (price ranges without numbers unless given, pain, duration, steps, guarantees policy, booking), helpful and accurate, 6-10 items.',
  'If monthly ads budget is 0, set googleAds.campaigns and meta.ads to [] and focus on organic. Be practical: everything must be copy-paste ready.'
].join('\n');
const MKT_SCHEMA = '{"summary":"3-5 lines in Arabic: the strategy in simple words","keywords":[{"kw":"","intent":"booking|price|info|local","priority":1}],"seo":{"title":"","desc":"","titleEn":"","descEn":""},"services":[{"id":"service id from input","desc":"","descEn":""}],"faqs":[{"q":"","a":"","topic":""}],"gbp":{"description":"","categories":[""],"posts":[{"title":"","text":"","cta":"BOOK|CALL|LEARN_MORE"}],"replyTemplates":{"positive":"","negative":""}},"googleAds":{"dailyBudget":0,"bidding":"","schedule":"","locations":[{"branch":"","radiusKm":0}],"campaigns":[{"name":"","service":"","dailyBudget":0,"adGroups":[{"name":"","keywords":[""],"headlines":[""],"descriptions":[""]}]}],"negatives":[""],"sitelinks":[{"text":"","desc":""}],"callouts":[""]},"meta":{"dailyBudget":0,"objective":"","audiences":[{"name":"","targeting":""}],"ads":[{"primary":"","headline":"","cta":""}]},"content":[{"week":1,"channel":"","idea":"","text":""}],"reviews":{"ask":"","tips":[""]},"checklist":[{"task":"","why":"","owner":"أنا|الموقع"}]}';

// الخطة بتتعمل على 3 أجزاء (أسرع وأضمن من طلب واحد كبير)
const MKT_PARTS = {
  seo: ['summary', 'keywords', 'seo', 'services', 'faqs', 'checklist'],
  ads: ['googleAds', 'meta'],
  local: ['gbp', 'content', 'reviews']
};
function mktSchemaPart_(part) {
  const full = JSON.parse(MKT_SCHEMA), o = {};
  (MKT_PARTS[part] || Object.keys(full)).forEach(k => { o[k] = full[k]; });
  return JSON.stringify(o);
}
function marketing_(req) {
  authAdmin_(req.idToken);
  const c = aiCfg_();
  if (!c.key) throw new Error('مفيش مفتاح ذكاء اصطناعي — حطيه من السيستم: المخزن والجرد ← 📷 فاتورة ← ⚙️ الإعداد');
  const props = PropertiesService.getScriptProperties(), pk = 'ai_n_' + day_(0), n = Number(props.getProperty(pk) || 0);
  if (n >= AI_DAILY_LIMIT) throw new Error('وصلتي للحد اليومي للذكاء الاصطناعي — جربي بكرة');
  props.setProperty(pk, String(n + 1));
  let prompt, schema;
  if (req.mode === 'ask') {
    prompt = MKT_RULES + '\n\nCLINIC DATA:\n' + JSON.stringify(req.site || {}).slice(0, 12000) + '\n\nCURRENT PLAN SUMMARY:\n' + String(req.planSummary || '').slice(0, 2000) +
      '\n\nREQUEST FROM THE CLINIC OWNER (answer it fully, ready to use):\n' + String(req.question || '').slice(0, 2000) +
      '\n\nReturn ONLY JSON: {"title":"short title","text":"the full answer / copy, may contain line breaks","items":["optional list of variants or steps"]}';
  } else {
    prompt = MKT_RULES + '\n\nCLINIC DATA (website + branches + services):\n' + JSON.stringify(req.site || {}).slice(0, 15000) +
      '\n\nOWNER GOALS / ANSWERS:\n' + JSON.stringify(req.answers || {}).slice(0, 4000) +
      (req.context ? '\n\nALREADY DECIDED (stay consistent with it):\n' + String(req.context).slice(0, 3000) : '') +
      '\n\nBuild this part of the marketing plan (' + (req.part || 'all') + '). Return ONLY valid JSON (no markdown) exactly in this shape:\n' + mktSchemaPart_(req.part);
  }
  const text = c.provider === 'claude' ? askClaude_(c, prompt, [], 8000) : askGemini_(c, prompt, []);
  const data = parseJsonLoose_(text);
  if (!data) throw new Error('الرد ماكانش مظبوط — جربي تاني');
  return { ok: true, data: data, provider: c.provider, model: c.model, left: AI_DAILY_LIMIT - n - 1 };
}

/* ================= أدوات الذكاء الاصطناعي للسيستم (v4.6) =================
 * copilot: مساعد الحالة للدكتور • xray: قراءة مبدئية للأشعة • explain: رسالة تشرح خطة العلاج للمريض
 * recovery: رسالة واتساب مخصوصة لمريض فلوسه/علاجه مكملش • content: بوستات سوشيال • assistant: المساعد العائم
 * كله بنفس المفتاح (private_config/ai) وبنفس الحد اليومي. الرد مساعدة بس — القرار للدكتور.
 */
const AI_TOOL_RULES = 'You are an assistant inside an Egyptian dental clinic management system (New Era Dental Center). Reply in Egyptian Arabic unless asked otherwise. Be concise, practical and safe. Never invent patient data. For clinical output: it is decision support for a licensed dentist, never a final diagnosis; flag uncertainty and urgent red flags clearly.';
const AI_TOOLS = {
  copilot: { who: ['doctor', 'admin', 'superadmin'], tok: 3000, prompt: r => 'CASE (from the medical record):\n' + String(r.caseText || '').slice(0, 9000) + '\n\nDOCTOR QUESTION: ' + String(r.question || 'حلّل الحالة واقترح خطة').slice(0, 1500) +
    '\n\nReturn ONLY JSON: {"summary":"2-3 lines","redFlags":["..."],"differentials":["..."],"suggestedPlan":["step"],"beforeTreatment":["checks / medical precautions given the history"],"askPatient":["questions"],"note":"one line reminder that the dentist decides"}' },
  xray: { who: ['doctor', 'admin', 'superadmin'], tok: 2500, img: true, prompt: r => 'Dental radiograph(s) attached (' + String(r.kind || 'periapical/panoramic') + '). Context: ' + String(r.context || '').slice(0, 2000) +
    '\nDescribe visible findings tooth by tooth using FDI numbering where possible (caries, periapical lesions, bone loss, restorations, root canal fillings, impacted teeth, missing teeth). Be explicit about image quality limits and confidence.\nReturn ONLY JSON: {"quality":"...","findings":[{"tooth":"36","finding":"...","confidence":"low|medium|high"}],"summary":"...","recommend":["..."],"note":"preliminary AI reading — must be confirmed by the dentist"}' },
  explain: { who: ['doctor', 'admin', 'superadmin', 'employee'], tok: 1500, prompt: r => 'Write a warm, clear WhatsApp message (Egyptian Arabic, no medical jargon) to the patient explaining their treatment plan, why each step matters, total cost and that installments are possible if mentioned. Patient first name: ' + String(r.name || '').slice(0, 40) + '\nPLAN:\n' + String(r.planText || '').slice(0, 4000) +
    '\nReturn ONLY JSON: {"text":"the message"}' },
  recovery: { who: ['admin', 'superadmin', 'employee'], tok: 1200, prompt: r => 'Write a short, polite, non-pushy WhatsApp follow-up (Egyptian Arabic) to bring this patient back to finish treatment / settle their account / rebook. Situation: ' + String(r.situation || '').slice(0, 1500) + '\nPatient first name: ' + String(r.name || '').slice(0, 40) +
    '\nReturn ONLY JSON: {"text":"the message"}' },
  content: { who: ['admin', 'superadmin'], tok: 3000, prompt: r => 'Write ' + Math.min(5, Number(r.count) || 3) + ' social media posts (Facebook/Instagram, Egyptian Arabic) for a dental clinic about: ' + String(r.topic || '').slice(0, 800) + '. Tone: ' + String(r.tone || 'friendly, trustworthy').slice(0, 100) + '. No false claims or guaranteed results, no before/after promises.\nReturn ONLY JSON: {"posts":[{"caption":"...","hashtags":["..."],"imageIdea":"..."}]}' },
  assistant: { who: ['doctor', 'admin', 'superadmin', 'employee'], tok: 1500, prompt: r => 'User role: ' + String(r.role || '') + '. Current screen: ' + String(r.screen || '') + '.\nLIVE CONTEXT (today, only what this user may see):\n' + String(r.context || '').slice(0, 5000) +
    '\nCONVERSATION:\n' + (r.history || []).slice(-8).map(m => (m.me ? 'USER: ' : 'ASSISTANT: ') + String(m.t || '').slice(0, 1200)).join('\n') + '\nUSER: ' + String(r.question || '').slice(0, 1500) +
    '\nHelp them use the system (sections: المواعيد، الحجز الذكي، المرضى والسجل الطبي، المتابعات، المعامل، الحسابات: حسابات المرضى/الخزنة/المصروفات/مستحقات الدكاترة، المخزن، المهام، الإعدادات) or answer from the context. If you do not know, say so.\nReturn ONLY JSON: {"text":"answer"}' }
};
function aiTool_(req) {
  const u = authUser_(req.idToken), t = AI_TOOLS[req.kind];
  if (!t) throw new Error('أداة مش معروفة');
  if (t.who.indexOf(u.role) < 0) throw new Error('الأداة دي مش متاحة لحسابك');
  const c = aiCfg_();
  if (!c.key) throw new Error('مفيش مفتاح ذكاء اصطناعي — الإدارة تحطه من: المخزن والجرد ← 📷 فاتورة ← ⚙️ الإعداد');
  const props = PropertiesService.getScriptProperties(), pk = 'ai_n_' + day_(0), n = Number(props.getProperty(pk) || 0);
  if (n >= AI_DAILY_LIMIT * 3) throw new Error('وصلتوا للحد اليومي للذكاء الاصطناعي — جربوا بكرة');
  props.setProperty(pk, String(n + 1));
  const imgs = t.img ? (req.images || []).slice(0, 3) : [];
  const prompt = AI_TOOL_RULES + '\n\n' + t.prompt(req);
  const text = c.provider === 'claude' ? askClaude_(c, prompt, imgs, t.tok) : askGemini_(c, prompt, imgs);
  const data = parseJsonLoose_(text);
  if (!data) throw new Error('الرد ماكانش مظبوط — جربوا تاني');
  return { ok: true, data: data, provider: c.provider };
}

function askGemini_(c, prompt, imgs) {
  const parts = [{ text: prompt }].concat(imgs.map(i => ({ inline_data: { mime_type: i.mime || 'image/jpeg', data: i.data } })));
  const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(c.model) + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-goog-api-key': c.key },
    payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } })
  });
  const code = r.getResponseCode(), j = JSON.parse(r.getContentText() || '{}');
  if (code !== 200) throw new Error(aiErr_('Gemini', code, j.error && j.error.message));
  const cand = (j.candidates || [])[0];
  return ((cand && cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
}

function askClaude_(c, prompt, imgs, maxTok) {
  const content = imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime || 'image/jpeg', data: i.data } })).concat([{ type: 'text', text: prompt }]);
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({ model: c.model, max_tokens: maxTok || 4096, temperature: maxTok ? 0.4 : 0, messages: [{ role: 'user', content: content }] })
  });
  const code = r.getResponseCode(), j = JSON.parse(r.getContentText() || '{}');
  if (code !== 200) throw new Error(aiErr_('Claude', code, j.error && j.error.message));
  return (j.content || []).map(p => p.text || '').join('');
}

function aiErr_(who, code, msg) {
  if (code === 401 || code === 403) return 'مفتاح ' + who + ' مش شغال — اتأكدي إنه متنسخ صح';
  if (code === 429) return who + ': عدد الطلبات كتير أو الرصيد خلص — استني دقيقة وجربي تاني';
  if (code === 404) return who + ': اسم الموديل مش موجود (' + (msg || '') + ') — غيّريه من الإعداد أو سيبيه فاضي';
  return who + ' ' + code + ': ' + String(msg || '').slice(0, 200);
}

function parseJsonLoose_(t) {
  t = String(t || '').replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

/* ================= تواريخ ================= */

function day_(n) { return Utilities.formatDate(new Date(Date.now() + n * 864e5), TZ, 'yyyy-MM-dd'); }
function dayTxt_(d) { const js = Number(Utilities.formatDate(new Date(d + 'T12:00:00Z'), 'UTC', 'u')) % 7; return DAY_NAMES[js] + '، ' + Number(d.slice(8)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1]; }
function remindDays_(c) { return (c.remindDays === undefined || c.remindDays === null || c.remindDays === '') ? 2 : Number(c.remindDays); }
function labDue_(c, today) { const n = remindDays_(c); return c.status !== 'returned' && !c.chasedAt && c.sentDate && n > 0 && (Date.parse(today) - Date.parse(c.sentDate)) / 864e5 >= n; }
function daysLabel_(n) { return ({ 1: 'يوم', 2: 'يومين', 3: '3 أيام', 5: '5 أيام', 7: 'أسبوع', 10: '10 أيام', 14: 'أسبوعين', 30: 'شهر' })[n] || (n + ' يوم'); }

/* ================= Firestore ================= */

// إعدادات بتتغير نادراً (التوكن، الفروع، القوالب، الموظفين): بتتحفظ نص ساعة بدل ما تتقرا كل 5 دقايق
function cached_(key, sec, fn) {
  const c = CacheService.getScriptCache(), v = c.get(key);
  if (v !== null) { try { return JSON.parse(v); } catch (e) { } }
  const r = fn();
  try { c.put(key, JSON.stringify(r === undefined ? null : r), sec); } catch (e) { }
  return r;
}
// لو اتغيرت إعدادات تيليجرام أو القوالب وعايزاها تشتغل فوراً: شغّلي دي
function clearCache() { CacheService.getScriptCache().removeAll(['cfg_tg', 'cfg_br', 'cfg_staff', 'cfg_tpl', 'cfg_cm']); Logger.log('اتمسح ✓'); }

function api_(method, url, body) {
  const opt = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': PROJECT_ID } };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(url, opt), code = r.getResponseCode(), txt = r.getContentText();
  if (code >= 300) { const e = new Error('Firestore ' + code + ': ' + txt.slice(0, 400)); e.status = code; throw e; }
  return txt ? JSON.parse(txt) : {};
}

function val_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(val_);
  if ('mapValue' in v) return obj_(v.mapValue.fields);
  return null;
}
function obj_(f) { const o = {}; Object.keys(f || {}).forEach(k => { o[k] = val_(f[k]); }); return o; }
function doc_(d) { const o = obj_(d.fields); o._id = d.name.split('/').pop(); o._name = d.name; o._ut = d.updateTime; return o; }
function enc_(x) { return typeof x === 'boolean' ? { booleanValue: x } : typeof x === 'number' ? (Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x }) : { stringValue: String(x) }; }

function get_(path) {
  try { return doc_(api_('get', BASE + '/' + path)); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

function list_(col) {
  let out = [], token = '';
  do {
    const r = api_('get', BASE + '/' + col + '?pageSize=300' + (token ? '&pageToken=' + encodeURIComponent(token) : ''));
    (r.documents || []).forEach(d => out.push(doc_(d)));
    token = r.nextPageToken || '';
  } while (token);
  return out;
}

const OPS = { '>=': 'GREATER_THAN_OR_EQUAL', '<=': 'LESS_THAN_OR_EQUAL', '==': 'EQUAL', '>': 'GREATER_THAN', '<': 'LESS_THAN', 'array-contains': 'ARRAY_CONTAINS' };
// أي قيمة (نص/رقم/قايمة/أوبجكت) لصيغة Firestore
function encAny_(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(encAny_) } };
  if (typeof x === 'object') { const f = {}; Object.keys(x).forEach(k => { f[k] = encAny_(x[k]); }); return { mapValue: { fields: f } }; }
  return enc_(x);
}
function query_(col, filters) {
  const ff = filters.map(f => ({ fieldFilter: { field: { fieldPath: f[0] }, op: OPS[f[1]], value: enc_(f[2]) } }));
  const where = ff.length === 1 ? ff[0] : { compositeFilter: { op: 'AND', filters: ff } };
  const r = api_('post', BASE + ':runQuery', { structuredQuery: { from: [{ collectionId: col }], where: where } });
  return (r || []).filter(x => x.document).map(x => doc_(x.document));
}

// بيعلّم على المستند إن الإشعار اتبعت — بس لو محدش غيّره من ساعة ما قريناه (عشان مفيش تكرار مع السيستم)
function claim_(d, fields) {
  const f = {}, mask = [];
  Object.keys(fields).forEach(k => { f[k] = enc_(fields[k]); mask.push(k); });
  try { api_('post', BASE + ':commit', { writes: [{ update: { name: d._name, fields: f }, updateMask: { fieldPaths: mask }, currentDocument: { updateTime: d._ut } }] }); return true; }
  catch (e) { if (e.status === 400 || e.status === 409 || e.status === 412) return false; throw e; }
}

// بيعمل المستند لو مش موجود بس — ولو موجود يبقى الرسالة اتبعتت قبل كده النهاردة
function createOnce_(path) {
  try { api_('post', BASE + ':commit', { writes: [{ update: { name: ROOT + '/' + path, fields: { at: enc_(Date.now()), by: enc_('google-script') } }, currentDocument: { exists: false } }] }); return true; }
  catch (e) { if (e.status === 400 || e.status === 409 || e.status === 412) return false; throw e; }
}


/* ================= النشر التلقائي من GitHub ================= */
// رقم نسخة الملف ده (بيزيد مع كل تعديل) — بيبان في doGet عشان نتأكد إن آخر نسخة اشتغلت
const CODE_REV = 6;
const GH_RAW = 'https://raw.githubusercontent.com/neweradentalclinics-png/NewEra/main/backend/';
const STORAGE_BUCKET = 'new-era-dental-center.firebasestorage.app';

// شغّليها بإيدك أول مرة (عشان توافقي على الصلاحيات) — بتنشر كل حاجة من GitHub حالاً
function deployNow() { const r = autoDeploy_(true); Logger.log(JSON.stringify(r, null, 2)); return r; }

function autoDeploy_(force) {
  const props = PropertiesService.getScriptProperties();
  const want = JSON.parse(ghText_('deploy.json'));
  const done = JSON.parse(props.getProperty('deploy_done') || '{}');
  const todo = ['firestore', 'storage', 'script', 'indexes'].filter(k => want[k] && (force || Number(want[k]) > Number(done[k] || 0)));
  if (!todo.length) return { ok: true, nothing: true };
  // لو آخر محاولة فشلت بنفس السبب، منحاولش تاني قبل 6 ساعات (عشان تليجرام ميفضلش يبعت نفس الرسالة كل 5 دقايق)
  const fail = JSON.parse(props.getProperty('deploy_fail') || '{}');
  if (!force && fail.at && Date.now() - fail.at < 6 * 3600 * 1000 && fail.want === JSON.stringify(want)) return { ok: false, waiting: true };
  const lock = LockService.getScriptLock(); if (!lock.tryLock(1000)) return { ok: false, busy: true };
  const out = { at: new Date().toISOString(), ok: true, steps: [] };
  try {
    todo.forEach(k => {
      try {
        if (k === 'firestore') deployRules_('firestore.rules', 'cloud.firestore');
        if (k === 'storage') deployRules_('storage.rules', 'firebase.storage/' + STORAGE_BUCKET);
        if (k === 'script') out.scopesNeeded = deployScript_(want.script);
        if (k === 'indexes') out.indexes = deployIndexes_();
        done[k] = Number(want[k]); props.setProperty('deploy_done', JSON.stringify(done));
        out.steps.push(k + ' ✓ ' + want[k]);
      } catch (e) { out.ok = false; out.steps.push(k + ' ✗ ' + (e && e.message || e)); }
    });
  } finally { lock.releaseLock(); }
  props.setProperty('deploy_last', JSON.stringify(out));
  const sig = out.ok ? '' : out.steps.join('|');
  if (out.ok) props.deleteProperty('deploy_fail');
  else props.setProperty('deploy_fail', JSON.stringify({ at: Date.now(), want: JSON.stringify(want), sig }));
  // نفس الخطأ اتبعت قبل كده؟ متبعتوش تاني (إلا لو شغّلتي deployNow بإيدك)
  if (out.ok || force || fail.sig !== sig) deployNotify_(out);
  return out;
}

function deployNotify_(out) {
  try {
    const cfg = tgConfig_(); if (!cfg.token || !cfg.main) return;
    let t = (out.ok ? '🚀 اتنشر تحديث جديد من GitHub' : '⚠️ في مشكلة في النشر من GitHub') + '\n' + out.steps.join('\n');
    if (out.scopesNeeded) t += '\n\n🔑 التحديث محتاج صلاحيات جديدة: افتحي السكريبت واختاري deployNow ودوسي Run ووافقي.';
    if (/insufficient authentication scopes|PERMISSION_DENIED.*scope/i.test(out.steps.join(' '))) t += '\n\n🔑 السكريبت لسه مخدش صلاحية النشر: حطي appsscript.json الجديد في السكريبت، وبعدين اختاري deployNow ودوسي Run ووافقي على الصلاحيات. (الرسالة دي مش هتتكرر غير كل 6 ساعات)';
    post_(cfg, cfg.main, t);
  } catch (e) { Logger.log('deploy notify: ' + e); }
}

function ghText_(f) {
  const r = UrlFetchApp.fetch(GH_RAW + f + '?t=' + Date.now(), { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
  if (r.getResponseCode() !== 200) throw new Error(f + ' مش لاقيه على GitHub (' + r.getResponseCode() + ')');
  return r.getContentText();
}

function gApi_(method, url, body, billProject) {
  const headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
  if (billProject) headers['x-goog-user-project'] = PROJECT_ID;
  const o = { method: method, muteHttpExceptions: true, headers: headers };
  if (body) { o.contentType = 'application/json'; o.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(url, o), t = r.getContentText();
  let j = {}; try { j = t ? JSON.parse(t) : {}; } catch (e) {}
  if (r.getResponseCode() >= 300) {
    const m = (j.error && j.error.message) || ('HTTP ' + r.getResponseCode());
    if (/Apps Script API|has not enabled/i.test(m)) throw new Error('لازم تفعّلي Google Apps Script API من https://script.google.com/home/usersettings');
    throw new Error(m);
  }
  return j;
}

// بينشر ملف قواعد: بيعمل نسخة قواعد جديدة (جوجل بيرفضها لو فيها غلط) وبعدين يشغّلها
function deployRules_(file, release) {
  const base = 'https://firebaserules.googleapis.com/v1/projects/' + PROJECT_ID;
  const rs = gApi_('post', base + '/rulesets', { source: { files: [{ name: file, content: ghText_(file) }] } }, true);
  const name = 'projects/' + PROJECT_ID + '/releases/' + release;
  try { gApi_('patch', base + '/releases/' + release, { release: { name: name, rulesetName: rs.name } }, true); }
  catch (e) { if (!/not found|NOT_FOUND/i.test(String(e && e.message || e))) throw e; gApi_('post', base + '/releases', { name: name, rulesetName: rs.name }, true); } // أول نشر: الـ release لسه مش موجود
}

// بيعمل فهارس Firestore المطلوبة (firestore.indexes.json) — اللي موجود بيتساب زي ما هو
// (قفل الفروع بيحتاجها عشان استعلامات موظف الفرع تبقى سريعة؛ لحد ما تخلص السيستم بيشتغل برضه بطريقة أبطأ)
function deployIndexes_() {
  const list = JSON.parse(ghText_('firestore.indexes.json')).indexes || [];
  const base = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/collectionGroups/';
  let made = 0, had = 0;
  list.forEach(ix => {
    try { gApi_('post', base + ix.collectionGroup + '/indexes', { queryScope: ix.queryScope || 'COLLECTION', fields: ix.fields }, true); made++; }
    catch (e) { if (/already exists|ALREADY_EXISTS/i.test(String(e && e.message || e))) had++; else throw e; }
  });
  return made + ' جديد، ' + had + ' موجود';
}

// بيحدّث كود السكريبت نفسه، ويعمل نسخة جديدة، ويحدّث رابط الـ Web app (نفس الرابط ميتغيرش)
function deployScript_(rev) {
  const id = ScriptApp.getScriptId(), api = 'https://script.googleapis.com/v1/projects/' + id;
  const code = ghText_('Code.gs'), man = ghText_('appsscript.json');
  const newMan = JSON.parse(man);
  const cur = gApi_('get', api + '/content');
  const files = cur.files || [];
  const curMan = files.filter(f => f.name === 'appsscript')[0];
  const oldScopes = curMan ? (JSON.parse(curMan.source).oauthScopes || []) : [];
  const scopesNeeded = (newMan.oauthScopes || []).some(x => oldScopes.indexOf(x) < 0);
  const js = files.filter(f => f.type === 'SERVER_JS');
  const codeName = js.length === 1 ? js[0].name : 'Code';
  const keep = files.filter(f => f.name !== 'appsscript' && !(f.type === 'SERVER_JS' && f.name === codeName));
  keep.push({ name: 'appsscript', type: 'JSON', source: man }, { name: codeName, type: 'SERVER_JS', source: code });
  gApi_('put', api + '/content', { scriptId: id, files: keep });
  const v = gApi_('post', api + '/versions', { description: 'GitHub #' + rev });
  (gApi_('get', api + '/deployments').deployments || []).forEach(d => {
    const c = d.deploymentConfig || {};
    if (!c.versionNumber || !(d.entryPoints || []).some(e => e.entryPointType === 'WEB_APP')) return;
    gApi_('put', api + '/deployments/' + d.deploymentId, { deploymentConfig: { scriptId: id, versionNumber: v.versionNumber, manifestFileName: 'appsscript', description: c.description || ('GitHub #' + rev) } });
  });
  return scopesNeeded;
}
