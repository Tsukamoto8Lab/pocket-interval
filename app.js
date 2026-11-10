'use strict';

/* ================================================================
   ポケットインターバル
   - 時刻は「開始時刻からの経過」で毎回計算し、誤差を積み上げない
   - 実行中は Wake Lock で画面をつけたままにする（消えると振動が止まるため）
   ================================================================ */

const STORE_KEY = 'pocket-interval:settings:v1';

const DEFAULTS = {
  run: 60, walk: 60, reps: 10, warmup: 0,
  vibe: true, beep: true, voice: false,
  guard: true, dim: false,
};

const LIMITS = {
  run:    { min: 5, max: 3600, step: 5 },
  walk:   { min: 5, max: 3600, step: 5 },
  reps:   { min: 1, max: 99,   step: 1 },
  warmup: { min: 0, max: 3600, step: 30 },
};

const READY_SEC = 5;     // スタート直後の準備時間（ポケットに入れる時間）
const HOLD_MS = 700;     // 誤タッチ防止の長押し時間
const TICK_MS = 100;     // 画面更新とイベント判定の間隔

/* 振動パターン（ms）。触覚だけで区別できるよう長さと回数をはっきり変える */
const VIBE = {
  run:    [700],                          // 長く1回
  walk:   [180, 120, 180],                // 短く2回
  finish: [700, 300, 700, 300, 700],      // 長く3回
  tick:   [70],                           // カウントダウン（毎秒ちょん）
  ready:  [60],                           // スタート受付
  ack:    [40],                           // 一時停止・再開などの操作確認
};

/* ビープ音：[周波数Hz, 長さms, 次までの間ms] を振動と同じリズムで */
const BEEP = {
  run:    [[880, 450]],
  walk:   [[620, 150, 110], [620, 150]],
  finish: [[880, 450, 260], [880, 450, 260], [1046, 700]],
  tick:   [[1320, 70]],
  ready:  [[1320, 70]],
  ack:    [],
};

const LABEL = {
  ready:  { emoji: '',   text: '準備' },
  warmup: { emoji: '🚶', text: 'ウォームアップ' },
  run:    { emoji: '🏃', text: '走る' },
  walk:   { emoji: '🚶', text: '歩く' },
};

const THEME_COLOR = {
  ready: '#000000', warmup: '#1fb57a', run: '#ff6b00', walk: '#1546e0',
};

/* ---------- 小道具 ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const canVibrate = typeof navigator.vibrate === 'function';
const canWakeLock = 'wakeLock' in navigator;
const canSpeak = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function mmss(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function jpDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m && s) return `${m}分${s}秒`;
  if (m) return `${m}分`;
  return `${s}秒`;
}

/* ---------- 設定の保存と読み込み ---------- */

function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { saved = {}; }
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in saved)) continue;
    if (typeof DEFAULTS[k] === 'boolean') s[k] = !!saved[k];
    else if (Number.isFinite(Number(saved[k]))) s[k] = clamp(Math.round(Number(saved[k])), LIMITS[k].min, LIMITS[k].max);
  }
  return s;
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) { /* 保存できなくても動作は続ける */ }
}

let settings = loadSettings();

/* ---------- 音（Web Audio） ---------- */

let audio = null;

function ensureAudio() {
  if (!audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) { try { audio = new AC(); } catch (_) { audio = null; } }
  }
  if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
}

function playBeep(seq) {
  if (!audio || !seq || !seq.length) return;
  let t = audio.currentTime + 0.02;
  for (const [freq, dur, gap = 0] of seq) {
    const d = dur / 1000;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22, t + 0.012);
    gain.gain.setValueAtTime(0.22, t + Math.max(0.013, d - 0.03));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + d + 0.02);
    t += (dur + gap) / 1000;
  }
}

/* ---------- 音声読み上げ ---------- */

let jaVoice = null;
function pickVoice() {
  if (!canSpeak) return;
  const voices = speechSynthesis.getVoices();
  jaVoice = voices.find(v => /^ja(-|_|$)/i.test(v.lang)) || null;
}
if (canSpeak) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

function speak(text) {
  if (!canSpeak || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    if (jaVoice) u.voice = jaVoice;
    u.rate = 1.05;
    u.volume = 1;
    speechSynthesis.speak(u);
  } catch (_) { /* 読み上げに失敗しても続ける */ }
}

/* ---------- 振動 ---------- */

function vibrate(pattern) {
  if (!canVibrate) return false;
  try { return navigator.vibrate(pattern); } catch (_) { return false; }
}

/* 切り替えなどの合図：振動・ビープ・音声を設定に応じて出す */
function cue(kind, words) {
  if (settings.vibe) vibrate(VIBE[kind]);
  if (settings.beep) playBeep(BEEP[kind]);
  if (settings.voice && words) speak(words);
}

/* ---------- 画面スリープ防止（Wake Lock） ---------- */

let wakeLock = null;
let wakeWarned = false;

async function requestWakeLock() {
  if (!canWakeLock) { warnWakeLock(); return; }
  if (wakeLock || document.visibilityState !== 'visible') return;
  try {
    const lock = await navigator.wakeLock.request('screen');
    wakeLock = lock;
    lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    if (!session.active) releaseWakeLock(); // 取得中に終了した場合
  } catch (_) {
    warnWakeLock();
  }
}

function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

function warnWakeLock() {
  if (wakeWarned) return;
  wakeWarned = true;
  toast('画面のスリープ防止が使えませんでした。端末の「画面消灯」までの時間を長めにしてください。', 7000);
}

/* ---------- 予定（区間の並び）を作る ---------- */

function buildPlan(s) {
  const segs = [];
  let t = 0;
  const push = (kind, sec, rep) => {
    const dur = sec * 1000;
    segs.push({ kind, dur, start: t, end: t + dur, rep });
    t += dur;
  };
  push('ready', READY_SEC, 0);
  if (s.warmup > 0) push('warmup', s.warmup, 0);
  for (let r = 1; r <= s.reps; r++) {
    push('run', s.run, r);
    push('walk', s.walk, r);
  }
  return { segs, total: t, reps: s.reps, workout: t - READY_SEC * 1000 };
}

function workoutSeconds(s) {
  return s.warmup + (s.run + s.walk) * s.reps;
}

/* ================================================================
   設定画面
   ================================================================ */

const fieldKeys = ['run', 'walk', 'reps', 'warmup'];

function renderWarnings() {
  const box = $('#warnings');
  box.innerHTML = '';
  const add = (title, body) => {
    const el = document.createElement('div');
    el.className = 'warning';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<strong>${title}</strong>${body}`;
    box.appendChild(el);
  };
  if (!canVibrate) {
    add('このブラウザでは振動が使えません',
        'Android の Chrome で開いてください。ここでは、ビープ音と音声だけで知らせます。');
  }
  if (!canWakeLock) {
    add('画面のスリープ防止が使えません',
        window.isSecureContext
          ? 'Android の Chrome で開くか、端末の「画面消灯」までの時間を30分以上にしてから使ってください。'
          : 'https:// で始まるアドレスで開いてください。http では画面のスリープ防止が動きません。');
  }
}

function fillForm() {
  for (const k of fieldKeys) $(`#f-${k}`).value = settings[k];
  $('#t-vibe').checked = settings.vibe && canVibrate;
  $('#t-vibe').disabled = !canVibrate;
  if (!canVibrate) $('#vibe-desc').textContent = 'このブラウザでは使えません';
  $('#t-beep').checked = settings.beep;
  $('#t-voice').checked = settings.voice;
  $('#t-voice').disabled = !canSpeak;
  $('#t-guard').checked = settings.guard;
  $('#t-dim').checked = settings.dim;
  applyBodyFlags();
  renderSummary();
}

function applyBodyFlags() {
  document.body.classList.toggle('dim', settings.dim);
  document.body.classList.toggle('no-guard', !settings.guard);
}

function setField(k, raw, { commit = true } = {}) {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return;
  const v = clamp(n, LIMITS[k].min, LIMITS[k].max);
  settings[k] = v;
  if (commit) $(`#f-${k}`).value = v;
  saveSettings();
  renderSummary();
}

function renderSummary() {
  for (const k of ['run', 'walk', 'warmup']) {
    const hint = $(`[data-hint="${k}"]`);
    if (!hint) continue;
    hint.textContent = (k === 'warmup' && settings.warmup === 0) ? 'なし' : jpDuration(settings[k]);
  }
  const total = workoutSeconds(settings);
  renderStrip($('#plan-strip'), settings);
  $('#plan-caption').innerHTML =
    `合計<span class="num">${mmss(total)}</span>（${jpDuration(settings.run)}走る、${jpDuration(settings.walk)}歩くを${settings.reps}回）`;
  $('#start-sub').textContent = `合計 ${jpDuration(total)}`;
}

function renderStrip(el, s) {
  el.innerHTML = '';
  const total = workoutSeconds(s);
  if (!total) return;
  const frag = document.createDocumentFragment();
  const seg = (cls, sec) => {
    const span = document.createElement('span');
    span.className = cls;
    span.style.flex = `${sec} 0 0`;
    frag.appendChild(span);
  };
  if (s.warmup > 0) seg('s-warmup', s.warmup);
  for (let r = 0; r < s.reps; r++) { seg('s-run', s.run); seg('s-walk', s.walk); }
  el.appendChild(frag);
}

function renderPatternBars() {
  const seqs = {
    run: VIBE.run, walk: VIBE.walk, finish: VIBE.finish,
    countdown: [70, 930, 70, 930, 70],
  };
  const scale = 0.045; // 1ms あたりの幅(px)。最長の「終了」2.7秒 ≒ 120px
  for (const el of $$('[data-bars]')) {
    const seq = seqs[el.dataset.bars];
    el.innerHTML = seq.map((ms, i) => i % 2 === 0
      ? `<i style="width:${Math.max(4, ms * scale)}px"></i>`
      : `<b style="width:${Math.max(4, ms * scale)}px"></b>`).join('');
  }
}

/* 押し続けると連続で増減する ± ボタン */
function bindStepper(field) {
  const k = field.dataset.key;
  const input = $('input', field);

  for (const btn of $$('.step', field)) {
    const dir = Number(btn.dataset.dir);
    let delay = null, repeat = null;
    const once = () => {
      const cur = settings[k];
      const step = LIMITS[k].step;
      // 刻みに乗っていない値は、まず刻みにそろえる
      const next = dir > 0 ? Math.floor(cur / step) * step + step : Math.ceil(cur / step) * step - step;
      setField(k, next);
    };
    const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = null; };
    btn.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      stop();
      once();
      delay = setTimeout(() => { repeat = setInterval(once, 80); }, 420);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach(ev => btn.addEventListener(ev, stop));
    btn.addEventListener('click', e => { if (e.detail === 0) once(); }); // キーボード操作
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }

  input.addEventListener('input', () => {
    const n = Number(input.value);
    if (input.value !== '' && Number.isFinite(n) && n >= LIMITS[k].min && n <= LIMITS[k].max) {
      setField(k, n, { commit: false });
    }
  });
  input.addEventListener('change', () => setField(k, input.value === '' ? settings[k] : input.value));
  input.addEventListener('blur', () => { input.value = settings[k]; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
}

function bindToggles() {
  $('#t-vibe').addEventListener('change', e => {
    settings.vibe = e.target.checked; saveSettings();
    if (settings.vibe) vibrate(VIBE.ready);
  });
  $('#t-beep').addEventListener('change', e => {
    settings.beep = e.target.checked; saveSettings();
    if (settings.beep) { ensureAudio(); playBeep(BEEP.run); }
  });
  $('#t-voice').addEventListener('change', e => {
    settings.voice = e.target.checked; saveSettings();
    if (settings.voice) speak('音声をオンにしました');
  });
  $('#t-guard').addEventListener('change', e => {
    settings.guard = e.target.checked; saveSettings(); applyBodyFlags();
  });
  $('#t-dim').addEventListener('change', e => {
    settings.dim = e.target.checked; saveSettings(); applyBodyFlags();
  });
}

let testTimers = [];
function bindPatternTests() {
  const status = $('#test-status');
  for (const btn of $$('[data-test]')) {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.test;
      testTimers.forEach(clearTimeout);
      testTimers = [];
      $$('.pattern.playing').forEach(b => b.classList.remove('playing'));
      btn.classList.add('playing');
      if (settings.beep) ensureAudio();

      let ok;
      if (kind === 'countdown') {
        ok = vibrate(VIBE.tick);
        if (settings.beep) playBeep(BEEP.tick);
        for (const ms of [1000, 2000]) {
          testTimers.push(setTimeout(() => { vibrate(VIBE.tick); if (settings.beep) playBeep(BEEP.tick); }, ms));
        }
        testTimers.push(setTimeout(() => btn.classList.remove('playing'), 2400));
      } else {
        ok = vibrate(VIBE[kind]);
        if (settings.beep) playBeep(BEEP[kind]);
        const len = VIBE[kind].reduce((a, b) => a + b, 0);
        testTimers.push(setTimeout(() => btn.classList.remove('playing'), len + 200));
      }

      if (!canVibrate) {
        status.textContent = 'このブラウザでは振動できません。Android の Chrome で開いてください。';
      } else if (ok === false) {
        status.textContent = '振動がブロックされました。もう一度タップするか、ページを開き直してください。';
      } else {
        status.textContent = '振動を送りました。震えないときは、端末のバイブレーション設定とバッテリーセーバーを確認してください。';
      }
    });
  }
}

/* ================================================================
   実行
   ================================================================ */

const session = {
  active: false,
  plan: null,
  startAt: 0,
  pausedAt: null,
  pausedTotal: 0,
  idx: -1,
  lastTick: 0,
  timer: null,
  hiddenAt: null,
};

const ui = { kind: null, digits: '', rep: -1, left: '', p: -1, next: null };

function elapsedAt(now) {
  const ref = session.pausedAt != null ? session.pausedAt : now;
  return ref - session.startAt - session.pausedTotal;
}

function startWorkout() {
  ensureAudio();
  if (canSpeak && settings.voice) speechSynthesis.cancel();

  session.plan = buildPlan(settings);
  session.startAt = Date.now();
  session.pausedAt = null;
  session.pausedTotal = 0;
  session.idx = -1;
  session.lastTick = 0;
  session.hiddenAt = null;
  session.active = true;

  Object.assign(ui, { kind: null, digits: '', rep: -1, left: '', p: -1, next: null });
  buildRepCells(session.plan.reps);
  $('#rep-total').textContent = session.plan.reps;
  setPausedUI(false);

  show('run');
  if (!history.state || history.state.screen !== 'workout') {
    history.pushState({ screen: 'workout' }, '');
  }
  requestWakeLock();

  clearInterval(session.timer);
  loop(); // 最初の合図はタップの直後に出す（音声の再生許可のため）
  session.timer = setInterval(loop, TICK_MS);
}

function loop() {
  if (!session.active) return;
  const plan = session.plan;
  const e = elapsedAt(Date.now());

  if (e >= plan.total) { finishWorkout(false); return; }

  let i = Math.max(0, session.idx);
  while (i < plan.segs.length - 1 && e >= plan.segs[i].end) i++;
  const seg = plan.segs[i];

  if (i !== session.idx) {
    session.idx = i;
    session.lastTick = 0;
    enterSegment(seg, i);
  }

  const remain = seg.end - e;
  const secLeft = Math.ceil(remain / 1000);

  // 切り替え3秒前から毎秒の予告（区間の頭の合図と重ならないものだけ）
  if (session.pausedAt == null && secLeft >= 1 && secLeft <= 3 &&
      secLeft !== session.lastTick && seg.dur - secLeft * 1000 >= 1000) {
    session.lastTick = secLeft;
    cue('tick');
  }

  render(seg, i, remain, e);
}

function enterSegment(seg, i) {
  const plan = session.plan;
  switch (seg.kind) {
    case 'ready':
      cue('ready', plan.segs[1] && plan.segs[1].kind === 'warmup' ? '5秒後にウォームアップ' : '5秒後にスタート');
      break;
    case 'warmup':
      cue('walk', 'ウォームアップ。歩いて');
      break;
    case 'run': {
      const last = seg.rep === plan.reps && plan.reps > 1;
      cue('run', last ? 'ラスト。走って' : `${seg.rep}本目。走って`);
      break;
    }
    case 'walk':
      cue('walk', '歩いて');
      break;
  }
}

function render(seg, i, remain, e) {
  const plan = session.plan;
  const run = $('#screen-run');

  if (seg.kind !== ui.kind) {
    ui.kind = seg.kind;
    run.dataset.phase = seg.kind;
    const label = LABEL[seg.kind];
    $('#phase-emoji').textContent = label.emoji;
    $('#phase-text').textContent = label.text;
    $('#phase-label').classList.toggle('long', label.text.length > 3);
    setThemeColor(settings.dim ? '#000000' : THEME_COLOR[seg.kind]);
  }

  // 大きな残り秒数（100秒以上は 分:秒）
  const sec = Math.max(0, Math.ceil(remain / 1000));
  const text = sec >= 100 ? mmss(sec) : String(sec);
  if (text !== ui.digits) {
    ui.digits = text;
    const d = $('#digits');
    d.dataset.len = String(text.length);
    d.innerHTML = Array.from(text).map(ch => ch === ':' ? '<span class="c">:</span>' : `<span class="d">${ch}</span>`).join('');
  }

  // 回数
  const rep = seg.rep;
  if (rep !== ui.rep) {
    ui.rep = rep;
    $('#rep-now').textContent = rep;
    updateRepCells(seg);
  }

  // 全体の残り（準備時間は含めない）
  const leftSec = Math.ceil((plan.total - Math.max(e, READY_SEC * 1000)) / 1000);
  const left = mmss(leftSec);
  if (left !== ui.left) { ui.left = left; $('#left-total').textContent = left; }

  // 区間の経過（背景のせり上がり）
  const p = session.pausedAt != null ? ui.p : clamp(1 - remain / seg.dur, 0, 1);
  if (Math.abs(p - ui.p) > 0.002) {
    ui.p = p;
    run.style.setProperty('--p', p.toFixed(4));
  }

  // つぎの区間
  if (session.pausedAt == null) {
    const nx = plan.segs[i + 1];
    const nextText = nx
      ? `つぎ ${LABEL[nx.kind].emoji} ${LABEL[nx.kind].text} ${jpDuration(nx.dur / 1000)}`
      : 'つぎ 完了';
    if (ui.next !== nextText) { ui.next = nextText; $('#next').innerHTML = nextText; }
  }
}

function buildRepCells(n) {
  const box = $('#rep-cells');
  box.classList.toggle('tight', n > 24);
  box.innerHTML = '<i></i>'.repeat(n);
}

function updateRepCells(seg) {
  const cells = $$('#rep-cells i');
  const doneCount = seg.kind === 'run' || seg.kind === 'walk' ? seg.rep - 1 : 0;
  cells.forEach((c, idx) => {
    c.classList.toggle('is-done', idx < doneCount);
    c.classList.toggle('is-now', idx === doneCount && (seg.kind === 'run' || seg.kind === 'walk'));
  });
}

function setThemeColor(color) {
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', color);
}

/* ---------- 一時停止・再開・終了 ---------- */

function pauseWorkout() {
  if (!session.active || session.pausedAt != null) return;
  session.pausedAt = Date.now();
  if (canSpeak) speechSynthesis.cancel();
  vibrate(0);
  vibrate(VIBE.ack);
  setPausedUI(true);
}

function resumeWorkout() {
  if (!session.active || session.pausedAt == null) return;
  session.pausedTotal += Date.now() - session.pausedAt;
  session.pausedAt = null;
  vibrate(VIBE.ack);
  ui.next = null;
  setPausedUI(false);
  requestWakeLock();
  loop();
}

function setPausedUI(paused) {
  $('#screen-run').classList.toggle('paused', paused);
  $('#btn-pause').hidden = paused;
  $('#btn-resume').hidden = !paused;
  if (paused) { ui.next = null; $('#next').textContent = '一時停止中'; }
}

function finishWorkout(early) {
  if (!session.active) return;
  const now = Date.now();
  const e = clamp(elapsedAt(now), 0, session.plan.total);
  session.active = false;
  clearInterval(session.timer);
  session.timer = null;

  if (early) {
    if (canSpeak) speechSynthesis.cancel();
    vibrate(0);
    vibrate(VIBE.ack);
  } else {
    cue('finish', '終了です。おつかれさまでした');
  }
  releaseWakeLock();
  renderDone(early, e);
  show('done');
}

function renderDone(early, e) {
  const plan = session.plan;
  const title = $('#done-title');
  title.textContent = early ? '途中で終了' : '完了';
  title.classList.toggle('early', early);
  $('#done-sub').textContent = early ? 'ここまでの記録です。' : 'おつかれさまでした。';

  const workoutMs = Math.max(0, e - READY_SEC * 1000);
  $('#done-total').textContent = mmss(Math.floor(workoutMs / 1000));

  // 区間ごとに、実際に過ごした時間を集計
  let runMs = 0, walkMs = 0, warmMs = 0, reps = 0;
  for (const s of plan.segs) {
    const spent = clamp(e - s.start, 0, s.dur);
    if (s.kind === 'run') { runMs += spent; if (spent >= s.dur) reps++; }
    if (s.kind === 'walk') walkMs += spent;
    if (s.kind === 'warmup') warmMs += spent;
  }

  const strip = $('#done-strip');
  renderStrip(strip, settingsFromPlan(plan));
  const frac = plan.workout ? clamp(workoutMs / plan.workout, 0, 1) : 1;
  if (frac < 1) {
    const rest = document.createElement('span');
    rest.className = 'rest';
    rest.style.left = `${(frac * 100).toFixed(2)}%`;
    strip.appendChild(rest);
  }

  const rows = [];
  if (warmMs > 0) rows.push(['<span class="mark mark-warmup"></span>ウォームアップ', mmss(Math.floor(warmMs / 1000))]);
  rows.push(['<span class="mark mark-run"></span>走った', mmss(Math.floor(runMs / 1000))]);
  rows.push(['<span class="mark mark-walk"></span>歩いた', mmss(Math.floor(walkMs / 1000))]);
  rows.push(['<span class="mark mark-reps"></span>走り切った本数', `${reps}<span style="font-size:.7em"> / ${plan.reps}</span>`]);
  $('#done-stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd><span class="num">${v}</span></dd>`).join('');
}

function settingsFromPlan(plan) {
  const runSeg = plan.segs.find(s => s.kind === 'run');
  const walkSeg = plan.segs.find(s => s.kind === 'walk');
  const warmSeg = plan.segs.find(s => s.kind === 'warmup');
  return {
    run: runSeg ? runSeg.dur / 1000 : 0,
    walk: walkSeg ? walkSeg.dur / 1000 : 0,
    warmup: warmSeg ? warmSeg.dur / 1000 : 0,
    reps: plan.reps,
  };
}

/* 長押しで実行するボタン（誤タッチ防止がオフならタップで実行） */
let suppressClickUntil = 0;

function holdButton(btn, action, needsHold) {
  let timer = null;
  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    btn.classList.remove('holding');
  };
  btn.addEventListener('pointerdown', e => {
    if (!needsHold() || e.button !== 0) return;
    if (btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) btn.releasePointerCapture(e.pointerId);
    cancel();
    btn.style.setProperty('--hold', `${HOLD_MS}ms`);
    // 次のフレームで開始して、伸びるアニメーションを確実に動かす
    requestAnimationFrame(() => btn.classList.add('holding'));
    timer = setTimeout(() => {
      timer = null;
      btn.classList.remove('holding');
      suppressClickUntil = Date.now() + 500;
      action();
    }, HOLD_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', e => e.preventDefault());
  btn.addEventListener('click', e => {
    if (Date.now() < suppressClickUntil) return;
    if (!needsHold() || e.detail === 0) action(); // キーボードはそのまま実行
  });
}

/* ---------- 画面の切り替え ---------- */

let current = 'setup';
function show(name) {
  current = name;
  $('#screen-setup').hidden = name !== 'setup';
  $('#screen-run').hidden = name !== 'run';
  $('#screen-done').hidden = name !== 'done';
  if (name !== 'run') setThemeColor(getComputedStyle(document.body).backgroundColor || '#ffffff');
  if (name !== 'run') window.scrollTo(0, 0);
}

/* ---------- トースト ---------- */

let toastTimer = null;
function toast(message, ms = 4000) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ================================================================
   起動
   ================================================================ */

function init() {
  renderWarnings();
  renderPatternBars();
  $$('.field').forEach(bindStepper);
  bindToggles();
  bindPatternTests();
  fillForm();

  $('#btn-start').addEventListener('click', startWorkout);
  $('#btn-again').addEventListener('click', startWorkout);
  $('#btn-back').addEventListener('click', () => {
    if (history.state && history.state.screen === 'workout') history.back();
    else show('setup');
  });

  holdButton($('#btn-pause'), pauseWorkout, () => settings.guard);
  holdButton($('#btn-stop'), () => finishWorkout(true), () => settings.guard);
  $('#btn-resume').addEventListener('click', () => {
    if (Date.now() < suppressClickUntil) return;
    resumeWorkout();
  });

  // 画面が隠れた・戻ったとき
  document.addEventListener('visibilitychange', () => {
    if (!session.active) return;
    if (document.visibilityState === 'hidden') {
      session.hiddenAt = Date.now();
    } else {
      requestWakeLock();
      if (session.hiddenAt && Date.now() - session.hiddenAt > 1500 && session.pausedAt == null) {
        toast('画面が消えている間は、振動で知らせられませんでした。画面はつけたままにしてください。', 6000);
      }
      session.hiddenAt = null;
      loop();
    }
  });

  // 戻るジェスチャーの誤操作で抜けないようにする
  window.addEventListener('popstate', () => {
    if (session.active) {
      history.pushState({ screen: 'workout' }, '');
      toast(settings.guard ? '終了するときは「終了」を長押ししてください。' : '終了するときは「終了」を押してください。');
    } else if (current !== 'setup') {
      show('setup');
    }
  });

  window.addEventListener('beforeunload', e => {
    if (session.active) { e.preventDefault(); e.returnValue = ''; }
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
