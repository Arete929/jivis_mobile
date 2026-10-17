// 파일명: db.js (지비스 모바일용) | @version 1.0.0
// 체육 수업진도 웹앱의 데이터 계층 — 파이어베이스 대신 «지비스 허브»(op 'jd')로 같은 Firestore 자료를 읽고 쓴다.
// 웹앱의 화면(index.html)과 계산(server.js)은 손대지 않고 이 파일만 바꿔 끼웠다.
//
// ★ 구글 로그인 없음 — 이 폰의 «기기 열쇠»(지비스 모바일이 이미 갖고 있다)로 허브에 말한다. 같은 주소(origin)라 localStorage 를 그대로 읽는다.
// ★ 쓰기는 «줄 세워» 하나씩 허브에 보낸다. 허브는 «내가 마지막으로 본 저장시각» 이 안 맞으면(다른 기기가 먼저 바꿈) 덮지 않고 알려 준다 → 다시 불러온다.
// ★ 받은 자료는 이 폰(localStorage 'jv.jdc')에 담아 두어 다음에 바로 열리게 한다. 지비스 모바일의 «이 폰에서 모두 지우기» 로 함께 지워진다.

const HUB = () => { try { return localStorage.getItem('jv.hub') || ''; } catch (e) { return ''; } };
const KEY = () => { try { return localStorage.getItem('jv.dkey') || ''; } catch (e) { return ''; } };

export const auth = { currentUser: { uid: 'hub' } };
export const db = null;
export const PARTS = ['units', 'classes', 'applied', 'assigns', 'moves', 'calendar', 'bells', 'refs', 'records', 'lends',
  'calbak'];   // calbak = 학사일정 가져오기 직전 백업(되돌리기용) — 진도앱 1.66.0 부터
export function termId(year, term) { return `${year}-${term}`; }
export function nowKST() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ───── 허브 부르기 ───── */
export async function hub(body) {
  const url = HUB(), key = KEY();
  if (!url || !key) throw new Error('이 폰이 허브에 연결돼 있지 않습니다');
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ op: 'jd', key, ...body }), redirect: 'follow', credentials: 'omit' });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { throw new Error('허브가 제대로 답하지 않았습니다'); }
  if (j && j.ok === false && j.code === 'key') { try { window.parent && window.parent.postMessage({ jd: 'key' }, '*'); } catch (e) { /* */ } }
  return j;
}

/* ───── 받기 ─────
   웹앱은 «설정 → 학기 → 주간업무» 순으로 따로 부른다. 허브는 한 번에 다 주므로 첫 부름에 받아 두었다가 이어지는 부름에 나눠 준다. */
let LAST = null;            // { at, res }
const BASE = {};            // 묶음 → 내가 마지막으로 본 저장시각
function remember(res) {
  LAST = { at: Date.now(), res };
  PARTS.forEach(k => { BASE[k] = (res.stamps && res.stamps[k]) || ''; });
  try { localStorage.setItem('jv.jdc', JSON.stringify({ at: Date.now(), res })); } catch (e) { /* 너무 커도 그만 */ }
}
function fresh() { return LAST && Date.now() - LAST.at < 15000 ? LAST.res : null; }
async function fetchAll(tid) {
  const res = await hub({ act: 'load', tid: tid || undefined });
  if (!res || !res.ok) throw new Error((res && res.msg) || '자료를 받지 못했습니다');
  remember(res);
  return res;
}
function toTerm(res) {
  const out = {};
  PARTS.forEach(k => { out[k] = (k === 'bells') ? [] : {}; });
  Object.keys(res.term || {}).forEach(k => { out[k] = res.term[k]; });
  out.__savedAt = res.max || '';
  return out;
}
export async function loadSettings() {
  const res = await fetchAll();
  return res.settings;
}
export async function loadTerm(tid) {
  let res = fresh();
  if (!res || res.tid !== tid) res = await fetchAll(tid);
  return toTerm(res);
}
export async function loadWork() {
  const res = fresh();
  return res ? (res.work || null) : null;
}
export async function listTerms() {
  const res = fresh() || await fetchAll();
  return res.terms || [];
}
/* 이 폰에 받아 둔 것 — 서버를 기다리지 않는다 */
function cached() { try { const c = JSON.parse(localStorage.getItem('jv.jdc') || 'null'); return c && c.res && c.res.ok ? c.res : null; } catch (e) { return null; } }
export async function loadSettingsCached() { const c = cached(); return c ? c.settings : null; }
export async function loadTermCached(tid) {
  const c = cached(); if (!c || c.tid !== tid) return null;
  PARTS.forEach(k => { BASE[k] = (c.stamps && c.stamps[k]) || ''; });
  return toTerm(c);
}
export async function loadWorkCached() { const c = cached(); return c ? (c.work || null) : null; }
/* 다른 기기에서 바뀌었는지 가볍게 — 저장시각만 받는다 */
export async function remoteStamp(tid) {
  const r = await hub({ act: 'stamp', tid });
  return r && r.ok ? r : null;
}
export function watchTerm() { return () => {}; }      // 실시간 구독은 안 한다 — boot.js 가 가끔 확인한다

/* ───── 쓰기: 줄 세우기 ───── */
let queue = [], running = false, failed = 0;
function badge() {
  let el = document.getElementById('jdSave');
  if (!el) {
    el = document.createElement('div'); el.id = 'jdSave'; el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:99999;padding:7px 12px;border-radius:999px;font:700 13px system-ui,sans-serif;background:#222;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3);display:none';
    document.body.appendChild(el);
  }
  return el;
}
function show(text, bad) {
  const el = badge();
  if (!text) { el.style.display = 'none'; return; }
  el.textContent = text; el.style.background = bad ? '#b23223' : '#222'; el.style.display = 'block';
  try { window.parent.postMessage({ jd: 'save', text: text, bad: !!bad }, location.origin); } catch (e) { /* 부모가 없으면 그만 */ }
  el.onclick = bad ? () => { failed = 0; run(); } : null;
}
export function pendingWrites() { return queue.length + (running ? 1 : 0); }
export let onConflict = null;
export function setConflictHandler(fn) { onConflict = fn; }
async function run() {
  if (running) return; running = true;
  while (queue.length) {
    const job = queue[0];
    show('저장 중… (' + queue.length + ')');
    let r;
    try {
      r = job.kind === 'settings'
        ? await hub({ act: 'settings', value: job.value, stamp: job.stamp })
        : await hub({ act: 'save', tid: job.tid, part: job.part, value: job.value, stamp: job.stamp, base: BASE[job.part] === undefined ? '' : BASE[job.part] });
    } catch (e) {
      failed++;
      if (failed >= 4) { show('저장하지 못했습니다 — 눌러서 다시', true); running = false; return; }
      await new Promise(res => setTimeout(res, 1500 * failed)); continue;
    }
    failed = 0;
    if (r && r.ok) { if (job.kind !== 'settings') BASE[job.part] = job.stamp; queue.shift(); continue; }
    if (r && r.conflict) {                     // 다른 기기가 먼저 바꿨다 — 이 줄의 변경은 버리고 다시 불러온다
      queue = queue.filter(j => j.kind === 'settings' ? false : j.part !== job.part);
      show('다른 기기에서 먼저 바뀌어 다시 불러옵니다', true);
      running = false;
      if (onConflict) onConflict(job.part);
      return;
    }
    show((r && r.msg) || '저장하지 못했습니다', true); queue.shift();
  }
  running = false; show('✓ 저장됨'); setTimeout(() => { if (!queue.length) show(''); }, 1800);
}
export function savePart(tid, part, value, stamp) {
  // 같은 묶음의 앞선 대기는 버리고 최신만 — 마지막 값이 이긴다
  queue = queue.filter(j => !(j.kind !== 'settings' && j.part === part && j !== queue[0]));
  queue.push({ kind: 'part', tid, part, value: JSON.parse(JSON.stringify(value === undefined ? null : value)), stamp: stamp || nowKST() });
  run(); return Promise.resolve();
}
export function saveSettings(v) {
  queue = queue.filter(j => j.kind !== 'settings' || j === queue[0]);
  queue.push({ kind: 'settings', value: JSON.parse(JSON.stringify(v || {})), stamp: nowKST() });
  run(); return Promise.resolve();
}
export async function saveAll(tid, data) { Object.keys(data).forEach(k => savePart(tid, k, data[k])); }
export function saveWork() { return Promise.resolve(); }      // 주간업무는 PC 가 올린다

/* 웹앱 화면이 부르는 로그인 관련 이름들 — 여기서는 쓸 일이 없다 */
export function watchAuth(cb) { setTimeout(() => cb(auth.currentUser), 0); return () => {}; }
export async function login() { return auth.currentUser; }
export async function logout() { }
export async function loginBasic() { throw new Error('이 폰에서는 허브로 연결합니다'); }
export async function loginWithIdToken() { return auth.currentUser; }
export async function loginWithAccessToken() { return auth.currentUser; }
export function getDriveToken() { return null; }
export async function refreshDriveToken() { return null; }
