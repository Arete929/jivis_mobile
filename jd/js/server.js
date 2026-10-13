// 파일명: server.js | @version 1.0.0
// 체육 수업진도 대시보드 — GAS 서버 함수를 브라우저에서 그대로 재현한 계층
//
// 화면(index.html)은 손대지 않고 `google.script.run.○○()` 호출만 이쪽으로 돌린다.
// 데이터는 Firestore 에 있고, 계산(학기 누적 순연 등)은 여기서 한다.
// GAS 와 달리 네트워크 왕복이 없으므로 대부분 즉시 끝난다.

import {
  auth, loadTerm, watchTerm, savePart, loadSettings, saveSettings,
  listTerms as fsListTerms, saveAll, termId, loadWork } from './db.js';
import { uploadFile } from './drive.js';
import { DRIVE_FOLDER_NAME } from './config.js';

export const APP_VERSION = '1.65.2';
export const DEPLOYED_AT = '2026-10-07 22:20';   // 배포할 때 채워진다

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const DAYS5 = ['월', '화', '수', '목', '금'];
/* ★교시 순서를 바꾸는 날 — 메모 "동아리(345)" · "진로(712)" 를 읽어 자리↔교시 매핑을 만든다.
   원래 하루는 1·2·3·4 — 점심 — 5·6·7 이고 동아리·진로는 늘 오후(뒤 자리)에 한다.
   매번 같은 교시만 빠지지 않게 그 날은 교시 순서를 바꾼다.
   뒤 N자리에 괄호 안 교시를 넣고, 남은 교시를 앞자리에 순서대로 채운다.
   뒤 N자리는 실제로 그 활동을 하므로 그 교시 수업은 없어진다. */
const LAST_PERIOD = 7;
/* 괄호 안이 "712, 진로박람회" 처럼 뒤에 글자가 붙기도 한다 — 앞의 숫자만 읽는다 */
const SEAT_ACTS = [
  { name: '동아리', code: 'G', re: /동아리\s*\(\s*([0-9]+)\s*[,)]/ },
  { name: '진로', code: 'CE', re: /진로\s*\(\s*([0-9]+)\s*[,)]/ },
];
function seatPlanOfNote(note) {
  const txt = String(note || '');
  for (let i = 0; i < SEAT_ACTS.length; i++) {
    const act = SEAT_ACTS[i], m = txt.match(act.re);
    if (!m) continue;
    const digits = (m[1].match(/[1-7]/g) || []).map(Number);
    if (!digits.length || digits.length >= LAST_PERIOD) continue;
    const n = digits.length, head = LAST_PERIOD - n;
    const rest = [];
    for (let p = 1; p <= LAST_PERIOD; p++) if (digits.indexOf(p) === -1) rest.push(p);
    const seat2per = {}, clubSeat = {}, clubPer = {};
    rest.forEach((p, k) => { seat2per[k + 1] = p; });          // 앞자리 = 남은 교시
    digits.forEach((p, k) => {                                  // 뒷자리 = 그 활동 교시
      const seat = head + 1 + k;
      seat2per[seat] = p; clubSeat[seat] = true; clubPer[p] = true;
    });
    return { seat2per, clubSeat, clubPer, tag: m[1], periods: digits,
             code: act.code, name: act.name };
  }
  return null;
}
const CAL_LABEL = { T: '시험', G: '동아리', A: '자율', CE: '진로', S: '봉사', J: '범교과', SP: '스포츠', AC: '활동', TR: '전환기' };

/* ★학사일정 칸 메모에 적은 양도·보강을 읽는다 — 「손종아T 수업 양도」 「301 보강」 「3-1 빌림」 */
const LEND_GIVE_RE = /양도|내어\s*줌|내어\s*주/;
const LEND_BORROW_RE = /보강|대여|빌림|빌려|빌어/;
function lendOfNote(note, classes) {
  const s = String(note || '');
  let kind = null;
  if (LEND_GIVE_RE.test(s)) kind = 'give';
  else if (LEND_BORROW_RE.test(s)) kind = 'borrow';
  if (!kind) return null;
  const cls = (classes || []).find(c => s.indexOf(String(c)) > -1) || '';
  return { kind, cls, reason: s.trim() };
}
/* 직접 기록(S.lends) + 메모에서 읽은 것. 같은 칸이면 직접 기록이 이긴다. */
function effLends() {
  const out = {};
  Object.keys(S.lends).forEach(k => { out[k] = S.lends[k]; });
  const classesOf = {};
  Object.keys(S.classes).forEach(ck => { const q = ck.split('|'); (classesOf[q[0]] = classesOf[q[0]] || []).push(q[1]); });
  Object.keys(S.calendar).forEach(ds => {
    const c = S.calendar[ds] || {}; const noteAt = c.noteAt || {};
    const plan = seatPlanOfNote(c.note || '');
    const dow = DOW[parseDate(ds).getDay()];
    Object.keys(noteAt).forEach(gp => {
      const q = gp.split('|'); const grade = q[0], p = Number(q[1]); if (!p) return;
      const key = ds + '|' + p; if (out[key]) return;
      const L = lendOfNote(noteAt[gp], classesOf[grade] || []); if (!L) return;
      const per = plan ? plan.seat2per[p] : p;
      let cls = L.cls;
      if (L.kind === 'give') {          // 내어준 건 «그 자리에 있던 내 학급»
        const ck = Object.keys(S.classes).find(k => k.indexOf(grade + '|') === 0
          && (S.classes[k] || []).some(t => t[0] === dow && Number(t[1]) === per));
        cls = ck ? ck.split('|')[1] : (cls || '');
      }
      if (!cls) return;                 // 학급을 모르면 넣지 않는다
      out[key] = { kind: L.kind, grade, cls: String(cls), subject: '', teacher: '', reason: L.reason,
                   fromMemo: true, savedAt: (c.savedAt && c.savedAt[gp]) || '' };
    });
  });
  return out;
}

/* ===================== 상태 ===================== */
// 학기 자료 전체를 메모리에 들고 있는다. 시트와 달리 매번 읽지 않는다.
export const S = {
  settings: null,
  tid: null,
  units: {},      // "3학년|빅발리볼" -> {grade,name,order,lessons:[]}
  classes: {},    // "3학년|301" -> [["수",6]]
  applied: {},    // "3학년|301" -> {종목:[차시...]}
  assigns: {},    // "2026-08-19|1" -> {grade,cls,unit,n}
  moves: {},      // "2026-08-19|6" -> {...}
  calendar: {},   // "2026-08-19" -> {note,holiday,g:{},noteAt:{}}
  bells: [],
  work: null,          // 주간업무계획 (학기와 무관)
  refs: {},       // "수|6" -> [{kind,cls,text,note}]
  lends: {},      // "2026-08-24|1" -> {kind:'borrow'|'give', grade, cls, subject, teacher, reason, savedAt}
  records: {},    // "날짜|교시|학년|학급" -> {memo,photos,videos}
};
let planCache = null;           // 학기 누적 계획 (바뀌면 버린다)
function dirty() { planCache = null; }

/* ===================== 공통 유틸 ===================== */
const pad = n => String(n).padStart(2, '0');
export function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDate(s) { return new Date(String(s) + 'T00:00:00'); }
function mondayOf(d) {
  const day = d.getDay(); const m = new Date(d);
  m.setDate(d.getDate() + (day === 0 ? -6 : 1 - day)); m.setHours(0, 0, 0, 0); return m;
}
function weekDatesFrom(mon) {
  const arr = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(mon); d.setDate(mon.getDate() + i);
    arr.push({ dow: DOW[d.getDay()], date: fmtDate(d) });
  }
  return arr;
}
function nowStr() {
  const d = new Date();
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function gk(grade, cls) { return grade + '|' + cls; }
/* 한 칸(날짜|교시)에 여러 종목을 넣을 수 있다.
   옛 자료는 객체 하나였으므로 읽을 때 목록으로 감싸 준다. */
function asList(v) { return !v ? [] : (Array.isArray(v) ? v.filter(Boolean) : [v]); }
function sameAssign(a, b) {
  if (!a || !b) return false;
  if (a.empty || b.empty) return !!a.empty === !!b.empty;   // 비움 표시끼리는 같다
  // 학년·학급은 양쪽이 다 적혀 있을 때만 따진다 (한 칸에서 하나만 뺄 때는 종목·차시만 온다)
  if (a.grade && b.grade && a.grade !== b.grade) return false;
  if (a.cls && b.cls && String(a.cls) !== String(b.cls)) return false;
  if (a.unit !== b.unit) return false;
  return a.eval ? a.eval === b.eval : (!b.eval && Number(a.n) === Number(b.n));
}
/* 그 칸의 목록을 돌려준다 (없으면 빈 목록) */
function assignsAt(key) { return asList(S.assigns[key]); }
/* 불러올 때 옛 자료(객체 하나)를 목록으로 맞춰 둔다 — 그 뒤로는 어디서나 목록이다 */
function normAssigns(o) {
  const out = {};
  Object.keys(o || {}).forEach(k => { const l = asList(o[k]); if (l.length) out[k] = l; });
  return out;
}
/* 모든 배정을 하나씩 본다. fn 이 true 를 주면 그 하나만 지운다. */
function eachAssign(fn) {
  Object.keys(S.assigns).forEach(k => {
    const keep = assignsAt(k).filter(a => !fn(a, k));
    if (keep.length) S.assigns[k] = keep; else delete S.assigns[k];
  });
}
/* 그 칸에 하나 더 넣는다 (같은 것이 이미 있으면 그대로) */
function addAssignAt(key, a) {
  const l = assignsAt(key).filter(x => !x.empty);   // 수업을 넣으면 «비움» 은 풀린다
  if (!l.some(x => sameAssign(a, x))) l.push(a);
  S.assigns[key] = l;
}
/* ★«몰아서 수업» 으로 넣기 전 준비.
   그 칸에 붙박아 둔 것이 하나도 없는데 자동 계산으로 수업이 들어와 있으면,
   그것부터 붙박아 둔다. 안 그러면 새로 넣는 순간 그 수업이 다음 칸으로 밀려나
   «두 차시를 함께» 가 되지 않는다 — 몰아서가 안 되던 진짜 까닭. */
function pinAutoAt(key, a) {
  if (assignsAt(key).length) return;               // 이미 붙박은 것이 있으면 둘 것 없다
  let rec = null;
  try { rec = planTerm().plan[key] || null; } catch (e) { rec = null; }
  if (!rec || rec.isEval || rec.assigned) return;  // 자동으로 들어온 수업만
  if (rec.grade !== a.grade || String(rec.cls) !== String(a.cls)) return;
  if (rec.unit === a.unit && Number(rec.n) === Number(a.n)) return;   // 같은 차시면 둘 것 없다
  addAssignAt(key, { grade: rec.grade, cls: rec.cls, unit: rec.unit, n: Number(rec.n) });
}

/* Firestore 는 배열 안의 배열을 저장하지 못한다.
   학급시간표 [["수",6],["목",3]] 는 ["수|6","목|3"] 로 바꿔 저장하고, 읽을 때 되돌린다. */
function encClasses(o) {
  const r = {};
  Object.keys(o || {}).forEach(k => {
    r[k] = (o[k] || []).map(s => (Array.isArray(s) ? s[0] + '|' + s[1] : String(s)));
  });
  return r;
}
function decClasses(o) {
  const r = {};
  Object.keys(o || {}).forEach(k => {
    r[k] = (o[k] || []).map(s => {
      if (Array.isArray(s)) return [s[0], Number(s[1])];
      const p = String(s).split('|');
      return [p[0], Number(p[1])];
    });
  });
  return r;
}
/* 저장은 이 함수로만 — 학급시간표는 자동으로 바꿔 넣는다 */
function save(part) {
  S.lastSavedAt = nowStr();
  savePart(S.tid, part, part === 'classes' ? encClasses(S.classes) : S[part], S.lastSavedAt);
}
export function lastSavedAt() { return S.lastSavedAt || ''; }

/* ===================== 컴시간 시간표 받아 두기 ===================== */
/* 컴시간은 http·4082 라 앱이 직접 못 부른다 — 혜원폰 GAS 다리를 거친다.
   받은 것은 이 화면이 열려 있는 동안 들고 있는다(동료 교사 고르기·반영이 같은 자료를 쓰게).
   ★week(v1.65.0) — 다리가 «몇 번째 주»(컴시간이 올려 둔 순서, 1=이번 주·2=다음 주…) 를 받는다.
     week 마다 따로 들고 있는다(이번 주를 보다가 다음 주를 봐도 서로 안 섞이게). */
var comciTTCacheByWeek = {};
async function comciGetTT(fresh, week) {
  week = Number(week) || 1;
  const st = S.settings || {};
  if (!st.comciUrl) return { ok: false, msg: '⚙️ 설정에서 컴시간 다리 주소를 먼저 넣어 주세요' };
  if (!fresh && comciTTCacheByWeek[week]) return { ok: true, tt: comciTTCacheByWeek[week] };
  const base = String(st.comciUrl).trim();
  const url = base + (base.indexOf('?') >= 0 ? '&' : '?')
    + 'key=' + encodeURIComponent(st.comciKey || '') + '&what=tt&week=' + week + (fresh ? '&fresh=1' : '');
  let j;
  try {
    const r = await fetch(url);
    j = await r.json();
  } catch (e) {
    return { ok: false, msg: '컴시간 다리에 닿지 못했습니다 · ' + ((e && e.message) || e) };
  }
  if (!j || !j.ok) return { ok: false, msg: (j && j.error) || '다리가 거절했습니다 (암호를 확인해 주세요)' };
  comciTTCacheByWeek[week] = j.tt || {};
  return { ok: true, tt: comciTTCacheByWeek[week] };
}

/* ===================== 불러오기 ===================== */
/* 받아 온 자료로 S 를 채운다 — 서버에서 받았든 이 기기의 캐시에서 읽었든 같다 */
export function bootstrapApply(settings, d, work) {
  S.settings = settings;
  S.tid = termId(S.settings.year, S.settings.term);
  S.units = d.units || {}; S.classes = decClasses(d.classes || {}); S.applied = d.applied || {};
  S.assigns = normAssigns(d.assigns); S.moves = d.moves || {}; S.calendar = d.calendar || {};
  S.bells = d.bells || []; S.refs = d.refs || {}; S.records = d.records || {};
  S.lends = d.lends || {};
  S.lastSavedAt = d.__savedAt || (S.settings && S.settings.savedAt) || '';
  S._loadedAt = S.lastSavedAt;       // 이 자료가 «언제 저장된 것» 인지 — 서버와 견줄 때 쓴다
  // 주간업무계획은 따로 보관한다 — 없어도 앱은 그대로 뜬다
  S.work = work || null;
  dirty();
}
export function loadedStamp() { return S._loadedAt || ''; }

/* 서버에서 받는다(최신). 자료와 주간업무계획은 서로 안 기다리고 동시에 받는다. */
export async function bootstrapLoad(year, term) {
  const settings = await loadSettings();
  if (year) settings.year = year;
  if (term) settings.term = term;
  const tid = termId(settings.year, settings.term);
  const [d, work] = await Promise.all([loadTerm(tid), loadWork().catch(() => null)]);
  bootstrapApply(settings, d, work);
}

/* 내보낸 JSON 을 그대로 받아 Firestore 에 넣는다 (시트 → 파이어베이스 이전) */
export async function importExport(json) {
  const s = json.settings || {};
  const tid = json.termId || termId(s.year, s.term);
  const data = json.data || {};
  // 사슬로 남은 수업이동을 한 건으로 합친다 (A→B, B→C  =>  A→C)
  data.moves = collapseMoves(data.moves || {});
  // 배열 안의 배열은 Firestore 가 못 받는다 → 문자열로
  data.classes = encClasses(data.classes || {});
  await saveAll(tid, data);
  await saveSettings({
    year: Number(s.year), term: String(s.term),
    termFrom: s.termFrom || '', termTo: s.termTo || '',
    calSourceUrl: s.calSourceUrl || '', driveFolder: DRIVE_FOLDER_NAME
  });
  return { ok: true, tid, counts: json.counts || {} };
}
function collapseMoves(moves) {
  const key = m => m.toDate + '|' + Number(m.toPeriod);
  const out = {};
  Object.keys(moves).forEach(from => {
    const isRelay = Object.keys(moves).some(f2 => f2 !== from && key(moves[f2]) === from);
    if (isRelay) return;                       // 중간 경유지는 버린다
    let cur = moves[from], guard = 0;
    while (guard++ < 20) {
      const nxt = moves[key(cur)];
      if (!nxt || nxt === cur) break;
      cur = nxt;
    }
    out[from] = { ...moves[from], toDate: cur.toDate, toPeriod: cur.toPeriod, reason: cur.reason || moves[from].reason };
  });
  return out;
}

/* ===================== 학사일정 ===================== */
function calAll() {
  const out = { byDate: {}, note: {}, holiday: {}, hasCode: {}, noteAt: {}, savedAt: {}, club: {} };
  Object.keys(S.calendar).forEach(d => {
    const c = S.calendar[d] || {};
    if (c.note) { out.note[d] = c.note; const cb = seatPlanOfNote(c.note); if (cb) out.club[d] = cb; }
    if (c.holiday) out.holiday[d] = true;
    // 학년 칸만 남고 안이 빈 경우가 있다 — 진짜 코드가 있을 때만 '학사일정 있는 날'로 친다
    // 메모만 적고 코드가 없는 칸('')은 학사일정이 아니다 — 시간표·진도표가 같은 눈으로 보게
    const anyCode = c.g && Object.keys(c.g).some(g => Object.keys(c.g[g] || {}).some(p => c.g[g][p]));
    if (anyCode) { out.byDate[d] = c.g; out.hasCode[d] = true; }
    Object.keys(c.noteAt || {}).forEach(k => { out.noteAt[d + '|' + k] = c.noteAt[k]; });
    Object.keys(c.savedAt || {}).forEach(k => { out.savedAt[d + '|' + k] = c.savedAt[k]; });
  });
  Object.keys(out.holiday).forEach(d => { if (out.hasCode[d]) delete out.holiday[d]; });
  return out;
}
function gradesAll() {
  const g = {};
  Object.keys(S.classes).forEach(k => { g[k.split('|')[0]] = true; });
  Object.keys(S.units).forEach(k => { g[k.split('|')[0]] = true; });
  const ks = Object.keys(g);
  return ks.length ? ks : ['2학년', '3학년'];
}
function calendarForWeek(weekDates) {
  const all = calAll(), calendar = {}, dayNotes = {};
  weekDates.forEach(w => {
    const d = w.date, dow = w.dow;
    if (all.note[d] || all.holiday[d]) dayNotes[dow] = { note: all.note[d] || '', holiday: !!all.holiday[d], savedAt: all.savedAt[d + '|day'] || '' };
    const byG = all.byDate[d]; if (!byG) return;
    Object.keys(byG).forEach(g => {
      if (!calendar[g]) calendar[g] = {};
      Object.keys(byG[g]).forEach(p => {
        calendar[g][dow + '|' + p] = { code: byG[g][p], note: all.noteAt[d + '|' + g + '|' + p] || '', savedAt: all.savedAt[d + '|' + g + '|' + p] || '' };
      });
    });
  });
  // 동아리·진로 날은 자리 규칙이 전부를 정한다 — 그 날 표시를 규칙대로 다시 만든다
  weekDates.forEach(w => {
    const cb = all.club[w.date]; if (!cb) return;
    gradesAll().forEach(g => {
      calendar[g] = calendar[g] || {};
      for (let seat = 1; seat <= LAST_PERIOD; seat++) {
        const k = w.dow + '|' + seat, cur = calendar[g][k];
        if (cb.clubSeat[seat]) { calendar[g][k] = { code: cb.code, note: (cur && cur.note) || '', savedAt: (cur && cur.savedAt) || '' }; continue; }
        // 동아리·진로 표시가 엉뚱한 자리에 남아 있으면 지운다 (시험 같은 다른 종류는 그대로)
        if (cur && cur.code === cb.code) delete calendar[g][k];
      }
    });
  });
  Object.keys(dayNotes).forEach(dow => {
    if (!dayNotes[dow].holiday) return;
    let has = false;
    Object.keys(calendar).forEach(g => { for (let p = 1; p <= 7; p++) if (calendar[g][dow + '|' + p]) has = true; });
    if (has) dayNotes[dow].holiday = false;
  });
  return { calendar, dayNotes };
}

/* ===================== 학기 누적 계획 ===================== */
/* GAS 의 planTermLessons_ 를 그대로 옮긴 것.
   종목을 등록 순서대로 이어서, 학기 전체에 걸쳐 차시를 배정한다. */
/* ★차시 자동 배치 — 서버 설정, 기본 꺼짐. 켜면 «날짜 미정» 차시가 학기 순서대로 놓인다 */
function autoPlaceOn() { return !!(S.settings && S.settings.autoPlace); }
/* forceAuto=true 면 설정과 무관하게 자동 배치를 계산한다(굳히기용) — 캐시에 넣지 않는다 */
function planTerm(forceAuto) {
  if (planCache && !forceAuto) return planCache;
  const autoOn = !!forceAuto || autoPlaceOn();
  const from = S.settings && S.settings.termFrom, to = S.settings && S.settings.termTo;
  if (!from || !to) return (planCache = { plan: {}, byLesson: {}, cal: calAll(), lends: effLends(), pushed: {} });
  const cal = calAll();
  const lendsEff = effLends();          // 직접 기록 + 메모에서 읽은 양도·보강

  // 학급별 적용 차시를 종목 순서 → 차시 순으로 이어 붙인다
  const applied = {};
  Object.keys(S.applied).forEach(ck => {
    const [grade] = ck.split('|');
    const list = [];
    Object.keys(S.applied[ck] || {}).forEach(unitName => {
      const u = S.units[grade + '|' + unitName]; if (!u) return;
      (S.applied[ck][unitName] || []).forEach(n => {
        const l = (u.lessons || []).find(x => Number(x.n) === Number(n));
        if (l && l.type !== '수행평가') list.push({ n: l.n, topic: l.topic, type: l.type, unit: unitName, ord: u.order || 0 });
      });
    });
    list.sort((a, b) => (a.ord - b.ord) || (a.n - b.n));
    applied[ck] = list;
  });

  // ★수업 이동으로 들어온 자리 — 학급시간표(S.classes)엔 없는 요일·교시라도, 그 자리에
  //   직접 배정한 차시·수행평가가 있으면 보여야 한다(🤝 수업 대여와 같은 방식).
  //   전에는 이동 기록(S.moves)의 n·topic 스냅샷만 보여 줬고, 이동한 뒤에 그 자리에
  //   새로 배정한 내용은 화면 어디에도 안 보였다(저장은 됐는데 영영 안 보임).
  const movedInHere = {};
  Object.keys(S.moves).forEach(fk => {
    const mm = S.moves[fk]; if (!mm || !mm.toDate || !mm.toPeriod) return;
    const tk = mm.toDate + '|' + mm.toPeriod;
    (movedInHere[tk] = movedInHere[tk] || []).push({ grade: mm.grade, cls: mm.cls });
  });

  // 직접 배정한 차시는 그 자리에 고정하고 자동 줄에서 뺀다
  const fixed = {}, fixedKey = {};
  Object.keys(S.assigns).forEach(k => {
    asList(S.assigns[k]).forEach(a => {
      if (a.empty) {                    // ★비워 둔 칸 — 수업을 놓지 않는다
        if (!fixed[k]) fixed[k] = { grade: a.grade, cls: a.cls, empty: true, assigned: true };
        return;
      }
      const u = S.units[a.grade + '|' + a.unit];
      let rec;
      if (fixed[k] && fixed[k].empty) fixed[k] = null;   // 비움 위에 진짜가 오면 진짜가 주인
      if (a.eval) {                     // 수행평가 — 차시 번호가 없다
        const ev = u && (u.evals || []).find(x => x.id === a.eval);
        rec = { grade: a.grade, cls: a.cls, unit: a.unit, evalId: a.eval, isEval: true,
                n: null, topic: ev ? ev.topic : '수행평가', type: '수행평가', assigned: true };
      } else {
        const l = u && (u.lessons || []).find(x => Number(x.n) === Number(a.n));
        rec = { grade: a.grade, cls: a.cls, unit: a.unit, n: Number(a.n),
                topic: l ? l.topic : '', type: l ? l.type : '수업', assigned: true };
        fixedKey[[a.grade, a.cls, a.unit, a.n].join('|')] = true;   // 자동 줄에서 뺀다
      }
      // 한 칸에 여럿이면 첫 번째가 주인, 나머지는 딸려 붙는다
      if (fixed[k]) (fixed[k].extra = fixed[k].extra || []).push(rec);
      else fixed[k] = rec;
    });
  });
  Object.keys(applied).forEach(ck => {
    const [grade, cls] = ck.split('|');
    applied[ck] = applied[ck].filter(l => !fixedKey[[grade, cls, l.unit, l.n].join('|')]);
  });

  const out = {}, byLesson = {}, idx = {};
  let skipped = {};
  // 학사일정에 밀려 못 한 자리를 차례로 담아 둔다 → 다음에 하는 칸에 '원래 언제였는지' 로 붙는다
  let skipQ = {}, pushed = {};
  // 학사일정에 막힌 자리에 걸려 있던 '직접 배정' 은 다음 수업 칸으로 밀어 준다
  const pendFixed = {};
  const seqOf = {};   // 학급별 누적 수업 횟수 (종목과 무관하게 1,2,3…)
  const place = (ds, p, rec) => {
    const ck = rec.grade + '|' + rec.cls;
    seqOf[ck] = (seqOf[ck] || 0) + 1;
    rec.seq = seqOf[ck];
    out[ds + '|' + p] = rec;
    const put = r => { byLesson[[r.grade, r.cls, r.unit, r.isEval ? 'E' + r.evalId : r.n].join('|')] = ds + '|' + p; };
    put(rec);
    (rec.extra || []).forEach(put);
  };
  let cur = parseDate(from); const endD = parseDate(to); let guard = 0;
  while (cur <= endD && guard++ < 400) {
    const ds = fmtDate(cur), dow = DOW[cur.getDay()];
    // skipped(순연 배지)는 주마다 새로 세지만, 밀린 자리 기록은 주를 넘겨서도 이어진다
    if (dow === '월') skipped = {};
    if (dow !== '토' && dow !== '일' && !cal.holiday[ds]) {
      const dayCal = cal.byDate[ds] || {};
      const club = cal.club[ds] || null;      // 동아리 날이면 자리↔교시가 바뀐다
      // 동아리 날은 자리가 바뀌어서, 직접 배정해 둔 자리에 그 학급 수업이 없어질 수 있다.
      // 그런 배정은 사라지지 않게 그 학급의 다음 수업으로 밀어 둔다.
      for (let p = 1; p <= 7; p++) {
        const fx0 = fixed[ds + '|' + p]; if (!fx0 || fx0.empty) continue;
        const per0 = club ? club.seat2per[p] : p;
        const ck0 = fx0.grade + '|' + fx0.cls;
        const has = (S.classes[ck0] || []).some(s => s[0] === dow && Number(s[1]) === per0);
        if (!has) pendFixed[ck0] = (pendFixed[ck0] || []).concat([fx0]);
      }
      for (let p = 1; p <= 7; p++) {
        const per = club ? club.seat2per[p] : p;     // 이 자리에서 실제로 하는 교시
        const lend = lendsEff[ds + '|' + p] || null;  // 이 자리를 빌려왔는가 · 내어줬는가 (메모 포함)
        /* 자리 하나를 채우는 일. borrowed=true 면 «빌려온» 자리라
           원래 내 수업이 없던 곳이므로 조용히 물러난다(밀림으로 세지 않는다). */
        const runSlot = (ck, borrowed) => {
          const [grade, cls] = ck.split('|');
          const gcal = dayCal[grade];
          const isClub = !!(club && club.clubSeat[p]);
          // ★ 동아리·진로 날은 자리 규칙이 전부를 정한다. 그 날 저장된 동아리/진로 표시는
          //   규칙에 이미 담겨 있으므로 무시하고, 시험 같은 다른 종류만 막는 것으로 본다.
          const code0 = gcal ? gcal[p] : '';
          const skip = club
            ? (isClub || (code0 && code0 !== 'L' && code0 !== club.code))
            : (gcal ? !!(code0 && code0 !== 'L') : !!cal.hasCode[ds]);
          let fx = fixed[ds + '|' + p];
          const mine = fx && String(fx.cls) === String(cls);
          // 빌려온 자리 — 학사일정에 막혔거나 이미 다른 수업이 차 있으면 그냥 물러난다
          if (borrowed && (skip || out[ds + '|' + p])) return;
          // ★비워 둔 칸 — 이 자리엔 수업을 놓지 않고 다음 칸으로 넘긴다 (자동 배정 해제)
          if (mine && fx.empty && !skip) {
            skipped[ck] = (skipped[ck] || 0) + 1;
            (skipQ[ck] = skipQ[ck] || []).push({ date: ds, period: per, seat: p, code: 'EMPTY', label: '비움' });
            return;
          }
          // ★ 학사일정이 막은 교시에는 직접 배정도 놓지 않는다 (동아리 날엔 수업 자체가 없다)
          if (mine && !skip) { if (club) fx = Object.assign({}, fx, { orig: per }); place(ds, p, fx); return; }
          if (skip) {
            skipped[ck] = (skipped[ck] || 0) + 1;
            const code = isClub ? club.code : (gcal ? gcal[p] : '');
            (skipQ[ck] = skipQ[ck] || []).push({ date: ds, period: per, seat: p, code: code, label: CAL_LABEL[code] || '' });
            if (mine && !fx.empty) pendFixed[ck] = (pendFixed[ck] || []).concat([fx]);   // 밀린 직접 배정
            return;
          }
          const take = (rec) => {
            const q = skipQ[ck] || [];
            const from = q.length ? q.shift() : null;
            // ★ 화면 칸은 '자리' 기준이므로 밀림 표시도 자리로 건다 (동아리 날엔 자리≠교시)
            if (from) pushed[from.date + '|' + (from.seat || from.period) + '|' + ck] = { date: ds, period: p };
            rec.shifted = (skipped[ck] || 0) > 0;
            rec.from = from;
            if (club) rec.orig = per;        // 동아리 날은 모든 칸에 원래 교시를 남긴다
            if (borrowed) rec.lend = lend;   // 빌려온 자리라고 칸에 알려 준다
            place(ds, p, rec);
          };
          // 밀려 있던 직접 배정이 있으면 그것부터 한다
          if ((pendFixed[ck] || []).length) {
            const pf = pendFixed[ck].shift();
            take({ grade: pf.grade, cls: pf.cls, unit: pf.unit, n: pf.n,
                   topic: pf.topic, type: pf.type, assigned: true,
                   isEval: !!pf.isEval, evalId: pf.evalId || null,
                   extra: pf.extra || null });   // 몰아서 넣은 것도 함께 밀린다
            return;
          }
          if (!autoOn) return;              // ★자동 배치 꺼짐 — 날짜 미정 차시는 놓지 않는다
          const list = applied[ck] || [], i2 = idx[ck] || 0;
          if (i2 >= list.length) return;
          const l = list[i2];
          take({ grade, cls, n: l.n, topic: l.topic, type: l.type, unit: l.unit });
          idx[ck] = i2 + 1;
        };
        Object.keys(S.classes).forEach(ck => {
          const [grade, cls] = ck.split('|');
          if (!(S.classes[ck] || []).some(s => s[0] === dow && Number(s[1]) === per)) return;
          // ★수업 양도 — 이 자리를 남에게 내어줬다. 그 차시는 다음 수업 칸으로 밀린다.
          if (lend && lend.kind === 'give' && lend.grade === grade && String(lend.cls) === String(cls)) {
            skipped[ck] = (skipped[ck] || 0) + 1;
            (skipQ[ck] = skipQ[ck] || []).push({ date: ds, period: per, seat: p, code: 'GIVE', label: '수업 양도' });
            const fx0 = fixed[ds + '|' + p];
            if (fx0 && String(fx0.cls) === String(cls)) pendFixed[ck] = (pendFixed[ck] || []).concat([fx0]);
            return;
          }
          runSlot(ck, false);
        });
        // ★수업 대여 — 원래 내 수업이 없던 자리를 빌려왔다. 그 학급의 다음 차시를 놓는다.
        if (lend && lend.kind === 'borrow') {
          const bk = lend.grade + '|' + lend.cls;
          const already = (S.classes[bk] || []).some(s => s[0] === dow && Number(s[1]) === per);
          if (!already && S.classes[bk]) runSlot(bk, true);
        }
        // ★수업 이동으로 이 자리에 들어온 학급 — 학급시간표엔 없는 자리라도, 거기에 직접
        //   배정한 차시·수행평가가 있으면 놓는다(없으면 조용히 물러난다 — runSlot(borrowed=true)와 같음)
        (movedInHere[ds + '|' + p] || []).forEach(mi => {
          const bk = mi.grade + '|' + mi.cls;
          const already = (S.classes[bk] || []).some(s => s[0] === dow && Number(s[1]) === per);
          if (!already && S.classes[bk]) runSlot(bk, true);
        });
      }
    }
    cur.setDate(cur.getDate() + 1);
  }
  // 수업이동한 차시는 실제로 하는 날을 옮긴 자리로 알려준다
  Object.keys(S.moves).forEach(fk => {
    const m = S.moves[fk]; if (!m || !m.toDate || !m.toPeriod) return;
    const rec = out[fk]; if (!rec) return;
    byLesson[[rec.grade, rec.cls, rec.unit, rec.n].join('|')] = m.toDate + '|' + m.toPeriod;
    rec.movedTo = m.toDate + '|' + m.toPeriod;
  });
  const res = { plan: out, byLesson, cal, pushed, lends: lendsEff };
  if (!forceAuto) planCache = res;
  return res;
}

function autoPlanForWeek(weekDates) {
  const r = planTerm(), week = {}, pushed = {}, seats = {};
  // 자리마다 어느 학급이 오는지 · 그 자리가 원래 몇 교시인지 (동아리 날은 자리≠교시)
  weekDates.forEach(w => {
    const club = r.cal.club[w.date] || null;
    for (let p = 1; p <= 7; p++) {
      const per = club ? club.seat2per[p] : p;
      Object.keys(S.classes).forEach(ck => {
        if (seats[w.dow + '|' + p]) return;
        if (!(S.classes[ck] || []).some(t => t[0] === w.dow && Number(t[1]) === per)) return;
        const parts = ck.split('|');
        seats[w.dow + '|' + p] = { grade: parts[0], cls: parts[1], orig: club ? per : null };
      });
      // 🤝 빌려온 자리 — 학급시간표엔 없지만 그 시간엔 내 수업이 있다.
      // 이것을 안 알려 주면 자동 배치를 꺼 둔 채로는 칸이 아예 안 생겨 차시를 배정할 수 없다.
      const ldw = (r.lends || {})[w.date + '|' + p];
      if (ldw && ldw.kind === 'borrow' && ldw.cls && !seats[w.dow + '|' + p]) {
        seats[w.dow + '|' + p] = { grade: ldw.grade, cls: String(ldw.cls), orig: club ? per : null, borrow: true };
      }
    }
  });
  weekDates.forEach(w => {
    for (let p = 1; p <= 7; p++) {
      const rec = r.plan[w.date + '|' + p];
      if (rec) week[w.dow + '|' + p] = rec;
      Object.keys(r.pushed || {}).forEach(k => {
        const parts = k.split('|');
        if (parts[0] !== w.date || Number(parts[1]) !== p) return;
        pushed[w.dow + '|' + p] = r.pushed[k];   // 이 칸 수업이 밀려간 곳
      });
    }
  });
  return { week, byLesson: r.byLesson, pushed, seats };
}

/* 이번 주에 걸린 이동·배정만 추려서 화면으로 */
function movesForWeek(weekDates) {
  const inWeek = {}; weekDates.forEach(w => { inWeek[w.date] = true; });
  return Object.keys(S.moves).map(k => {
    const m = S.moves[k], [fd, fp] = k.split('|');
    return {
      grade: m.grade, cls: m.cls, unit: m.unit || '', kind: m.kind || '수업이동',
      fromDate: fd, fromPeriod: Number(fp), toDate: m.toDate, toPeriod: Number(m.toPeriod),
      n: m.n == null ? null : Number(m.n), topic: m.topic || '', reason: m.reason || ''
    };
  }).filter(m => m.fromPeriod && m.toPeriod && (inWeek[m.fromDate] || inWeek[m.toDate]));
}
/* 직접 배정을 «학기 전체» 로 내려보낸다 (양이 작다).
   전엔 이번 주만 보내서, 진도표·회차표에서 다른 주 칸을 열면 배정 창이 그 칸에 든 것을 못 봤다. */
function assignsForWeek(weekDates) {
  const out = [];
  Object.keys(S.assigns).sort().forEach(k => {
    const [d, p] = k.split('|');
    assignsAt(k).forEach(a => out.push({ date: d, period: Number(p), grade: a.grade, cls: a.cls,
      unit: a.unit, n: (a.eval || a.empty) ? null : Number(a.n), eval: a.eval || null, empty: !!a.empty }));
  });
  return out;
}

/* ===================== 화면이 부르는 함수들 ===================== */
/* 학급 이름을 숫자 순서로 (2-1, 2-2 … 2-5 / 301, 302 … 305) */
function clsCmp(a, b) {
  const na = String(a).match(/\d+/g) || [], nb = String(b).match(/\d+/g) || [];
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = Number(na[i] || 0), y = Number(nb[i] || 0);
    if (x !== y) return x - y;
  }
  return String(a).localeCompare(String(b));
}
function gradesTree() {
  const grades = {};
  const G = g => (grades[g] = grades[g] || { classes: [], slots: {}, units: [] });
  G('2학년'); G('3학년');
  Object.keys(S.classes).forEach(ck => {
    const [grade, cls] = ck.split('|');
    const g = G(grade);
    if (g.classes.indexOf(cls) === -1) g.classes.push(cls);
    g.slots[cls] = (S.classes[ck] || []).map(s => [s[0], Number(s[1])]);
  });
  Object.keys(grades).forEach(g => grades[g].classes.sort(clsCmp));   // 학급은 늘 순서대로
  const byOrder = Object.keys(S.units).sort((a, b) => (S.units[a].order || 0) - (S.units[b].order || 0));
  byOrder.forEach(uk => {
    const u = S.units[uk], g = G(u.grade);
    const obj = { name: u.name, lessons: (u.lessons || []).slice().sort((a, b) => a.n - b.n),
                  evals: (u.evals || []).slice(), applied: {} };
    g.classes.forEach(c => { obj.applied[c] = []; });
    Object.keys(S.applied).forEach(ck => {
      const [grade, cls] = ck.split('|');
      if (grade !== u.grade) return;
      const arr = (S.applied[ck] || {})[u.name];
      if (arr) obj.applied[cls] = arr.slice().sort((a, b) => a - b);
    });
    g.units.push(obj);
  });
  return grades;
}

const API = {
  getBootstrapData() {
    const t0 = Date.now();
    const weekDates = weekDatesFrom(mondayOf(new Date()));
    const ci = calendarForWeek(weekDates);
    return {
      version: APP_VERSION, deployedAt: DEPLOYED_AT || (S.settings && S.settings.savedAt) || '',
      sheetUrl: '', appUrl: '',
      calSource: { url: (S.settings && S.settings.calSourceUrl) || '', savedAt: '' },
      term: { year: S.settings.year, term: S.settings.term },
      dayNotes: ci.dayNotes, calendar: ci.calendar,
      grades: gradesTree(), weekDates, refs: S.refs, bells: S.bells, lends: planTerm().lends,
      moves: movesForWeek(weekDates), assigns: assignsForWeek(weekDates),
      autoPlan: autoPlanForWeek(weekDates),
      autoPlace: autoPlaceOn(), autoPlaceSavedAt: (S.settings && S.settings.autoPlaceSavedAt) || '',
      lastSavedAt: S.lastSavedAt || '',
      ms: Date.now() - t0
    };
  },

  getWeekData(mondayStr) {
    const weekDates = weekDatesFrom(parseDate(mondayStr));
    const ci = calendarForWeek(weekDates);
    return {
      weekDates, calendar: ci.calendar, dayNotes: ci.dayNotes, refs: S.refs, lends: planTerm().lends,
      moves: movesForWeek(weekDates), assigns: assignsForWeek(weekDates),
      autoPlan: autoPlanForWeek(weekDates)
    };
  },

  /* ---- 종목·차시 ---- */
  addUnit(grade, unitName) {
    const k = grade + '|' + unitName;
    if (!S.units[k]) {
      const order = Object.keys(S.units).length;
      S.units[k] = { grade, name: unitName, order, lessons: [{ n: 1, topic: '1차시', detail: '', type: '수업' }] };
    }
    dirty(); save('units'); return { ok: true };
  },
  /* ---- 자료 정리: 수행평가로 표시된 차시를 수행평가 목록으로 ----
     차시 번호를 안 매기는 쪽으로 바꾸면서, 이미 만들어 둔 것들을 옮긴다.
     preview 로 먼저 보여주고 apply 로 옮긴다. */
  previewEvalSplit() {
    const out = [];
    Object.keys(S.units).sort().forEach(uk => {
      const u = S.units[uk], [grade, name] = uk.split('|');
      const ls = (u.lessons || []).slice().sort((a, b) => Number(a.n) - Number(b.n));
      const moved = ls.filter(l => l.type === '수행평가');
      if (!moved.length) return;
      const keep = ls.filter(l => l.type !== '수행평가');
      const renum = {};                       // 옛 차시 번호 -> 새 차시 번호
      keep.forEach((l, i) => { renum[Number(l.n)] = i + 1; });
      // 적용현황에서 달라지는 것
      const applied = [];
      Object.keys(S.applied).forEach(ck => {
        if (ck.split('|')[0] !== grade) return;
        const arr = (S.applied[ck] || {})[name]; if (!arr || !arr.length) return;
        const before = arr.slice().sort((a, b) => a - b);
        const after = before.filter(n => renum[Number(n)]).map(n => renum[Number(n)]);
        if (before.join(',') !== after.join(',')) applied.push({ cls: ck.split('|')[1], before, after });
      });
      // 잡아 둔 날짜에서 달라지는 것
      const assigns = [];
      Object.keys(S.assigns).sort().forEach(k => { assignsAt(k).forEach(a => {
        if (!a || a.eval || a.grade !== grade || a.unit !== name) return;
        const old = Number(a.n);
        const ev = moved.find(l => Number(l.n) === old);
        const [d, p] = k.split('|');
        if (ev) assigns.push({ date: d, period: Number(p), cls: a.cls, from: old + '차시', to: '수행평가 · ' + ev.topic });
        else if (renum[old] && renum[old] !== old) assigns.push({ date: d, period: Number(p), cls: a.cls, from: old + '차시', to: renum[old] + '차시' });
      }); });
      out.push({
        grade, unit: name,
        keep: keep.map((l, i) => ({ from: Number(l.n), to: i + 1, topic: l.topic })),
        moved: moved.map(l => ({ from: Number(l.n), topic: l.topic })),
        applied, assigns
      });
    });
    return out;
  },
  applyEvalSplit() {
    const plan = API.previewEvalSplit();
    let units = 0, evals = 0, apps = 0, asg = 0;
    plan.forEach(it => {
      const uk = it.grade + '|' + it.unit, u = S.units[uk]; if (!u) return;
      const ls = (u.lessons || []).slice().sort((a, b) => Number(a.n) - Number(b.n));
      const movedOld = {}; it.moved.forEach(m => { movedOld[m.from] = true; });
      const renum = {}; it.keep.forEach(k => { renum[k.from] = k.to; });
      // 수행평가 목록으로 옮긴다 (순서 유지)
      u.evals = u.evals || [];
      const idOf = {};
      ls.filter(l => movedOld[Number(l.n)]).forEach(l => {
        let n = 1; while (u.evals.some(x => x.id === 'e' + n)) n++;
        const ev = { id: 'e' + n, topic: l.topic, detail: l.detail || '' };
        u.evals.push(ev); idOf[Number(l.n)] = ev.id; evals++;
      });
      // 수업 차시만 남기고 1부터 다시 번호
      u.lessons = ls.filter(l => !movedOld[Number(l.n)]).map(l => ({
        n: renum[Number(l.n)], topic: l.topic, detail: l.detail || '', type: l.type || '수업'
      }));
      units++;
      // 적용현황
      Object.keys(S.applied).forEach(ck => {
        if (ck.split('|')[0] !== it.grade) return;
        const arr = (S.applied[ck] || {})[it.unit]; if (!arr) return;
        const after = arr.map(Number).filter(n => renum[n]).map(n => renum[n]).sort((a, b) => a - b);
        if (after.join(',') !== arr.slice().sort((a, b) => a - b).join(',')) apps++;
        S.applied[ck][it.unit] = after;
      });
      // 잡아 둔 날짜
      eachAssign(a => {
        if (!a || a.eval || a.grade !== it.grade || a.unit !== it.unit) return false;
        const old = Number(a.n);
        if (idOf[old]) { delete a.n; a.eval = idOf[old]; asg++; return false; }
        if (renum[old]) { if (renum[old] !== old) asg++; a.n = renum[old]; return false; }
        return true;                     // 어디에도 없으면 뺀다
      });
    });
    dirty(); save('units'); save('applied'); save('assigns');
    return { ok: true, units, evals, applied: apps, assigns: asg, savedAt: S.lastSavedAt };
  },


  /* ===== 모둠(A·B·C) 경기 일정 메모 (v1.63.0) =====
     «경기평가 제N경기» 로 이름 붙인 수행평가가 날짜를 받으면, 그 날 그 반 진도표 칸에
     «#N경기 (1) 승주네 vs (2) 나은이네» 를 자동으로 적는다. A=1·B=2·C=3 고정, 대진은 A-B·B-C·C-A 순. */
  getTeamRoster() {
    const st = S.settings || {};
    return { ok: true, roster: st.teamRoster || {}, savedAt: st.teamRosterSavedAt || '' };
  },
  setTeamRoster(map) {
    S.settings.teamRoster = map || {};
    S.settings.teamRosterSavedAt = nowStr();
    saveSettings(S.settings); dirty();
    return { ok: true, savedAt: S.settings.teamRosterSavedAt };
  },
  /* 이름에서 성을 떼고 «승주네»·«나은이네» 를 만든다 (받침 있으면 «이네») */
  teamName_(full) {
    const given = String(full || '').trim().length > 1 ? String(full).trim().slice(1) : String(full || '').trim();
    if (!given) return '';
    const last = given.charCodeAt(given.length - 1) - 0xAC00;
    const hasBatchim = last >= 0 && last < 11172 && (last % 28) !== 0;
    return given + (hasBatchim ? '이네' : '네');
  },
  previewGameMemos() { return API.fillGameMemos(true); },
  /* dryRun 이면 저장하지 않고 몇 건이 어떻게 될지만 돌려준다(미리보기) */
  fillGameMemos(dryRun) {
    const roster = (S.settings || {}).teamRoster || {};
    const ORDER = ['A', 'B', 'C'];
    const items = [];
    let noRoster = 0, kept = 0, noMatch = 0;
    Object.keys(S.assigns).forEach(key => {
      const parts = key.split('|'); const date = parts[0], period = Number(parts[1]);
      assignsAt(key).forEach(a => {
        if (!a || !a.eval) return;                      // 수행평가가 아니면 상관없다
        const u = S.units[a.grade + '|' + a.unit]; if (!u) return;
        const ev = (u.evals || []).find(x => x.id === a.eval); if (!ev) return;
        const m = String(ev.topic || '').match(/제\s*(\d+)\s*경기/);
        if (!m) { noMatch++; return; }                   // «경기평가 제N경기» 꼴이 아니면 건드리지 않는다
        const n = Number(m[1]);
        const team = roster[String(a.cls)];
        if (!team || !team.A || !team.B || !team.C) { noRoster++; return; }
        const i = (n - 1) % 3, first = ORDER[i], second = ORDER[(i + 1) % 3];
        const label = x => ORDER.indexOf(x) + 1;
        const text = '#' + n + '경기 (' + label(first) + ') ' + API.teamName_(team[first])
          + ' vs (' + label(second) + ') ' + API.teamName_(team[second]);
        const rk = [date, period, a.grade, a.cls].join('|');
        const cur = S.records[rk];
        const autoBefore = !cur || !cur.memo || /^#\d+경기 /.test(cur.memo);
        if (!autoBefore) { kept++; return; }              // 선생님이 직접 적은 메모는 건드리지 않는다
        items.push({ date: date, period: period, grade: a.grade, cls: a.cls, n: n, text: text, key: rk });
      });
    });
    if (!dryRun) {
      items.forEach(it => {
        const r = S.records[it.key] = S.records[it.key] || { memo: '', photos: [], videos: [] };
        r.memo = it.text; r.memoAt = nowStr();
      });
      if (items.length) { dirty(); save('records'); }
    }
    items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
    return { ok: true, filled: items.length, noRoster: noRoster, kept: kept, items: items, savedAt: nowStr() };
  },

  /* ---- 수행평가 (종목 안에 있지만 차시 번호는 없다) ---- */
  addEval(grade, unitName, topic) {
    const u = S.units[grade + '|' + unitName]; if (!u) return { ok: false, msg: '종목을 찾지 못했습니다' };
    u.evals = u.evals || [];
    let n = 1; while (u.evals.some(x => x.id === 'e' + n)) n++;
    const ev = { id: 'e' + n, topic: String(topic || '수행평가'), detail: '' };
    u.evals.push(ev);
    dirty(); save('units'); return { ok: true, id: ev.id, savedAt: nowStr() };
  },
  updateEval(grade, unitName, id, topic, detail) {
    const u = S.units[grade + '|' + unitName]; if (!u) return { ok: false, msg: '종목을 찾지 못했습니다' };
    const ev = (u.evals || []).find(x => x.id === id); if (!ev) return { ok: false, msg: '수행평가를 찾지 못했습니다' };
    ev.topic = String(topic || ''); ev.detail = String(detail || '');
    dirty(); save('units'); return { ok: true, savedAt: nowStr() };
  },
  deleteEval(grade, unitName, id) {
    const u = S.units[grade + '|' + unitName]; if (!u) return { ok: false, msg: '종목을 찾지 못했습니다' };
    const before = (u.evals || []).length;
    u.evals = (u.evals || []).filter(x => x.id !== id);
    if (u.evals.length === before) return { ok: false, msg: '수행평가를 찾지 못했습니다' };
    // 잡아 둔 날짜도 함께 치운다
    eachAssign(a => a.eval === id && a.grade === grade && a.unit === unitName);
    dirty(); save('units'); save('assigns'); return { ok: true, savedAt: nowStr() };
  },
  moveEval(grade, unitName, id, dir) {
    const u = S.units[grade + '|' + unitName]; if (!u) return { ok: false, msg: '종목을 찾지 못했습니다' };
    const ls = u.evals || [];
    const i = ls.findIndex(x => x.id === id), j = i + (Number(dir) < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= ls.length) return { ok: false, msg: '더 옮길 수 없습니다' };
    const t = ls[i]; ls[i] = ls[j]; ls[j] = t;
    dirty(); save('units'); return { ok: true, savedAt: nowStr() };
  },
  /* 수행평가 날짜 잡기 — 한 학급이 같은 수행평가를 두 번 하지 않게 앞의 것은 지운다 */
  setEvalAssign(a) {
    eachAssign(x => x.eval === a.eval && x.grade === a.grade && String(x.cls) === String(a.cls)
      && x.unit === a.unit);
    const ek = a.date + '|' + a.period;
    // 몰아서가 아니면 그 칸을 «바꾼다» — 실수로 여러 개가 쌓이지 않게
    if (a.multi) pinAutoAt(ek, a); else delete S.assigns[ek];
    addAssignAt(ek, { grade: a.grade, cls: a.cls, unit: a.unit, eval: a.eval });
    dirty(); save('assigns'); return { ok: true, savedAt: nowStr() };
  },
  /* 이 종목 수행평가를 학급마다 언제 하는지 */
  evalDates(grade, unitName) {
    const out = {};
    Object.keys(S.assigns).forEach(k => {
      const [d, p] = k.split('|');
      assignsAt(k).forEach(a => {
        if (!a.eval || a.grade !== grade || a.unit !== unitName) return;
        (out[a.eval] = out[a.eval] || []).push({ cls: a.cls, date: d, period: Number(p) });
      });
    });
    Object.keys(out).forEach(id => out[id].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.period - y.period)));
    return out;
  },

  addLesson(grade, unitName) {
    const u = S.units[grade + '|' + unitName]; if (!u) return { n: 0 };
    const n = (u.lessons || []).reduce((m, l) => Math.max(m, Number(l.n)), 0) + 1;
    u.lessons.push({ n, topic: n + '차시', detail: '', type: '수업' });
    dirty(); save('units'); return { n };
  },
  updateLesson(grade, unitName, n, topic, detail, type) {
    const u = S.units[grade + '|' + unitName]; if (!u) return { ok: false, msg: '차시를 찾지 못했습니다' };
    const l = (u.lessons || []).find(x => Number(x.n) === Number(n));
    if (!l) return { ok: false, msg: '차시를 찾지 못했습니다' };
    l.topic = String(topic || ''); l.detail = String(detail || '');
    l.type = ['수업', '수행평가', '시험', '행사'].indexOf(type) === -1 ? '수업' : type;
    dirty(); save('units'); return { ok: true, savedAt: nowStr() };
  },
  /* 차시 순서 바꾸기 — 차시 번호는 자리(1,2,3…)로 두고 내용만 맞바꾼다.
     그래야 '이 학급은 3차시까지 한다' 같은 적용 현황이 그대로 유지된다. */
  moveLesson(grade, unitName, n, dir) {
    const u = S.units[grade + '|' + unitName];
    if (!u) return { ok: false, msg: '종목을 찾지 못했습니다' };
    const ls = (u.lessons || []).slice().sort((a, b) => Number(a.n) - Number(b.n));
    const i = ls.findIndex(x => Number(x.n) === Number(n));
    const j = i + (Number(dir) < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= ls.length) return { ok: false, msg: '더 옮길 수 없습니다' };
    const a = ls[i], b = ls[j];
    const keep = { topic: a.topic, detail: a.detail, type: a.type };
    a.topic = b.topic; a.detail = b.detail; a.type = b.type;
    b.topic = keep.topic; b.detail = keep.detail; b.type = keep.type;
    dirty(); save('units');
    return { ok: true, n: Number(b.n), savedAt: nowStr() };
  },
  deleteLesson(grade, unitName, n) {
    const u = S.units[grade + '|' + unitName]; if (!u) return { ok: false, msg: '차시를 찾지 못했습니다' };
    n = Number(n);
    const before = u.lessons.length;
    u.lessons = u.lessons.filter(l => Number(l.n) !== n).map(l => (Number(l.n) > n ? { ...l, n: Number(l.n) - 1 } : l));
    if (u.lessons.length === before) return { ok: false, msg: '차시를 찾지 못했습니다' };
    // 적용현황도 같이 정리
    Object.keys(S.applied).forEach(ck => {
      if (ck.split('|')[0] !== grade) return;
      const arr = (S.applied[ck] || {})[unitName]; if (!arr) return;
      S.applied[ck][unitName] = arr.filter(x => Number(x) !== n).map(x => (Number(x) > n ? Number(x) - 1 : Number(x)));
    });
    // 직접 배정도 정리
    eachAssign(a => {
      if (a.eval || a.grade !== grade || a.unit !== unitName) return false;
      if (Number(a.n) === n) return true;
      if (Number(a.n) > n) a.n = Number(a.n) - 1;
      return false;
    });
    dirty();
    save('units'); save('applied'); save('assigns');
    return { ok: true, savedAt: nowStr() };
  },

  /* ---- 적용 / 날짜 배정 ---- */
  toggleApply(grade, cls, unitName, lessonN, on) {
    const ck = gk(grade, cls);
    S.applied[ck] = S.applied[ck] || {};
    const arr = S.applied[ck][unitName] = S.applied[ck][unitName] || [];
    const i = arr.indexOf(Number(lessonN));
    if (on && i < 0) arr.push(Number(lessonN));
    if (!on && i > -1) arr.splice(i, 1);
    arr.sort((a, b) => a - b);
    dirty(); save('applied'); return { ok: true };
  },
  setLessonAssign(a) {
    // 한 차시는 한 번만 한다. 같은 차시가 다른 날에 이미 고정돼 있으면 지운다.
    // (안 지우면 옛 날짜에도 그대로 남아 '날짜를 바꿔도 안 바뀌는' 것처럼 보인다)
    eachAssign(x => !x.eval && x.grade === a.grade && String(x.cls) === String(a.cls)
      && x.unit === a.unit && Number(x.n) === Number(a.n));
    const lk = a.date + '|' + a.period;
    // 몰아서가 아니면 그 칸을 «바꾼다» — 실수로 여러 개가 쌓이지 않게
    if (a.multi) pinAutoAt(lk, a); else delete S.assigns[lk];
    addAssignAt(lk, { grade: a.grade, cls: a.cls, unit: a.unit, n: Number(a.n) });
    dirty(); save('assigns'); return { ok: true, savedAt: nowStr() };
  },
  /* 한 칸을 통째로 비운다 (one 을 주면 그 하나만 뺀다) */
  clearLessonAssign(dateStr, period, one) {
    const key = dateStr + '|' + period;
    if (one) {
      const keep = assignsAt(key).filter(a => !sameAssign(one, a));
      if (keep.length) S.assigns[key] = keep; else delete S.assigns[key];
    } else delete S.assigns[key];
    dirty(); save('assigns'); return { ok: true, savedAt: nowStr() };
  },
  /* ★끌어다 놓기 — 차시(또는 수행평가) 배정을 다른 칸으로 옮긴다.
     같은 차시는 한 번만 놓이므로 원래 자리는 setLessonAssign/setEvalAssign 이 지워 준다.
     놓는 칸에 있던 배정은 빠진다 — 지우는 것이 아니라 «날짜 미정» 으로 돌아가는 것이다.
     되돌리기를 위해 건드린 자리의 «이전 모습» 을 함께 돌려준다. */
  moveAssignTo(a) {
    if (!a || !a.date || !a.period || !a.grade || !a.cls) return { ok: false, msg: '칸을 알 수 없습니다' };
    const isEval = !!a.eval;
    const same = x => (!!x.eval === isEval) && !x.empty && x.grade === a.grade
      && String(x.cls) === String(a.cls) && x.unit === a.unit
      && (isEval ? x.eval === a.eval : Number(x.n) === Number(a.n));
    const toKey = a.date + '|' + a.period;
    let fromKey = '';
    Object.keys(S.assigns).forEach(k => { if (assignsAt(k).some(same)) fromKey = k; });
    const snap = {};
    const copy = k => JSON.parse(JSON.stringify(assignsAt(k)));
    snap[toKey] = assignsAt(toKey).length ? copy(toKey) : null;
    if (fromKey && fromKey !== toKey) snap[fromKey] = copy(fromKey);
    if (isEval) API.setEvalAssign({ grade: a.grade, cls: a.cls, unit: a.unit, eval: a.eval, date: a.date, period: a.period });
    else API.setLessonAssign({ grade: a.grade, cls: a.cls, unit: a.unit, n: a.n, date: a.date, period: a.period });
    return { ok: true, from: fromKey, undo: snap, savedAt: nowStr() };
  },
  /* 되돌리기 — moveAssignTo 가 준 «이전 모습» 을 그대로 되돌려 놓는다 */
  restoreAssigns(snap) {
    Object.keys(snap || {}).forEach(k => {
      const v = asList(snap[k]);
      if (v.length) S.assigns[k] = v; else delete S.assigns[k];
    });
    dirty(); save('assigns'); return { ok: true, savedAt: nowStr() };
  },

  /* ★배정 해제 — 이 칸의 «차시» 를 전부 뺀다. 시간표 변경(수업 이동)은 건드리지 않는다.
     직접 배정 · 비움 표시 · 이 칸이 얽힌 수업 이동에 실려 있던 차시(이동 기록 자체는 남김).
     옮긴 차시가 어딘가에 직접 배정돼 있으면 그것도 빼서 원래 자리로 되살아나지 않게 한다.
     markEmpty 가 오면(자동 배치가 켜져 자동 수업이 있던 칸) 비움 표시를 두어 칸이 실제로 빈다. */
  clearCell(a) {
    if (!a || !a.date || !a.period) return { ok: false, msg: '칸을 알 수 없습니다' };
    const key = a.date + '|' + a.period;
    let moves = 0, lessons = 0;
    delete S.assigns[key];
    Object.keys(S.moves).forEach(fk => {
      const m = S.moves[fk]; if (!m) return;
      const isTo = m.toDate === a.date && Number(m.toPeriod) === Number(a.period);
      const isFrom = fk === key;
      if (!isTo && !isFrom) return;
      if (a.cls && m.cls && String(m.cls) !== String(a.cls)) return;   // 다른 학급 이동은 손 안 댐
      // ★시간표 변경(수업 이동)은 그대로 둔다. 그 이동에 실려 있던 차시만 뺀다
      if (m.unit && m.n != null) {
        eachAssign(x => !x.eval && !x.empty && x.grade === m.grade && String(x.cls) === String(m.cls)
          && x.unit === m.unit && Number(x.n) === Number(m.n));
        lessons++;
      }
      if (m.n != null || m.topic || m.unit) { m.n = null; m.topic = ''; m.unit = ''; moves++; }
    });
    if (a.markEmpty && a.grade && a.cls) S.assigns[key] = [{ grade: a.grade, cls: String(a.cls), empty: true }];
    dirty(); save('assigns'); save('moves');
    return { ok: true, moves, lessons, savedAt: nowStr() };
  },
  /* ★이 칸 비우기 — 자동으로 채워진 자리도 «해제» 할 수 있게.
     그 자리에 수업을 놓지 않고 그 차시는 다음 수업 칸으로 밀린다.
     되돌리려면 clearLessonAssign(날짜, 교시) 로 표시를 지우면 된다. */
  setSlotEmpty(a) {
    if (!a || !a.grade || !a.cls) return { ok: false, msg: '학급을 알 수 없습니다' };
    S.assigns[a.date + '|' + a.period] = [{ grade: a.grade, cls: String(a.cls), empty: true }];
    dirty(); save('assigns'); return { ok: true, savedAt: nowStr() };
  },
  clearLessonAssignByLesson(grade, cls, unitName, n) {
    eachAssign(a => !a.eval && a.grade === grade && String(a.cls) === String(cls)
      && a.unit === unitName && Number(a.n) === Number(n));
    dirty(); save('assigns'); return { ok: true, savedAt: nowStr() };
  },
  assignLessonDate(a) {
    API.toggleApply(a.grade, a.cls, a.unit, a.n, true);
    API.setLessonAssign(a);
    return { ok: true, savedAt: nowStr(), week: API.getWeekData(a.monday) };
  },
  unassignLessonDate(grade, cls, unitName, n, monday, alsoUncheck) {
    API.clearLessonAssignByLesson(grade, cls, unitName, n);
    if (alsoUncheck) API.toggleApply(grade, cls, unitName, n, false);
    return { ok: true, savedAt: nowStr(), week: API.getWeekData(monday) };
  },


  /* ===================== 컴시간 알리미 =====================
     컴시간은 http + 4082 포트라 브라우저가 직접 못 부른다. 혜원폰 GAS 다리가 대신 받아 준다.
     다리는 이번 주 «바뀐 수업»(자료147)을 changes 로 내려준다. */
  getComciConf() {
    const st = S.settings || {};
    return { ok: true, url: st.comciUrl || '', key: st.comciKey || '', teacher: st.comciTeacher || '',
             savedAt: st.comciSavedAt || '' };
  },
  setComciConf(a) {
    S.settings.comciUrl = String((a && a.url) || '').trim();
    S.settings.comciKey = String((a && a.key) || '').trim();
    S.settings.comciTeacher = String((a && a.teacher) || '').trim();
    S.settings.comciSavedAt = nowStr();
    saveSettings(S.settings); dirty();
    return { ok: true, savedAt: S.settings.comciSavedAt };
  },
  /* 컴시간 학급(3학년 2반)을 내 학급 이름(302 · 3-2)에 맞춘다 */
  comciClassOf(g, c) {
    const want = [String(g * 100 + c), String(g) + String(c)];
    let hit = null;
    Object.keys(S.classes).forEach(k => {
      if (hit) return;
      const p = k.split('|');
      const n = String(p[1]).replace(/[^0-9]/g, '');
      if (want.indexOf(n) >= 0) hit = { grade: p[0], cls: p[1] };
    });
    return hit;
  },

  /* ===== 컴시간에서 동료 교사 가져오기 (v1.61.0) =====
     컴시간 «교사별 시간표»(자료542)로 동료가 언제 어느 학급을 가르치는지 알 수 있다.
     이름은 컴시간이 «김*호» 처럼 가려서 주므로 과목·주당 시수를 같이 보여 준다. */
  async comciTeacherList(fresh) {
    const g = await comciGetTT(!!fresh); if (!g.ok) return g;
    const tt = g.tt, me = String((S.settings || {}).comciTeacher || '').trim();
    const list = (tt.byTeacher || []).map(t => {
      const cnt = {}; let hours = 0;
      (t.days || []).forEach(d => (d.periods || []).forEach(p => {
        if (!p) return; hours++;
        if (p.subject) cnt[p.subject] = (cnt[p.subject] || 0) + 1;
      }));
      const subs = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]);
      return { i: t.i, name: t.name, subject: subs[0] || '', subjects: subs, hours: hours,
               me: !!me && t.name === me };
    }).filter(t => t.hours > 0);          // 수업이 없는 교사(교장·교감)는 뺀다
    return { ok: true, teachers: list, updatedAt: tt.updatedAt || '', cached: !!tt.cached };
  },
  /* 고른 교사의 시간표를 동료 시간표(refs) 에 넣는다.
     mode 'add' = 있던 것은 두고 더한다(같은 칸·같은 사람·같은 학급은 건너뜀) / 'replace' = 동료를 모두 비우고 새로 채운다 */
  async applyComciColleagues(a) {
    const g = await comciGetTT(false); if (!g.ok) return g;
    const me = String((S.settings || {}).comciTeacher || '').trim();
    const ids = {}; ((a && a.ids) || []).forEach(x => { ids[Number(x)] = true; });
    const picks = (g.tt.byTeacher || []).filter(t => ids[Number(t.i)] && t.name !== me);
    if (!picks.length) return { ok: false, msg: '고른 선생님이 없습니다' };
    const replace = !!(a && a.mode === 'replace');
    const refs = {};
    Object.keys(S.refs).forEach(k => {
      if (k.indexOf('__') === 0) return;
      const rest = (S.refs[k] || []).filter(r => r && (r.kind !== '동료' || !replace));
      if (rest.length) refs[k] = rest;
    });
    let added = 0, skipped = 0;
    picks.forEach(t => (t.days || []).forEach(d => (d.periods || []).forEach(p => {
      if (!p || !p.grade || Number(p.p) > 7) return;
      const k = d.dow + '|' + p.p, cls = p.grade + '-' + p.cls;
      const arr = refs[k] = refs[k] || [];
      if (arr.some(r => r.kind === '동료' && r.text === t.name && r.cls === cls)) { skipped++; return; }
      arr.push({ kind: '동료', cls: cls, text: t.name, note: p.subject || '' });
      added++;
    })));
    refs.__savedAt = nowStr();
    S.refs = refs;
    dirty(); save('refs');
    return { ok: true, teachers: picks.length, added: added, skipped: skipped, replaced: replace, savedAt: refs.__savedAt };
  },

  /* ★컴시간이 올려 둔 주 목록 — 지금 다음 주(week=2)가 실제로 있는지 fetch 없이(캐시만으로도) 알려준다.
     weekList 는 어느 주를 불러도 똑같이 온다(그 학교 전체의 목록이라). */
  async comciWeeks(fresh) {
    const got = await comciGetTT(!!fresh, 1);
    if (!got.ok) return got;
    const list = (got.tt.weekList && got.tt.weekList.length) ? got.tt.weekList : [{ week: 1, range: '' }];
    return { ok: true, weeks: list, updatedAt: got.tt.updatedAt || '' };
  },
  /* 다리에서 받아 «내 수업이 걸린 변경» 만 추린다. week 를 안 주면 이번 주(1). */
  async fetchComci(fresh, week) {
    week = Number(week) || 1;
    const st = S.settings || {};
    if (!st.comciUrl) return { ok: false, msg: '⚙️ 설정에서 컴시간 다리 주소를 먼저 넣어 주세요' };
    const got = await comciGetTT(!!fresh, week);
    if (!got.ok) return got;
    const tt = got.tt || {};
    const teachers = (tt.teachers || []).map(t => t.name);
    const me = String(st.comciTeacher || '').trim();
    if (!me) return { ok: false, msg: '⚙️ 설정에서 «내 이름»을 골라 주세요', teachers };

    // ★다리가 내려준 «그 주의 진짜 월요일»(startDate) 로 날짜를 셈한다 — week=2 든 week=1 이든 같은 식으로 맞는다.
    //   다리가 아직 안 주면(옛 판) today 기준 이번 주로 되돌아간다(예전 그대로 동작).
    const mon = tt.startDate ? parseDate(tt.startDate) : mondayOf(new Date());
    const dateOf = dow => {
      const i = DAYS5.indexOf(dow); if (i < 0) return '';
      const d = new Date(mon); d.setDate(mon.getDate() + i); return fmtDate(d);
    };
    /* 학급·요일마다 «내 수업이 빠진 자리» 와 «내 수업이 들어온 자리» 를 모아 짝짓는다 */
    const box = {};
    (tt.changes || []).forEach(c => {
      const mine = c.teacher === me, was = c.fromTeacher === me;
      if (!mine && !was) return;                     // 남의 과목 변경은 상관없다
      if (mine && was) return;                       // 내 수업이 그대로면 바뀐 것이 아니다
      const k = c.grade + '|' + c.cls + '|' + c.dow;
      const b = box[k] = box[k] || { out: [], in: [], grade: c.grade, cls: c.cls, dow: c.dow };
      (mine ? b['in'] : b.out).push(c);
    });

    const items = [];
    Object.keys(box).forEach(k => {
      const b = box[k];
      const hit = API.comciClassOf(b.grade, b.cls);
      const date = dateOf(b.dow);
      if (!date) return;
      const label = b.grade + '학년 ' + b.cls + '반';
      const mk = (kind, o, i) => ({
        kind: kind, week: week, date: date, dow: b.dow,
        grade: hit ? hit.grade : (b.grade + '학년'), cls: hit ? hit.cls : (b.grade + '-' + b.cls),
        known: !!hit, label: label,
        period: o ? o.period : (i ? i.period : 0),
        toPeriod: i ? i.period : 0,
        subject: o ? o.subject : (i ? i.fromSubject : ''),
        teacher: o ? o.teacher : (i ? i.fromTeacher : '')
      });
      const n = Math.max(b.out.length, b['in'].length);
      for (let x = 0; x < n; x++) {
        const o = b.out[x], i = b['in'][x];
        if (o && i) items.push(mk('move', o, i));         // 내 수업이 다른 교시로 옮겨졌다
        else if (o) items.push(mk('give', o, null));      // 내 수업이 없어졌다 (남이 가져감)
        else if (i) items.push(mk('borrow', null, i));    // 내 수업이 새로 생겼다 (내가 받아옴)
      }
    });
    items.sort((a, b2) => (a.date < b2.date ? -1 : a.date > b2.date ? 1 : a.period - b2.period));
    return { ok: true, items: items, teachers: teachers, me: me, week: week, startDate: tt.startDate || '',
             updatedAt: tt.updatedAt || '', cached: !!tt.cached, total: (tt.changes || []).length };
  },
  /* ★함께 보기 — 이번 주·다음 주를 한 번에 받아 합친다. 다음 주가 아직 안 올라와 있으면
     weekList 에 2번이 없으므로 그 주는 부르지 않고 조용히 뺀다(괜히 이번 주를 두 번 보여주지 않게). */
  async fetchComciBoth(fresh) {
    const wk = await API.comciWeeks(!!fresh);
    const have2 = wk.ok && (wk.weeks || []).some(w => Number(w.week) === 2);
    const r1 = await API.fetchComci(fresh, 1);
    if (!r1.ok) return r1;
    if (!have2) return Object.assign({}, r1, { items: r1.items, has2: false });
    const r2 = await API.fetchComci(fresh, 2);
    if (!r2.ok) return Object.assign({}, r1, { has2: false, week2Error: r2.msg });
    return {
      ok: true, items: r1.items.concat(r2.items), teachers: r1.teachers, me: r1.me, has2: true,
      week1: { startDate: r1.startDate, updatedAt: r1.updatedAt, total: r1.total },
      week2: { startDate: r2.startDate, updatedAt: r2.updatedAt, total: r2.total }
    };
  },
  /* 고른 변경을 수업 이동·대여·양도로 넣는다 (kind '컴시간' 으로 표시해 둔다) */
  applyComci(items) {
    const plan = planTerm();
    let moved = 0, gave = 0, borrowed = 0;
    (items || []).forEach(it => {
      if (!it || !it.date || !it.cls) return;
      if (it.kind === 'move') {
        const rec = plan.plan[it.date + '|' + it.period];
        const same = !!(rec && String(rec.cls) === String(it.cls));
        API.setLessonMove({
          fromDate: it.date, fromPeriod: it.period, toDate: it.date, toPeriod: it.toPeriod,
          grade: it.grade, cls: it.cls, kind: '컴시간',
          unit: same ? rec.unit : '', n: same ? rec.n : null, topic: same ? (rec.topic || '') : '',
          reason: '컴시간 ' + (it.subject ? it.subject + ' 와 ' : '') + '맞바꿈'
        });
        moved++;
      } else if (it.kind === 'give') {
        API.setLend({ date: it.date, period: it.period, kind: 'give', grade: it.grade, cls: it.cls,
                      subject: it.subject || '', teacher: it.teacher || '', reason: '컴시간 변경' });
        gave++;
      } else {
        API.setLend({ date: it.date, period: it.period, kind: 'borrow', grade: it.grade, cls: it.cls,
                      subject: it.subject || '', teacher: it.teacher || '', reason: '컴시간 변경' });
        borrowed++;
      }
    });
    return { ok: true, moved: moved, gave: gave, borrowed: borrowed, savedAt: nowStr() };
  },

  /* ---- 수업 이동 ---- */
  setLessonMove(m) {
    S.moves[m.fromDate + '|' + m.fromPeriod] = {
      grade: m.grade, cls: m.cls, unit: m.unit || '',
      kind: ['수업이동', '보강', '컴시간'].indexOf(m.kind) === -1 ? '수업이동' : m.kind,
      toDate: m.toDate, toPeriod: Number(m.toPeriod),
      n: m.n == null ? null : Number(m.n), topic: m.topic || '', reason: m.reason || ''
    };
    dirty(); save('moves'); return { ok: true, savedAt: nowStr() };
  },
  cancelLessonMove(fromDate, fromPeriod) {
    delete S.moves[fromDate + '|' + fromPeriod];
    dirty(); save('moves'); return { ok: true, savedAt: nowStr() };
  },

  /* ---- 학사일정 ---- */
  setCalendarEntry(dateStr, grade, period, code, note) {
    const c = S.calendar[dateStr] = S.calendar[dateStr] || { note: '', holiday: false, g: {}, noteAt: {} };
    if (!c.savedAt) c.savedAt = {};   // 칸마다 마지막 저장시각
    period = Number(period); code = String(code || '').trim();
    const hasNote = note !== undefined && note !== null;
    if (!period) {                       // 교시 0 = 날짜 단위(메모·휴업)
      c.holiday = code === 'H';
      if (hasNote) c.note = String(note);
      c.savedAt.day = nowStr();          // 날짜 메모도 저장시각을 남긴다
      if (!c.holiday && !c.note && !Object.keys(c.g).length) delete S.calendar[dateStr];
    } else {
      c.g[grade] = c.g[grade] || {};
      if (!code && (!hasNote || !note)) {
        delete c.g[grade][period]; delete c.noteAt[grade + '|' + period];
        delete c.savedAt[grade + '|' + period];
        // 빈 껍데기를 남기지 않는다 (남기면 휴업 표시가 지워진다)
        if (!Object.keys(c.g[grade]).length) delete c.g[grade];
        if (!c.holiday && !c.note && !Object.keys(c.g).length) delete S.calendar[dateStr];
      } else {
        c.g[grade][period] = code;
        if (hasNote) c.noteAt[grade + '|' + period] = String(note);
        c.savedAt[grade + '|' + period] = nowStr();
      }
    }
    dirty(); save('calendar'); return { ok: true, savedAt: nowStr() };
  },
  setCalendarDay(dateStr, grade, code) {
    for (let p = 1; p <= 7; p++) API.setCalendarEntry(dateStr, grade, p, code, undefined);
    return { ok: true, savedAt: nowStr() };
  },
  /* 학기 전체에서 같은 요일·교시를 한 번에 지정/삭제.
     매주 반복되는 일정(금요일 1교시 범교과 같은 것)을 하나씩 고치지 않아도 되게 한다. */
  setCalendarWeekly(dow, period, code, note, grades) {
    const from = S.settings.termFrom, to = S.settings.termTo;
    if (!from || !to) return { ok: false, msg: '학기 기간을 먼저 설정해 주세요' };
    const list = (grades && grades.length) ? grades : ['3학년'];
    let n = 0;
    let cur = parseDate(from);
    const endD = parseDate(to);
    let guard = 0;
    while (cur <= endD && guard++ < 400) {
      if (DOW[cur.getDay()] === dow) {
        const ds = fmtDate(cur);
        list.forEach(g => { API.setCalendarEntry(ds, g, period, code, note); });
        n++;
      }
      cur.setDate(cur.getDate() + 1);
    }
    return { ok: true, count: n, savedAt: S.lastSavedAt || nowStr() };
  },

  /* ---- 매주 되풀이되는 학사일정 정리 ----
     금요일 1교시 범교과처럼 학기 내내 같은 요일·교시에 붙어 있는 항목을 모아 보여주고,
     한 번에 지운다. 학년을 따로 고르지 않아도 등록된 모든 학년에서 함께 사라진다. */
  listRepeatCalendar() {
    const from = S.settings.termFrom, to = S.settings.termTo;
    if (!from || !to) return [];
    const bucket = {};
    let cur = parseDate(from);
    const endD = parseDate(to);
    let guard = 0;
    while (cur <= endD && guard++ < 400) {
      const c = S.calendar[fmtDate(cur)];
      if (c && c.g) {
        const dow = DOW[cur.getDay()], ds = fmtDate(cur);
        Object.keys(c.g).forEach(gr => {
          Object.keys(c.g[gr]).forEach(p => {
            const code = c.g[gr][p];
            if (!code || code === 'L') return;
            const k = dow + '|' + p + '|' + code;
            const b = bucket[k] = bucket[k] || { dow: dow, period: Number(p), code: code, grades: {}, dates: [] };
            b.grades[gr] = 1;
            if (b.dates.indexOf(ds) < 0) b.dates.push(ds);
          });
        });
      }
      cur.setDate(cur.getDate() + 1);
    }
    return Object.keys(bucket)
      .map(k => ({
        dow: bucket[k].dow, period: bucket[k].period, code: bucket[k].code,
        grades: Object.keys(bucket[k].grades).sort(), weeks: bucket[k].dates.length
      }))
      .filter(x => x.weeks >= 3 && x.code !== 'G')   // 동아리는 전용 버튼이 따로 관리한다
      .sort((a, b) => (b.weeks - a.weeks) || (a.period - b.period));
  },
  clearRepeatCalendar(dow, period, code) {
    const from = S.settings.termFrom, to = S.settings.termTo;
    if (!from || !to) return { ok: false, msg: '학기 기간을 먼저 설정해 주세요' };
    period = Number(period); code = String(code || '');
    let n = 0;
    let cur = parseDate(from);
    const endD = parseDate(to);
    let guard = 0;
    while (cur <= endD && guard++ < 400) {
      if (DOW[cur.getDay()] === dow) {
        const c = S.calendar[fmtDate(cur)];
        if (c && c.g) {
          Object.keys(c.g).forEach(gr => {
            if (c.g[gr][period] !== code) return;
            delete c.g[gr][period];
            if (c.noteAt) delete c.noteAt[gr + '|' + period];
            if (c.savedAt) delete c.savedAt[gr + '|' + period];
            if (!Object.keys(c.g[gr]).length) delete c.g[gr];   // 빈 껍데기 치우기
            n++;
          });
          if (!c.holiday && !c.note && !Object.keys(c.g).length) delete S.calendar[fmtDate(cur)];
        }
      }
      cur.setDate(cur.getDate() + 1);
    }
    dirty(); save('calendar');
    return { ok: true, count: n, savedAt: S.lastSavedAt };
  },

  setDayNote(dateStr, note, holiday) {
    return API.setCalendarEntry(dateStr, '공통', 0, holiday ? 'H' : '', String(note || ''));
  },

  /* ---- 학급시간표 ---- */
  setClassSlot(grade, dow, period, cls) {
    Object.keys(S.classes).forEach(ck => {
      if (ck.split('|')[0] !== grade) return;
      S.classes[ck] = S.classes[ck].filter(s => !(s[0] === dow && Number(s[1]) === Number(period)));
    });
    if (cls) {
      const ck = gk(grade, cls);
      S.classes[ck] = S.classes[ck] || [];
      S.classes[ck].push([dow, Number(period)]);
    }
    Object.keys(S.classes).forEach(ck => { if (!S.classes[ck].length) delete S.classes[ck]; });
    dirty(); save('classes'); return { ok: true };
  },
  renameClass(grade, oldName, newName) {
    const from = gk(grade, oldName), to = gk(grade, newName);
    if (S.classes[from]) { S.classes[to] = S.classes[from]; delete S.classes[from]; }
    if (S.applied[from]) { S.applied[to] = S.applied[from]; delete S.applied[from]; }
    eachAssign(a => { if (a.grade === grade && a.cls === oldName) a.cls = newName; return false; });
    Object.keys(S.moves).forEach(k => { const m = S.moves[k]; if (m.grade === grade && m.cls === oldName) m.cls = newName; });
    dirty();
    ['classes', 'applied', 'assigns', 'moves'].forEach(p => save(p));
    return { ok: true };
  },
  deleteClass(grade, clsName) {
    const ck = gk(grade, clsName);
    delete S.classes[ck]; delete S.applied[ck];
    eachAssign(a => a.grade === grade && a.cls === clsName);
    Object.keys(S.moves).forEach(k => { const m = S.moves[k]; if (m.grade === grade && m.cls === clsName) delete S.moves[k]; });
    dirty();
    ['classes', 'applied', 'assigns', 'moves'].forEach(p => save(p));
    return { ok: true };
  },

  /* ---- 동아리 날 ----
     동아리는 학사일정 메모 "동아리(345)" 에서 자동으로 계산한다(clubOfNote).
       원래 하루는 1·2·3·4 — 점심 — 5·6·7. 동아리는 늘 오후(뒤 자리)에 한다.
       매번 같은 교시만 빠지지 않게 그 날은 교시 순서를 바꾼다.
       동아리(345) → 뒤 세 자리에 3·4·5교시를 넣고, 남은 1·2·6·7 을 앞자리에 순서대로.
     그래서 교시에 'G' 를 직접 써 둘 필요가 없다. 예전 🎪 버튼이 써 놓은 표시는
     새 규칙과 겹치므로 아래 두 기능으로 확인하고 지운다. */
  listClubMarks() {
    const out = [];
    Object.keys(S.calendar).sort().forEach(d => {
      const c = S.calendar[d] || {};
      const cb = seatPlanOfNote(c.note || '');
      if (!cb) return;
      const marks = [];
      Object.keys(c.g || {}).forEach(gr => {
        Object.keys(c.g[gr] || {}).forEach(p => {
          if (c.g[gr][p] === cb.code) marks.push({ grade: gr, period: Number(p) });
        });
      });
      const seats = Object.keys(cb.clubSeat).map(Number).sort((a, b) => a - b);
      out.push({
        date: d, note: c.note || '', tag: cb.tag, kind: cb.name,
        seats: seats,                                   // 실제 동아리 자리
        periods: seats.map(s => cb.seat2per[s]),        // 그 자리에서 하던 교시
        marks: marks.sort((a, b) => a.period - b.period)
      });
    });
    return out;
  },
  clearClubMarks() {
    let n = 0, days = 0;
    API.listClubMarks().forEach(it => {
      if (!it.marks.length) return;
      days++;
      const c = S.calendar[it.date];
      it.marks.forEach(m => {
        if (!c.g[m.grade]) return;
        delete c.g[m.grade][m.period];
        if (c.noteAt) delete c.noteAt[m.grade + '|' + m.period];
        if (c.savedAt) delete c.savedAt[m.grade + '|' + m.period];
        if (!Object.keys(c.g[m.grade]).length) delete c.g[m.grade];
        n++;
      });
      if (!c.holiday && !c.note && !Object.keys(c.g).length) delete S.calendar[it.date];
    });
    dirty(); save('calendar');
    return { ok: true, count: n, days: days, savedAt: S.lastSavedAt };
  },

  /* ---- 학급을 다른 학년으로 옮기기 (학년을 잘못 넣었을 때) ---- */
  /* 학급 이름 앞자리가 학년을 뜻한다고 본다: "2-1"·"201" -> 2학년, "301" -> 3학년 */
  gradeOfClassName(cls) {
    const m = String(cls).trim().match(/^(\d)/);
    return m ? m[1] + '학년' : '';
  },
  /* 등록된 학년과 이름이 어긋나는 학급을 찾아준다 */
  findGradeMismatch() {
    const out = [];
    Object.keys(S.classes).forEach(ck => {
      const [grade, cls] = ck.split('|');
      const guess = API.gradeOfClassName(cls);
      if (guess && guess !== grade) out.push({ cls, from: grade, to: guess });
    });
    return out;
  },
  /* 찾은 것들을 실제로 옮긴다 (시간표·적용현황·배정·수업이동 전부 함께) */
  fixGradeMismatch(list) {
    const items = list && list.length ? list : API.findGradeMismatch();
    if (!items.length) return { ok: true, moved: 0, savedAt: nowStr() };
    items.forEach(it => {
      const from = gk(it.from, it.cls), to = gk(it.to, it.cls);
      if (S.classes[from]) { S.classes[to] = S.classes[from]; delete S.classes[from]; }
      if (S.applied[from]) { S.applied[to] = S.applied[from]; delete S.applied[from]; }
      eachAssign(a => {
        if (a.grade === it.from && String(a.cls) === String(it.cls)) a.grade = it.to;
        return false;
      });
      Object.keys(S.moves).forEach(k => {
        const m = S.moves[k];
        if (m.grade === it.from && String(m.cls) === String(it.cls)) m.grade = it.to;
      });
    });
    dirty();
    ['classes', 'applied', 'assigns', 'moves'].forEach(k => save(k));
    return { ok: true, moved: items.length, items, savedAt: S.lastSavedAt };
  },

  /* ---- 회차표 — 학급마다 한 학기 수업 회차와 거기 놓인 것 ----
     학사일정으로 수업이 없는 자리·내어준(양도) 자리는 회차에 넣지 않는다. 빌려온 자리는 넣는다. */
  termMeetings(grade) {
    const g = API.getTermGrid();
    if (!g || !g.ok) return { ok: false, msg: (g && g.msg) || '학기 기간을 먼저 설정해 주세요', classes: {}, max: 0 };
    const cal = planTerm().cal;
    const classes = {};
    (g.weeks || []).forEach(w => w.rows.forEach(row => w.dates.forEach((d, i) => {
      const c = row.cells[i]; if (!c || !c.cls || c.grade !== grade) return;
      const ld = planTerm().lends[d.date + '|' + row.period] || null;
      const isGive = !!(ld && ld.kind === 'give' && String(ld.cls) === String(c.cls));
      const m = {
        date: d.date, dow: d.dow, period: row.period, orig: c.orig || null,
        unit: c.unit || '', n: (c.n == null ? null : c.n), topic: c.topic || '',
        isEval: !!c.isEval, evalId: c.evalId || null, assigned: !!c.assigned,
        extra: (c.extra || []).map(e => ({ unit: e.unit, n: e.n, isEval: !!e.isEval, topic: e.topic || '' })),
        movedTo: c.movedTo || '', empty: !!c.empty, borrowed: !!(ld && ld.kind === 'borrow'),
        kind: 'lesson'
      };
      // ★그 시간에 실제로 한 것 — 내어준 시간 · 학사일정 활동은 수업 자리가 아니다
      if (isGive) {
        m.kind = 'give'; m.label = '양도';
        m.note = [ld.subject, ld.teacher, ld.reason].filter(Boolean).join(' · ');
      } else if (c.blocked) {
        m.kind = 'cal';
        const c0 = (c.cal && c.cal[0]) || null;
        m.code = (c0 && c0.code) || '';
        m.label = (c0 && c0.label) || '학사일정';
        m.note = cal.noteAt[d.date + '|' + grade + '|' + row.period] || '';
      }
      if (m.movedTo) {   // ★옮겨간 자리가 활동·시험 등 학사일정이면, 그 회차는 수업이 아니라 그 활동을 한 것
        const q = m.movedTo.split('|'); const dd = q[0], dp = Number(q[1]);
        const gcal = (cal.byDate[dd] || {})[grade]; const club = cal.club[dd] || null;
        const code = gcal ? (gcal[dp] || '') : '';
        const isClub = !!(club && club.clubSeat[dp]);
        const blocked = club ? (isClub || !!(code && code !== 'L' && code !== club.code))
                             : (gcal ? !!(code && code !== 'L') : !!cal.hasCode[dd]);
        m.destBlocked = blocked;
        m.destCode = isClub ? club.code : code;
        m.destLabel = isClub ? club.name : (CAL_LABEL[code] || (blocked ? '학사일정' : ''));
        m.destNote = cal.noteAt[dd + '|' + grade + '|' + dp] || '';
      }
      (classes[c.cls] = classes[c.cls] || []).push(m);
    })));
    let max = 0;
    Object.keys(classes).forEach(k => {
      classes[k].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
      let seq = 0;
      classes[k].forEach(m => { m.slot = null; if (m.kind === 'lesson') { m.seq = ++seq; } });   // 회차 번호는 수업 자리만
      classes[k].forEach((m, i) => { m.slot = i + 1; });
      if (classes[k].length > max) max = classes[k].length;
    });
    return { ok: true, grade, classes, max };
  },

  /* 모든 학년의 회차표를 한 번에 — 학급이 있는 학년 전부 */
  termMeetingsAll() {
    const grades = {};
    let okAll = true, msg = '';
    gradesAll().forEach(g => {
      const r = API.termMeetings(g);
      if (!r.ok) { okAll = false; msg = r.msg || msg; }
      grades[g] = { classes: r.classes || {}, max: r.max || 0 };
    });
    return { ok: okAll, msg, grades };
  },

  /* ---- 차시 자동 배치 (서버 설정) ---- */
  getAutoPlace() {
    return { ok: true, on: autoPlaceOn(), savedAt: (S.settings && S.settings.autoPlaceSavedAt) || '' };
  },
  setAutoPlace(on) {
    S.settings.autoPlace = !!on;
    S.settings.autoPlaceSavedAt = nowStr();
    saveSettings(S.settings);
    dirty();
    return { ok: true, on: S.settings.autoPlace, savedAt: S.settings.autoPlaceSavedAt };
  },

  /* ---- 자동 배치 굳히기 ----
     지금 자동으로 놓여 있는 차시를 «그 자리에» 직접 배정으로 저장한다.
     그러면 자동 배치를 꺼도 지금 시간표가 그대로 남는다. 두 번 해도 겹치지 않는다. */
  previewFreeze() {
    const r = planTerm(true);                    // 설정과 무관하게 자동 자리를 계산
    const items = [], byClass = {};
    Object.keys(r.plan).sort().forEach(k => {
      const rec = r.plan[k];
      if (!rec || rec.assigned || rec.isEval || rec.n == null) return;   // 자동으로 놓인 수업 차시만
      const a = { grade: rec.grade, cls: String(rec.cls), unit: rec.unit, n: Number(rec.n) };
      if (assignsAt(k).some(x => sameAssign(a, x))) return;               // 이미 굳혀진 것
      const [date, period] = k.split('|');
      items.push(Object.assign({ date, period: Number(period), topic: rec.topic || '' }, a));
      byClass[a.cls] = (byClass[a.cls] || 0) + 1;
    });
    return { ok: true, total: items.length, byClass, items };
  },
  applyFreeze() {
    const p = API.previewFreeze();
    p.items.forEach(it => addAssignAt(it.date + '|' + it.period, { grade: it.grade, cls: it.cls, unit: it.unit, n: it.n }));
    if (p.items.length) { dirty(); save('assigns'); }
    return { ok: true, frozen: p.items.length, byClass: p.byClass, savedAt: nowStr() };
  },

  /* ---- 전환기 일정 한 번에 넣기 ----
     한 줄에 «날짜 교시 행사이름». 교시는 5-7 · 6 · 종일 셋 중 하나.
     메모는 «(5-7교시) 행사이름» 으로 적는다. */
  parseTransition(text, grade) {
    const from = S.settings.termFrom, to = S.settings.termTo;
    const items = [], bad = [];
    String(text || '').split('\n').forEach((ln, i) => {
      const line = ln.trim();
      if (!line || line.charAt(0) === '#') return;
      const m = line.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s+(종일|\d\s*-\s*\d|\d)\s*(.*)$/);
      if (!m) { bad.push({ no: i + 1, line, why: '«11/3 5-7 행사이름» 꼴로 적어 주세요' }); return; }
      const mo = Number(m[1]), dy = Number(m[2]);
      const tag = m[3].replace(/\s+/g, ''), name = (m[4] || '').trim();
      if (!name) { bad.push({ no: i + 1, line, why: '행사 이름이 없습니다' }); return; }
      if (mo < 1 || mo > 12 || dy < 1 || dy > 31) {
        bad.push({ no: i + 1, line, why: '없는 날짜입니다' }); return;
      }
      // 학년도 안에서 연도를 고른다 — 3~12월은 그 해, 1~2월은 다음 해
      let year = Number(S.settings.year) || new Date().getFullYear();
      if (mo <= 2) year += 1;
      let date = year + '-' + pad(mo) + '-' + pad(dy);
      // 2/30 처럼 그 달에 없는 날은 Date 가 다음 달로 넘어간다 — 그걸로 걸러 낸다
      const chk = parseDate(date);
      if (chk.getMonth() + 1 !== mo || chk.getDate() !== dy) {
        bad.push({ no: i + 1, line, why: '없는 날짜입니다' }); return;
      }
      if (from && to && !(date >= from && date <= to)) {
        const alt = (year + (mo <= 2 ? -1 : 1)) + '-' + pad(mo) + '-' + pad(dy);
        if (alt >= from && alt <= to) date = alt;
        else { bad.push({ no: i + 1, line, why: '학기 기간(' + from + '~' + to + ') 밖입니다' }); return; }
      }
      let periods;
      if (tag === '종일') periods = [1, 2, 3, 4, 5, 6, 7];
      else if (tag.indexOf('-') > -1) {
        const a = Number(tag.split('-')[0]), b = Number(tag.split('-')[1]);
        periods = []; for (let p = Math.min(a, b); p <= Math.max(a, b); p++) periods.push(p);
      } else periods = [Number(tag)];
      periods = periods.filter(p => p >= 1 && p <= LAST_PERIOD);
      if (!periods.length) { bad.push({ no: i + 1, line, why: '교시를 알아볼 수 없습니다' }); return; }
      items.push({ no: i + 1, date, tag, periods, name,
                   memo: '(' + (tag === '종일' ? '종일' : tag + '교시') + ') ' + name });
    });
    return { items, bad };
  },
  /* 그 날의 «교시 → 자리» 표. 동아리·진로 날이 아니면 그대로. */
  seatsOfDate(dateStr, periods) {
    const c = S.calendar[dateStr] || {};
    const plan = seatPlanOfNote(c.note || '');
    if (!plan) return periods.map(p => ({ seat: p, per: p, act: '' }));
    const per2seat = {};
    Object.keys(plan.seat2per).forEach(s => { per2seat[plan.seat2per[s]] = Number(s); });
    return periods.map(p => {
      const seat = per2seat[p] || p;
      return { seat, per: p, act: plan.clubSeat[seat] ? plan.name : '' };
    });
  },
  previewTransition(text, grade) {
    const g = grade || '3학년';
    const r = API.parseTransition(text, g);
    const out = [];
    r.items.forEach(it => {
      const seats = API.seatsOfDate(it.date, it.periods);
      const c = S.calendar[it.date] || {};
      const cur = (c.g && c.g[g]) || {};
      const noteAt = c.noteAt || {};
      const shifted = seats.some(s => s.seat !== s.per);
      const cells = seats.map(s => {
        const was = cur[s.seat] || '';
        const wasNote = noteAt[g + '|' + s.seat] || '';
        return {
          seat: s.seat, per: s.per, act: s.act,
          was: was ? (CAL_LABEL[was] || was) : '',
          wasNote,
          same: was === 'TR' && wasNote === it.memo,
          keep: !!s.act                      // 동아리·진로 자리는 건드리지 않는다
        };
      });
      out.push({ no: it.no, date: it.date, dow: DOW[parseDate(it.date).getDay()],
                 tag: it.tag, name: it.name, memo: it.memo, shifted, cells });
    });
    return { ok: true, grade: g, items: out, bad: r.bad, savedAt: S.trSavedAt || '' };
  },
  applyTransition(text, grade) {
    const g = grade || '3학년';
    const p = API.previewTransition(text, g);
    let days = 0, cells = 0, skipped = 0;
    p.items.forEach(it => {
      let touched = 0;
      it.cells.forEach(c => {
        if (c.keep) { skipped++; return; }   // 동아리·진로 자리는 그대로 둔다
        if (c.same) return;
        API.setCalendarEntry(it.date, g, c.seat, 'TR', it.memo);
        cells++; touched++;
      });
      if (touched) days++;
    });
    S.trSavedAt = nowStr();
    S.trText = String(text || '');
    S.trGrade = g;
    // 다시 열어도 적어 둔 목록과 저장시각이 그대로 보이게 설정에 남긴다
    S.settings.trSavedAt = S.trSavedAt; S.settings.trText = S.trText; S.settings.trGrade = g;
    saveSettings(S.settings);
    return { ok: true, days, cells, skipped, bad: p.bad, savedAt: S.trSavedAt };
  },
  transitionInfo() {
    return { ok: true, text: S.trText || (S.settings && S.settings.trText) || '',
             grade: S.trGrade || (S.settings && S.settings.trGrade) || '3학년',
             savedAt: S.trSavedAt || (S.settings && S.settings.trSavedAt) || '' };
  },

  /* ---- 수업 대여 · 수업 양도 ----
     대여 = 남의 수업 한 차시를 빌려온다 (원래 내 수업이 없던 자리에 내 수업이 생긴다)
     양도 = 내 수업 한 차시를 내어준다 (그 자리 수업이 없어지고 다음 칸으로 밀린다)
     어느 교과 · 어느 교사 · 무슨 사유인지 함께 적어 둔다. */
  setLend(a) {
    const key = a.date + '|' + a.period;
    const kind = a.kind === 'borrow' ? 'borrow' : 'give';
    if (!a.grade || !a.cls) return { ok: false, msg: '학급을 먼저 고르세요' };
    S.lends[key] = {
      kind, grade: a.grade, cls: String(a.cls),
      subject: String(a.subject || '').trim(),
      teacher: String(a.teacher || '').trim(),
      reason: String(a.reason || '').trim(),
      savedAt: nowStr()
    };
    dirty(); save('lends');
    return { ok: true, savedAt: S.lends[key].savedAt };
  },
  clearLend(dateStr, period) {
    delete S.lends[dateStr + '|' + period];
    dirty(); save('lends');
    return { ok: true, savedAt: nowStr() };
  },
  lendAt(dateStr, period) {
    return { ok: true, lend: planTerm().lends[dateStr + '|' + period] || null };
  },

  /* ---- 동료 교사 시간표 ----
     2학기는 모두 체육관이라 «누가 언제 쓰는가» 만 적는다. 장소는 안 쓴다.
     한 칸에 한 줄로 적고, 여럿이면 콤마로 나눈다 — "김OO 3-2, 박OO 2-1".
     학기 내내 되풀이되므로 날짜가 아니라 «요일|교시» 로 잡아 둔다. */
  colleagueInfo() {
    const grid = {};
    Object.keys(S.refs).forEach(k => {
      if (k.indexOf('__') === 0) return;
      const s = (S.refs[k] || []).filter(r => r && r.kind === '동료')
        .map(r => [r.text, r.cls].filter(Boolean).join(' ')).join(', ');
      if (s) grid[k] = s;
    });
    return { ok: true, grid, savedAt: S.refs.__savedAt || '' };
  },
  setColleagueGrid(map) {
    // 동료가 아닌 것(옛 참고 수업)은 그대로 남긴다
    const keep = {};
    Object.keys(S.refs).forEach(k => {
      if (k.indexOf('__') === 0) return;
      const rest = (S.refs[k] || []).filter(r => r && r.kind !== '동료');
      if (rest.length) keep[k] = rest;
    });
    Object.keys(map || {}).forEach(k => {
      String(map[k] || '').split(',').map(s => s.trim()).filter(Boolean).forEach(one => {
        // 끝에 붙은 «3-2 / 302» 는 학급으로 떼어 낸다
        const m = one.match(/(\d\s*-\s*\d{1,2}|\d{3})\s*$/);
        const cls = m ? m[1].replace(/\s+/g, '') : '';
        const text = (m ? one.slice(0, m.index) : one).trim();
        if (!cls && !text) return;
        (keep[k] = keep[k] || []).push({ kind: '동료', cls, text, note: '' });
      });
    });
    keep.__savedAt = nowStr();
    S.refs = keep;
    dirty(); save('refs');
    return { ok: true, savedAt: keep.__savedAt };
  },
  clearColleagues() {
    return API.setColleagueGrid({});
  },

  /* ---- 날짜 고르기 목록 ---- */
  getClassDates(grade, cls) {
    const from = S.settings.termFrom, to = S.settings.termTo;
    if (!from || !to) return { ok: false, msg: '학기 기간을 먼저 설정해 주세요', list: [] };
    const slots = S.classes[gk(grade, cls)] || [];
    if (!slots.length) return { ok: false, msg: '이 학급의 시간표가 없습니다', list: [] };
    const moved = {};
    Object.keys(S.moves).forEach(k => {
      const m = S.moves[k];
      if (m.grade !== grade || String(m.cls) !== String(cls)) return;
      moved[k] = { date: m.toDate, period: Number(m.toPeriod), kind: m.kind || '수업이동' };
    });
    const cal = calAll(), list = [];
    let cur = parseDate(from); const endD = parseDate(to); let guard = 0;
    while (cur <= endD && guard++ < 400) {
      const ds = fmtDate(cur), dow = DOW[cur.getDay()];
      if (dow !== '토' && dow !== '일' && !cal.holiday[ds]) {
        const dayCal = cal.byDate[ds] || {};
        const club = cal.club[ds] || null;
        for (let p = 1; p <= 7; p++) {
          const per = club ? club.seat2per[p] : p;
          if (!slots.some(s => s[0] === dow && Number(s[1]) === per)) continue;
          const mv = moved[ds + '|' + p];
          if (mv) {
            list.push({
              date: mv.date, dow: DOW[parseDate(mv.date).getDay()], period: mv.period, teach: true,
              note: `${mv.kind} · 원래 ${Number(ds.slice(5, 7))}/${Number(ds.slice(8, 10))} ${p}교시`
            });
            continue;
          }
          const gcal = dayCal[grade];
          const ok = !(club && club.clubSeat[p]) && (gcal ? gcal[p] === 'L' : !cal.hasCode[ds]);
          list.push({ date: ds, dow, period: p, teach: ok, note: cal.note[ds] || '' });
        }
      }
      cur.setDate(cur.getDate() + 1);
    }
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.period - b.period));
    return { ok: true, list };
  },

  /* ---- 학년도·학기 ---- */
  setTerm(year, term) {
    S.settings.year = Number(year); S.settings.term = String(term);
    S.lastSavedAt = nowStr(); saveSettings(S.settings);
    return { ok: true, needReload: true };
  },
  getTermRange() {
    return { from: S.settings.termFrom || '', to: S.settings.termTo || '', auto: false };
  },
  setTermRange(from, to) {
    S.settings.termFrom = from; S.settings.termTo = to;
    S.lastSavedAt = nowStr();
    dirty(); saveSettings(S.settings); return { ok: true, savedAt: S.lastSavedAt };
  },
  async listTerms() { return await fsListTerms(); },

  /* ---- 수업기록 (메모·첨부) ---- */
  getDayRecords(dateStr) {
    const out = {};
    Object.keys(S.records).forEach(k => { if (k.indexOf(dateStr + '|') === 0) out[k] = S.records[k]; });
    return out;
  },
  saveMemo(dateStr, period, grade, cls, unitName, lessonN, memo) {
    const k = [dateStr, period, grade, cls].join('|');
    const r = S.records[k] = S.records[k] || { memo: '', photos: [], videos: [] };
    r.memo = String(memo || '');
    r.memoAt = nowStr();   // 날짜별 조회 메모 칸 아래에 «마지막 저장» 으로 보인다
    save('records'); return { ok: true, savedAt: r.memoAt };
  },
  async uploadAttachment(base64Data, filename, mimeType, dateStr, period, grade, cls) {
    // base64 -> Blob -> 드라이브
    const bin = atob(base64Data);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], filename, { type: mimeType });
    const up = await uploadFile(file, (S.settings && S.settings.driveFolder) || DRIVE_FOLDER_NAME, filename);
    const k = [dateStr, period, grade, cls].join('|');
    const r = S.records[k] = S.records[k] || { memo: '', photos: [], videos: [] };
    (String(mimeType).indexOf('video') === 0 ? r.videos : r.photos).push(up.url);
    save('records');
    return { ok: true, url: up.url, savedAt: nowStr() };
  },

  /* ---- 학기 전체 진도표 (주차별로 쌓아 보는 화면) ---- */
  getTermGrid() {
    /* 그 칸의 수업 기록(4 날짜별 조회에서 쓴 메모·첨부) — 글과 «개수» 만 */
    const recOf = (date, period, grade, cls) => {
      const r = S.records[[date, period, grade, cls].join('|')];
      if (!r) return null;
      const memo = String(r.memo || '').trim();
      const ph = (r.photos || []).length, vd = (r.videos || []).length;
      if (!memo && !ph && !vd) return null;
      return { memo, photos: ph, videos: vd, memoAt: r.memoAt || '' };
    };
    const from = S.settings.termFrom, to = S.settings.termTo;
    if (!from || !to) return { ok: false, msg: '학기 기간을 먼저 설정해 주세요', weeks: [] };
    const r = planTerm(), cal = r.cal;
    const unitOrder = {};
    Object.keys(S.units).sort((a, b) => (S.units[a].order || 0) - (S.units[b].order || 0))
      .forEach((k, i) => { unitOrder[k] = i; });

    const weeks = [];
    let mon = mondayOf(parseDate(from));
    const endD = parseDate(to);
    let wk = 0, guard = 0;
    while (mon <= endD && guard++ < 60) {
      wk++;
      const dates = [];
      for (let i = 0; i < 5; i++) {
        const d = new Date(mon); d.setDate(mon.getDate() + i);
        const ds = fmtDate(d);
        dates.push({
          date: ds, dow: DAYS5[i], md: (d.getMonth() + 1) + '/' + d.getDate(),
          note: cal.note[ds] || '', holiday: !!cal.holiday[ds]
        });
      }
      const rows = [];
      for (let p = 1; p <= 7; p++) {
        const cells = dates.map(x => {
          if (x.holiday) return { holiday: true };
          const club = cal.club[x.date] || null;
          const per = club ? club.seat2per[p] : p;      // 이 자리에서 실제로 하는 교시
          const rec = r.plan[x.date + '|' + p];
          if (rec) {
            const mv = S.moves[x.date + '|' + p];
            return {
              cls: rec.cls, grade: rec.grade, unit: rec.unit, n: rec.n, seq: rec.seq,
              topic: rec.topic || '', type: rec.type || '수업',
              assigned: !!rec.assigned, shifted: !!rec.shifted,
              movedTo: rec.movedTo || '', from: rec.from || null,
              orig: rec.orig || null, isEval: !!rec.isEval, evalId: rec.evalId || null,
              color: unitOrder[rec.grade + '|' + rec.unit] || 0,
              rec: recOf(x.date, p, rec.grade, rec.cls),
              // 한 칸에 여러 종목 — 나머지는 여기 딸려 온다
              extra: (rec.extra || []).map(e => ({
                unit: e.unit, n: e.n, topic: e.topic || '', type: e.type || '수업',
                isEval: !!e.isEval, evalId: e.evalId || null,
                color: unitOrder[e.grade + '|' + e.unit] || 0
              }))
            };
          }
          // 내 수업이 없으면 — 학급시간표에 그 칸이 있으면 학급이라도 보여준다
          const byG = cal.byDate[x.date] || {};
          const codes = [];
          if (club && club.clubSeat[p]) codes.push({ g: '', label: club.name, code: club.code, note: '' });
          else Object.keys(byG).forEach(g => {
            const c = byG[g][p];
            const note = cal.noteAt[x.date + '|' + g + '|' + p] || '';
            // 메모(«마음심리검사» 같은 것)도 함께 — 진도표 칸에 적는다.
            // «수업»(L)은 특별 일정이 아니라 보통 종류 표는 없지만, 적어 둔 메모만은 그대로 보여준다.
            if (c === 'L') { if (note) codes.push({ g: g.replace('학년', ''), label: '', code: c, note }); return; }
            if (c) codes.push({ g: g.replace('학년', ''), label: CAL_LABEL[c] || c, code: c, note });
          });
          let slotCls = '', slotGrade = '';
          Object.keys(S.classes).forEach(ck => {
            if (slotCls) return;
            if (!(S.classes[ck] || []).some(t => t[0] === x.dow && Number(t[1]) === per)) return;
            const parts = ck.split('|'); slotGrade = parts[0]; slotCls = parts[1];
          });
          // 빌려온 자리(🤝 또는 «301 보강» 메모)는 아직 차시가 없어도 그 학급의 빈 칸으로 그린다
          if (!slotCls) {
            const ldb = r.lends[x.date + '|' + p];
            if (ldb && ldb.kind === 'borrow') { slotGrade = ldb.grade; slotCls = String(ldb.cls); }
          }
          if (slotCls) {
            const gcal = byG[slotGrade];
            const c0 = gcal ? gcal[p] : '';
            const blocked = club
              ? (!!club.clubSeat[p] || !!(c0 && c0 !== 'L' && c0 !== club.code))
              : (gcal ? !!(c0 && c0 !== 'L') : !!cal.hasCode[x.date]);
            return { cls: slotCls, grade: slotGrade, noplan: true, blocked: blocked,
                     orig: (club ? per : null),
                     rec: recOf(x.date, p, slotGrade, slotCls),
                     // 비워 둔 칸(자동 배정 해제)인가
                     empty: assignsAt(x.date + '|' + p).some(a => a.empty && String(a.cls) === String(slotCls)),
                     cal: codes.length ? codes : null,
                     pushedTo: (r.pushed || {})[x.date + '|' + p + '|' + slotGrade + '|' + slotCls] || null };
          }
          return codes.length ? { cal: codes } : {};
        });
        rows.push({ period: p, cells, used: cells.some(c => c.cls || c.cal) });
      }
      weeks.push({
        no: wk, monday: fmtDate(mon),
        label: wk + '주차',
        range: `${mon.getMonth() + 1}/${mon.getDate()}(월) ~ ${dates[4].md}(금)`,
        dates, rows
      });
      mon = new Date(mon); mon.setDate(mon.getDate() + 7);
    }
    // 주마다 교시 줄이 달라지면 견주기 어렵다.
    // 학기 전체에서 한 번이라도 쓰인 교시는 모든 주에 똑같이 남긴다.
    const usedP = {};
    weeks.forEach(w => w.rows.forEach(r => { if (r.used) usedP[r.period] = true; }));
    weeks.forEach(w => {
      const has = w.rows.some(r => r.used);
      w.rows = has ? w.rows.filter(r => usedP[r.period]).map(r => ({ period: r.period, cells: r.cells })) : [];
    });
    return { ok: true, weeks, from, to, lends: r.lends };
  },

  /* ---- 시트 전용 기능은 새 앱에 없다 ---- */
  buildTermSheet() { return { ok: false, msg: '시트 기능은 새 앱에 없습니다. 대신 인쇄를 쓰세요.' }; },
  buildWeekSheet() { return { ok: false, msg: '시트 기능은 새 앱에 없습니다. 대신 인쇄를 쓰세요.' }; },
  copyClassTableFrom() { return { ok: false, msg: '아직 준비 중입니다.' }; },
  setCalendarSource(url) {
    S.settings.calSourceUrl = url; saveSettings(S.settings);
    return { ok: true, savedAt: nowStr(), id: '', gid: '' };
  },
  calImportStart() { throw new Error('학사일정 가져오기는 새 앱에서 준비 중입니다.'); },
  calImportStep() { throw new Error('학사일정 가져오기는 새 앱에서 준비 중입니다.'); },
  calImportFinish() { throw new Error('학사일정 가져오기는 새 앱에서 준비 중입니다.'); },
};

/* ===================== google.script.run 흉내내기 ===================== */
/* 화면 코드를 한 줄도 고치지 않고 그대로 쓰기 위한 다리. */
export function installBridge() {
  function makeRunner(onOk, onErr) {
    return new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return cb => makeRunner(cb, onErr);
        if (name === 'withFailureHandler') return cb => makeRunner(onOk, cb);
        return (...args) => {
          Promise.resolve()
            .then(() => {
              const fn = API[name];
              if (!fn) throw new Error('알 수 없는 기능: ' + name);
              return fn.apply(API, args);
            })
            .then(r => {
              // 저장이 일어나는 기능이면 화면의 저장시각을 갱신한다
              if (/^(set|add|update|delete|toggle|clear|assign|unassign|cancel|save)/.test(name)
                  && typeof window.__onSaved === 'function') window.__onSaved(S.lastSavedAt || '');
              if (onOk) onOk(r);
            })
            .catch(e => { if (onErr) onErr(e); else console.error(e); });
        };
      }
    });
  }
  window.google = window.google || {};
  window.google.script = { run: makeRunner(null, null), host: { setHeight() { } } };
}

export { API };
