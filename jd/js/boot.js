// 파일명: boot.js (지비스 모바일용) | @version 1.0.0
// 허브에서 자료를 받아 웹앱 화면을 시작한다. 이 폰에 받아 둔 자료가 있으면 먼저 그것으로 열고, 뒤에서 허브와 맞춘다.
// 가끔(보이는 동안 45초마다 · 다시 앞으로 올 때) 저장시각만 확인해 다른 기기(PC 웹앱·지비스)에서 바뀌었으면 다시 불러온다.

import { termId, loadSettingsCached, loadTermCached, loadWorkCached, remoteStamp, pendingWrites, setConflictHandler } from './db.js';
import { installBridge, bootstrapLoad, bootstrapApply, loadedStamp, S, API } from './server.js';

const $ = id => document.getElementById(id);
const gate = () => $('loginGate');
function show(msg, sub, retry) {
  $('gateMsg').textContent = msg;
  $('gateSub').innerHTML = sub || '';
  ['gateBtn', 'gateImport'].forEach(i => { const e = $(i); if (e) e.classList.add('hidden'); });
  $('gateRetry').classList.toggle('hidden', !retry);
  $('gateLogout').style.display = 'none';
}

installBridge();
window.__weekSync = mondayStr => API.getWeekData(mondayStr);

let opened = false, busy = false;
async function openFromCache() {
  try {
    const st = await loadSettingsCached(); if (!st) return false;
    const d = await loadTermCached(termId(st.year, st.term)); if (!d) return false;
    if (!Object.keys(d.classes || {}).length && !Object.keys(d.units || {}).length) return false;
    bootstrapApply(st, d, await loadWorkCached());
    return true;
  } catch (e) { return false; }
}
async function sync(rerender) {
  const before = loadedStamp();
  await bootstrapLoad();
  if (rerender && loadedStamp() !== before && window.__startApp) window.__startApp();
}
async function start() {
  if (busy) return; busy = true;
  show('자료를 불러오는 중…', '');
  if (await openFromCache()) {
    opened = true; busy = false; gate().classList.add('hidden');
    if (window.__startApp) window.__startApp();
    sync(true).catch(e => console.warn('허브 확인 실패 — 이 폰의 자료로 계속합니다', e));
    return;
  }
  try { await bootstrapLoad(); }
  catch (e) {
    busy = false;
    show('자료를 불러오지 못했습니다', '<span style="color:#b23223">' + String((e && e.message) || e) + '</span>', true);
    return;
  }
  busy = false;
  if (!Object.keys(S.classes).length && !Object.keys(S.units).length) { show('아직 자료가 없습니다', 'PC 의 체육 수업진도 웹앱에서 자료를 먼저 만들어 주세요.', true); return; }
  gate().classList.add('hidden');
  if (window.__startApp) window.__startApp();
}
$('gateRetry').addEventListener('click', () => { busy = false; start(); });
setConflictHandler(() => { sync(true).catch(() => {}); });

/* 다른 기기에서 바뀌었는지 가끔 확인 */
let checking = false;
async function check() {
  if (checking || document.hidden || pendingWrites() || !opened && !S.tid) return;
  checking = true;
  try {
    const r = await remoteStamp(S.tid);
    if (r && r.max && r.max !== loadedStamp() && !pendingWrites()) { await sync(true); }
  } catch (e) { /* 다음에 */ }
  checking = false;
}
setInterval(check, 45000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
start();
