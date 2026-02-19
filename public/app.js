const state = {
  roomId: null,
  sessionId: null,
  isHost: false,
  room: null,
  sse: null,
  serverOffsetMs: 0,
  offsetSamples: [],
  sequence: [],
  correctAnswer: 0,
  audioCtx: null,
  interrupted: false,
  submitted: false
};

const screens = {
  home: document.getElementById('homeScreen'),
  waiting: document.getElementById('waitingScreen'),
  present: document.getElementById('presentScreen'),
  result: document.getElementById('resultScreen')
};

function $(id) { return document.getElementById(id); }
function switchScreen(name) {
  Object.values(screens).forEach((s) => s.classList.remove('active'));
  screens[name].classList.add('active');
}

function randomSeed() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  const arr = crypto.getRandomValues(new Uint8Array(10));
  for (const x of arr) out += alphabet[x % alphabet.length];
  return out;
}
$('seed').value = randomSeed();

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function rng() {
    let t = a += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSequence(settings) {
  const rng = mulberry32(hashSeed(settings.seed + JSON.stringify(settings)));
  const min = settings.digits === 1 ? 1 : settings.digits === 2 ? 10 : 100;
  const max = settings.digits === 1 ? 9 : settings.digits === 2 ? 99 : 999;
  const terms = [];
  let total = 0;
  const retryLimit = settings.terms * 120;
  let retries = 0;

  for (let i = 0; i < settings.terms; i += 1) {
    let placed = false;
    while (!placed && retries < retryLimit) {
      retries += 1;
      const val = Math.floor(rng() * (max - min + 1)) + min;
      let sign = 1;
      if (settings.mode === 'sub') sign = -1;
      else if (settings.mode === 'mixed') sign = rng() < 0.5 ? 1 : -1;
      const term = sign * val;
      if (!settings.allowNegative && total + term < 0) continue;
      terms.push(term);
      total += term;
      placed = true;
    }
    if (!placed) {
      throw new Error('条件が厳しすぎるため口列を生成できません。allowNegativeをONにするか条件を緩めてください。');
    }
  }
  return { terms, answer: total };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

async function sampleServerOffset() {
  const t0 = performance.now();
  const { serverNow } = await fetchJson('/api/time');
  const t1 = performance.now();
  const midLocal = Date.now() + (t1 - t0) / 2;
  return serverNow - midLocal;
}

async function syncClock(samples = 5) {
  const arr = [];
  for (let i = 0; i < samples; i += 1) {
    arr.push(await sampleServerOffset());
    await new Promise((r) => setTimeout(r, 90));
  }
  state.offsetSamples = arr;
  state.serverOffsetMs = arr.reduce((a, b) => a + b, 0) / arr.length;
  $('syncStatus').textContent = `時刻同期オフセット: ${state.serverOffsetMs.toFixed(1)}ms（${arr.length}サンプル平均）`;
}

function connectEvents() {
  if (state.sse) state.sse.close();
  state.sse = new EventSource(`/api/rooms/${state.roomId}/events?sessionId=${state.sessionId}`);
  state.sse.addEventListener('state', (evt) => {
    state.room = JSON.parse(evt.data);
    renderRoom();
  });
  state.sse.addEventListener('start_scheduled', async (evt) => {
    const { startAt } = JSON.parse(evt.data);
    await syncClock(5);
    scheduleStart(startAt);
  });
}

function renderRoom() {
  const room = state.room;
  if (!room) return;
  const settings = room.settings;
  $('roomMeta').textContent = `roomId: ${room.roomId} / seed: ${settings.seed} / tempo:${settings.tempo}s / terms:${settings.terms} / digits:${settings.digits} / mode:${settings.mode}`;
  $('participants').innerHTML = room.participants
    .map((p) => `<li>${p.nickname}${p.isHost ? ' (host)' : ''}${p.lastResult ? ` - ${p.lastResult.correct ? '✅' : '❌'} ${p.lastResult.answer}` : ''}</li>`)
    .join('');
  $('hostControls').classList.toggle('hidden', !state.isHost);
  renderScoreboard();
}

function serverNowApprox() {
  return Date.now() + state.serverOffsetMs;
}

function scheduleStart(startAt) {
  switchScreen('waiting');
  const tick = () => {
    const remain = startAt - serverNowApprox();
    if (remain <= 0) {
      $('startCountdown').textContent = '開始します...';
      startPresentation();
      return;
    }
    $('startCountdown').textContent = `${Math.ceil(remain / 1000)}秒後に自動開始`;
    requestAnimationFrame(tick);
  };
  tick();
}

function ensureAudioContext() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
}

function beep() {
  if (!state.audioCtx || state.room?.settings?.beep !== true) return;
  const osc = state.audioCtx.createOscillator();
  const gain = state.audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 880;
  gain.gain.value = 0.05;
  osc.connect(gain).connect(state.audioCtx.destination);
  osc.start();
  osc.stop(state.audioCtx.currentTime + 0.08);
}

function startPresentation() {
  if (!state.room) return;
  const settings = state.room.settings;
  let gen;
  try {
    gen = generateSequence(settings);
  } catch (err) {
    alert(err.message);
    return;
  }
  state.sequence = gen.terms;
  state.correctAnswer = gen.answer;
  state.interrupted = false;
  state.submitted = false;
  switchScreen('present');

  const base = performance.now();
  let i = 0;
  const tempoMs = settings.tempo * 1000;

  const step = () => {
    if (document.visibilityState !== 'visible') {
      state.interrupted = true;
      finishPresentation();
      return;
    }
    if (i >= state.sequence.length) {
      finishPresentation();
      return;
    }
    const term = state.sequence[i];
    $('termDisplay').textContent = `${term >= 0 ? '+' : ''}${term}`;
    $('progress').textContent = `${i + 1}/${state.sequence.length}`;
    $('presentInfo').textContent = `テンポ ${settings.tempo}秒/口`;
    beep();
    i += 1;
    const target = base + i * tempoMs;
    const delay = Math.max(0, target - performance.now());
    setTimeout(step, delay);
  };
  step();
}

function finishPresentation() {
  switchScreen('result');
  if (state.interrupted) {
    $('resultSummary').textContent = 'タブが非アクティブになったため中断扱いです。';
  } else {
    $('resultSummary').textContent = '提示終了。回答を入力してください。';
  }
}

async function submitAnswer() {
  if (state.submitted || !state.roomId || !state.sessionId) return;
  const val = $('answerInput').value.trim();
  if (!/^-?\d+$/.test(val)) {
    alert('数値のみ入力してください');
    return;
  }
  const correct = Number(val) === state.correctAnswer && !state.interrupted;
  await fetchJson(`/api/rooms/${state.roomId}/result`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: state.sessionId, answer: val, correct })
  });
  state.submitted = true;
  $('resultSummary').textContent = `正答: ${state.correctAnswer} / あなた: ${val} / ${correct ? '正解' : '不正解'}`;
}

function renderScoreboard() {
  if (!state.room) return;
  const rows = state.room.results
    .slice()
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .map((r) => `<tr><td>${r.nickname}</td><td>${r.correct ? '✅' : '❌'}</td><td>${r.answer}</td><td>${new Date(r.submittedAt).toLocaleTimeString()}</td></tr>`)
    .join('');
  $('scoreBoard').innerHTML = `<table><thead><tr><th>名前</th><th>判定</th><th>回答</th><th>送信時刻</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function joinRoom(roomId, nickname, createPayload = null) {
  let roomState;
  if (createPayload) {
    const data = await fetchJson('/api/rooms', { method: 'POST', body: JSON.stringify(createPayload) });
    roomId = data.roomId;
    state.sessionId = data.sessionId;
    roomState = data.state;
    state.isHost = true;
  } else {
    const data = await fetchJson(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify({ nickname })
    });
    state.sessionId = data.sessionId;
    roomState = data.state;
    state.isHost = false;
  }

  state.roomId = roomId;
  state.room = roomState;
  history.replaceState({}, '', `/room/${roomId}`);
  localStorage.setItem(`session:${roomId}`, state.sessionId);
  switchScreen('waiting');
  renderRoom();
  await syncClock(5);
  connectEvents();
  if (roomState.settings.startAt) scheduleStart(roomState.settings.startAt);
}

$('generateSeedBtn').onclick = () => { $('seed').value = randomSeed(); };
$('createRoomBtn').onclick = async () => {
  try {
    const settings = {
      tempo: Number($('tempo').value),
      terms: Number($('terms').value),
      digits: Number($('digits').value),
      mode: $('mode').value,
      allowNegative: $('allowNegative').checked,
      countdown: Number($('countdown').value),
      beep: $('beep').checked,
      seed: $('seed').value.trim()
    };
    await joinRoom(null, $('hostName').value.trim(), { nickname: $('hostName').value.trim(), settings });
  } catch (e) {
    alert(e.message);
  }
};

$('joinRoomBtn').onclick = async () => {
  try {
    await joinRoom($('joinRoomId').value.trim().toUpperCase(), $('guestName').value.trim());
  } catch (e) {
    alert(e.message);
  }
};

$('copyLinkBtn').onclick = async () => {
  const link = `${location.origin}/room/${state.roomId}`;
  await navigator.clipboard.writeText(link);
  alert('リンクをコピーしました');
};
$('shareLinkBtn').onclick = async () => {
  const link = `${location.origin}/room/${state.roomId}`;
  if (navigator.share) {
    await navigator.share({ title: 'テンポ見取算ルーム', url: link, text: `roomId: ${state.roomId}` });
  } else {
    await navigator.clipboard.writeText(link);
    alert('Web Share非対応のためコピーしました');
  }
};

$('initAudioBtn').onclick = () => ensureAudioContext();

$('startBtn').onclick = async () => {
  try {
    ensureAudioContext();
    await syncClock(7);
    const startAt = Math.round(serverNowApprox() + state.room.settings.countdown * 1000);
    await fetchJson(`/api/rooms/${state.roomId}/start`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.sessionId, startAt })
    });
  } catch (e) {
    alert(e.message);
  }
};

$('rematchBtn').onclick = async () => {
  await fetchJson(`/api/rooms/${state.roomId}/rematch`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: state.sessionId })
  });
  $('answerInput').value = '';
  switchScreen('waiting');
};

$('closeRoomBtn').onclick = async () => {
  await fetchJson(`/api/rooms/${state.roomId}/close`, {
    method: 'POST',
    body: JSON.stringify({ sessionId: state.sessionId })
  });
  alert('ルームを終了しました');
  location.href = '/';
};

$('submitAnswerBtn').onclick = () => submitAnswer();
$('backWaitingBtn').onclick = () => switchScreen('waiting');

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' && screens.present.classList.contains('active')) {
    state.interrupted = true;
  }
});

async function tryAutoJoinFromPath() {
  const match = location.pathname.match(/^\/room\/([A-Z0-9]+)$/);
  if (!match) return;
  const roomId = match[1];
  $('joinRoomId').value = roomId;
  const existing = localStorage.getItem(`session:${roomId}`);
  const roomState = await fetchJson(`/api/rooms/${roomId}`);
  if (existing && roomState.participants.some((p) => p.sessionId === existing)) {
    state.sessionId = existing;
    state.roomId = roomId;
    state.room = roomState;
    state.isHost = roomState.hostSessionId === existing;
    switchScreen('waiting');
    renderRoom();
    await syncClock(5);
    connectEvents();
    if (roomState.settings.startAt) scheduleStart(roomState.settings.startAt);
    return;
  }
  switchScreen('home');
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

tryAutoJoinFromPath().catch(() => {
  switchScreen('home');
});
