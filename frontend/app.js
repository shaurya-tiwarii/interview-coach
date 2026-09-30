/* Interview Coach frontend - vanilla JS, no libraries.
   API contract: POST /api/sessions, POST /api/sessions/{sid}/answer (multipart),
   GET /api/sessions/{sid}/report, GET /api/sessions. Field names unchanged. */
const $ = id => document.getElementById(id);
const state = {
  role: 'software_engineer', difficulty: 'mixed',
  sessionId: null, turn: 1, totalTurns: 5,
  mediaRecorder: null, audioChunks: [], audioBlob: null,
  recStart: 0, timerInt: null,
};
const ROLE_NAMES = { software_engineer: 'Software Engineer', data_analyst: 'Data Analyst', hr_general: 'HR / General' };
const DIM_LABELS = { content_relevance: 'Content', clarity_structure: 'Clarity', confidence: 'Confidence' };

/* ---------- navigation ---------- */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(id);
  // restart the entrance animation
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  el.classList.add('active');
  window.scrollTo({ top: 0 });
  document.querySelectorAll('.navbtn').forEach(b =>
    b.classList.toggle('on', b.dataset.screen === id.replace('screen-', '')));
}
document.querySelectorAll('.navbtn').forEach(b =>
  b.addEventListener('click', () => {
    if (b.dataset.screen === 'dashboard') loadDashboard();
    showScreen('screen-' + b.dataset.screen);
  }));
$('brandHome').addEventListener('click', () => showScreen('screen-setup'));

/* ---------- setup ---------- */
document.querySelectorAll('#roleCards .role-card').forEach(c =>
  c.addEventListener('click', () => {
    document.querySelectorAll('#roleCards .role-card').forEach(x => x.classList.remove('selected'));
    c.classList.add('selected');
    state.role = c.dataset.role;
  }));
document.querySelectorAll('#diffPills .pill').forEach(p =>
  p.addEventListener('click', () => {
    document.querySelectorAll('#diffPills .pill').forEach(x => x.classList.remove('selected'));
    p.classList.add('selected');
    state.difficulty = p.dataset.diff;
  }));

$('startBtn').addEventListener('click', async () => {
  $('setupHint').textContent = '';
  $('startBtn').disabled = true;
  try {
    const r = await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: state.role, difficulty: state.difficulty }),
    });
    if (!r.ok) throw new Error('server error ' + r.status);
    const d = await r.json();
    state.sessionId = d.session_id; state.turn = d.turn; state.totalTurns = d.total_turns;
    showQuestion(d.question);
    showScreen('screen-interview');
  } catch (e) {
    $('setupHint').textContent = 'Could not start session: ' + e.message + '. Is the backend running?';
  } finally { $('startBtn').disabled = false; }
});

function showQuestion(q) {
  $('qMeta').innerHTML = `Question ${state.turn} of ${state.totalTurns} &middot; <span id="qDim">${escapeHtml(q.dimension.replace(/_/g, ' '))}</span> &middot; ${escapeHtml(q.difficulty)}`;
  $('qText').textContent = q.text;
  $('progressFill').style.width = ((state.turn - 1) / state.totalTurns * 100) + '%';
  $('answerPane').classList.add('hidden');
  $('resultPane').classList.add('hidden');
  resetRecUI();
}

/* ---------- recording ---------- */
function fmtTime(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function resetRecUI() {
  $('recBtn').classList.remove('recording');
  $('recLabel').textContent = 'Tap to record your answer';
  $('recTimer').classList.add('hidden');
  clearInterval(state.timerInt);
  state.audioBlob = null;
}
$('recBtn').addEventListener('click', async () => {
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') { stopRecording(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    const mr = new MediaRecorder(stream);
    state.mediaRecorder = mr;
    mr.ondataavailable = e => { if (e.data.size) state.audioChunks.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      state.audioBlob = new Blob(state.audioChunks, { type: mr.mimeType || 'audio/webm' });
      $('recLabel').textContent = 'Recording ready. Review or re-record below.';
      $('answerPane').classList.remove('hidden');
      $('transcriptPreview').textContent = 'Your answer will be transcribed after you hit Submit.';
    };
    mr.start();
    state.recStart = Date.now();
    $('recBtn').classList.add('recording');
    $('recLabel').textContent = 'Recording... tap again to stop';
    $('recTimer').classList.remove('hidden');
    state.timerInt = setInterval(() => {
      $('recTimer').textContent = fmtTime((Date.now() - state.recStart) / 1000);
    }, 250);
  } catch (e) {
    toast('Microphone access denied: ' + e.message);
  }
});
function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') state.mediaRecorder.stop();
  clearInterval(state.timerInt);
  $('recBtn').classList.remove('recording');
}
$('rerecordBtn').addEventListener('click', () => { $('answerPane').classList.add('hidden'); resetRecUI(); });

/* ---------- submit ---------- */
$('submitBtn').addEventListener('click', async () => {
  if (!state.audioBlob) { toast('Record an answer first.'); return; }
  showLoader('Transcribing and scoring...');
  try {
    const fd = new FormData();
    fd.append('audio', state.audioBlob, 'answer.webm');
    const r = await fetch(`/api/sessions/${state.sessionId}/answer`, { method: 'POST', body: fd });
    if (!r.ok) { const t = await r.text(); throw new Error(t.slice(0, 200)); }
    const d = await r.json();
    state.turn = d.turn;
    renderResult(d);
  } catch (e) {
    toast('Submit failed: ' + e.message);
  } finally { hideLoader(); }
});

/* ---------- examiner's marks: ruled score bars ---------- */
function scoreRow(label, value) {
  const pct = value == null ? 0 : Math.max(0, Math.min(10, value)) / 10 * 100;
  const num = value == null
    ? '<span class="score-num">n/a</span>'
    : `<span class="score-num" data-v="${value}">${value.toFixed(1)}</span>`;
  return `<div class="score-row">
    <span class="score-label">${label}</span>
    <span class="score-track"><span class="score-fill" data-w="${pct}"></span></span>
    ${num}</div>`;
}
function animateScores(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.score-fill').forEach(f => { f.style.width = f.dataset.w + '%'; });
    root.querySelectorAll('.score-num[data-v]').forEach(el => countUp(el, parseFloat(el.dataset.v)));
  }));
}
function countUp(el, target, dur = 750) {
  const t0 = performance.now();
  (function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = (target * e).toFixed(1);
    if (p < 1) requestAnimationFrame(frame);
  })(t0);
}

function renderResult(d) {
  $('answerPane').classList.add('hidden');
  $('progressFill').style.width = (d.turn / state.totalTurns * 100) + '%';
  const badge = $('llmBadge');
  if (d.llm_status === 'ok') { badge.textContent = 'AI scored'; badge.className = 'badge ok'; }
  else {
    badge.textContent = d.llm_status === 'llm_not_configured' ? 'AI scoring off, no API key' : 'AI scoring unavailable';
    badge.className = 'badge warn';
  }
  const s = d.scores || {};
  $('dials').innerHTML =
    scoreRow('Content', s.content_relevance ?? null) +
    scoreRow('Clarity', s.clarity_structure ?? null) +
    scoreRow('Confidence', s.confidence ?? null);
  $('metricsRow').innerHTML =
    `<div class="stat"><b>${d.wpm}</b><span>Words per minute</span></div>
     <div class="stat"><b>${d.duration_sec.toFixed(1)}s</b><span>Duration</span></div>
     <div class="stat"><b>${d.filler.count}</b><span>Fillers, ${d.filler.rate_per_100w} per 100 words</span></div>`;
  $('feedbackText').textContent = d.feedback || 'No feedback available.';
  $('nextBtn').innerHTML = d.session_complete
    ? 'See my report <span class="arr" aria-hidden="true">&rarr;</span>'
    : 'Next question <span class="arr" aria-hidden="true">&rarr;</span>';
  $('nextBtn').onclick = () => {
    if (d.session_complete) loadReport(state.sessionId);
    else { state.turn = d.turn + 1; showQuestion(d.next_question); }
  };
  const pane = $('resultPane');
  pane.classList.remove('hidden');
  animateScores($('dials'));
  pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------- report ---------- */
async function loadReport(sid) {
  showLoader('Building your report...');
  try {
    const r = await fetch(`/api/sessions/${sid}/report`);
    if (!r.ok) throw new Error('server error ' + r.status);
    const d = await r.json();
    $('reportTitle').textContent = 'How you did';
    $('reportSub').textContent = `${ROLE_NAMES[d.role]} - ${d.difficulty} - ${d.turns.length} questions - ${new Date(d.created_at).toLocaleString()}`;
    const av = d.averages || {};
    $('avgBars').innerHTML = ['content_relevance', 'clarity_structure', 'confidence', 'overall'].map(k => {
      const v = av[k];
      const label = k === 'overall' ? 'Overall' : DIM_LABELS[k];
      return scoreRow(label, v);
    }).join('');
    animateScores($('avgBars'));
    sparkline($('reportSpark'), d.trends.overall_score || [], { ymin: 0, ymax: 10 });
    $('turnList').innerHTML = d.turns.map(t => {
      const sc = t.scores;
      const chips = sc
        ? `<span class="tscore">Content <b>${sc.content_relevance}</b></span><span class="tscore">Clarity <b>${sc.clarity_structure}</b></span><span class="tscore">Confidence <b>${sc.confidence}</b></span>`
        : `<span class="tscore">not AI-scored (${escapeHtml(t.llm_status)})</span>`;
      return `<div class="turn"><h4><span class="qn">Q${t.n}.</span>${escapeHtml(t.question)}</h4>
        <div class="tmeta">${escapeHtml(t.dimension.replace(/_/g, ' '))} - ${escapeHtml(t.difficulty)} - ${t.wpm} WPM - ${t.filler_count} fillers - ${t.duration_sec.toFixed(1)}s</div>
        <div class="tscores">${chips}</div>
        <p class="ttrans">&ldquo;${escapeHtml(t.transcript || '(no speech transcribed)')}&rdquo;</p>
        <p class="tfb">${escapeHtml(t.feedback || '')}</p></div>`;
    }).join('');
    showScreen('screen-report');
  } catch (e) { toast('Report failed: ' + e.message); }
  finally { hideLoader(); }
}
$('againBtn').addEventListener('click', () => showScreen('screen-setup'));
$('dashBtn2').addEventListener('click', () => loadDashboard().then(() => showScreen('screen-dashboard')));

/* ---------- dashboard ---------- */
async function loadDashboard() {
  showLoader('Loading dashboard...');
  try {
    const r = await fetch('/api/sessions');
    if (!r.ok) throw new Error('server error ' + r.status);
    const sessions = await r.json();
    if (!sessions.length) {
      $('historyList').innerHTML = '<div class="hrow" style="cursor:default"><div><div class="hrole">No sessions yet</div><div class="hmeta">Finish a mock interview to see trends here.</div></div></div>';
      $('trendSessionLabel').textContent = '';
      $('sparkScore').innerHTML = ''; $('sparkWpm').innerHTML = ''; $('sparkFiller').innerHTML = '';
      return;
    }
    $('historyList').innerHTML = sessions.map((s, i) =>
      `<button class="hrow${i === 0 ? ' sel' : ''}" data-sid="${s.session_id}">
        <div><div class="hrole">${ROLE_NAMES[s.role]}</div>
        <div class="hmeta">${s.difficulty} - ${s.turns_answered} answers - ${new Date(s.created_at).toLocaleString()}</div></div>
        <div class="hscore">${s.avg_overall == null ? '&ndash;' : s.avg_overall.toFixed(1)}<small>avg / 10</small></div></button>`).join('');
    document.querySelectorAll('#historyList .hrow[data-sid]').forEach(row =>
      row.addEventListener('click', () => {
        document.querySelectorAll('#historyList .hrow').forEach(x => x.classList.remove('sel'));
        row.classList.add('sel');
        drawTrends(row.dataset.sid);
      }));
    await drawTrends(sessions[0].session_id);
  } catch (e) { toast('Dashboard failed: ' + e.message); }
  finally { hideLoader(); }
}

async function drawTrends(sid) {
  const r = await fetch(`/api/sessions/${sid}/report`);
  const d = await r.json();
  $('trendSessionLabel').textContent = `- ${ROLE_NAMES[d.role]}, ${new Date(d.created_at).toLocaleDateString()}`;
  sparkline($('sparkScore'), d.trends.overall_score || [], { ymin: 0, ymax: 10 });
  sparkline($('sparkWpm'), d.trends.wpm || [], {});
  sparkline($('sparkFiller'), d.trends.filler_rate || [], { ymin: 0 });
}

/* ---------- hand-drawn-feel SVG sparkline (no chart lib) ---------- */
function sparkline(el, data, opts = {}) {
  const W = 640, H = 190, padL = 10, padR = 10, padT = 18, padB = 28;
  const NS = 'http://www.w3.org/2000/svg';
  el.innerHTML = '';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  const vals = data.map(v => (v == null || isNaN(v) ? null : Number(v)));
  const nums = vals.filter(v => v !== null);
  if (!nums.length) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'spark-empty');
    t.textContent = 'No scored answers yet';
    svg.appendChild(t); el.appendChild(svg); return;
  }
  let lo = Math.min(...nums), hi = Math.max(...nums);
  if (opts.ymin != null) lo = Math.min(lo, opts.ymin);
  if (opts.ymax != null) hi = Math.max(hi, opts.ymax);
  if (hi - lo < 1e-6) hi = lo + 1;
  const n = vals.length;
  const X = i => padL + (n === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (n - 1));
  const Y = v => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  for (let g = 0; g <= 2; g++) {
    const y = padT + g * (H - padT - padB) / 2;
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', padL); ln.setAttribute('x2', W - padR);
    ln.setAttribute('y1', y); ln.setAttribute('y2', y);
    ln.setAttribute('class', 'spark-grid');
    svg.appendChild(ln);
  }
  const segs = [];
  let cur = [];
  vals.forEach((v, i) => {
    if (v == null) { if (cur.length) segs.push(cur); cur = []; }
    else cur.push([X(i), Y(v), i]);
  });
  if (cur.length) segs.push(cur);
  segs.forEach(pts => {
    if (pts.length < 2) return;
    let dAttr = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1];
      const x1 = pts[i][0], y1 = pts[i][1], idx = pts[i][2];
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      const wob = (((idx + 1) * 37) % 5 - 2) * 1.7; // small deterministic wobble
      dAttr += ` Q ${(mx + wob).toFixed(1)} ${(my - wob).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
    }
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', dAttr);
    p.setAttribute('class', 'spark-line');
    svg.appendChild(p);
  });
  vals.forEach((v, i) => {
    if (v == null) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', X(i).toFixed(1)); c.setAttribute('cy', Y(v).toFixed(1));
    c.setAttribute('r', 4); c.setAttribute('class', 'spark-dot');
    svg.appendChild(c);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', X(i).toFixed(1)); t.setAttribute('y', (Y(v) - 10).toFixed(1));
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'spark-val');
    t.textContent = v.toFixed(1);
    svg.appendChild(t);
    const q = document.createElementNS(NS, 'text');
    q.setAttribute('x', X(i).toFixed(1)); q.setAttribute('y', H - 8);
    q.setAttribute('text-anchor', 'middle'); q.setAttribute('class', 'spark-qlab');
    q.textContent = 'Q' + (i + 1);
    svg.appendChild(q);
  });
  el.appendChild(svg);
}

/* ---------- helpers ---------- */
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function showLoader(t) { $('loaderText').textContent = t; $('loader').classList.remove('hidden'); }
function hideLoader() { $('loader').classList.add('hidden'); }
let toastT = null;
function toast(msg) {
  const el = $('toast'); el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 4200);
}
