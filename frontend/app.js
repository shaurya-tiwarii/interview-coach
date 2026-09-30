/* Interview Coach v2 - vanilla JS SPA, no libraries.
   Routes: #/ (landing) #/login #/register #/dashboard #/interview
           #/report/<id> #/settings
   API: /api/auth/*, /api/stats, /api/sessions, /api/sessions/{sid}/answer,
        /api/sessions/{sid}/report. Auth via HttpOnly cookie. */
'use strict';
const $ = id => document.getElementById(id);

const state = {
  user: null, authChecked: false, afterLogin: null,
  role: 'software_engineer', difficulty: 'mixed',
  sessionId: null, turn: 1, totalTurns: 5,
  mediaRecorder: null, audioChunks: [], audioBlob: null,
  recStart: 0, timerInt: null,
};

const ROLE_NAMES = { software_engineer: 'Software Engineer', data_analyst: 'Data Analyst', hr_general: 'HR / General' };
const ROLE_BLURBS = {
  software_engineer: 'Data structures, systems and problem solving.',
  data_analyst: 'SQL, statistics and telling stories with data.',
  hr_general: 'Behavioral questions and communication.',
};
const DIM_LABELS = { content_relevance: 'Content', clarity_structure: 'Clarity', confidence: 'Confidence' };

/* ============ helpers ============ */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(s) { return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }
function fmtDate(iso) { try { return new Date(iso).toLocaleString(); } catch (e) { return ''; } }
function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}
function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
let toastT = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 4200);
}
function showLoader(t) { $('loaderText').textContent = t || 'Working...'; $('loader').classList.remove('hidden'); }
function hideLoader() { $('loader').classList.add('hidden'); }

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(path, opts) {
  opts = opts || {};
  const r = await fetch(path, Object.assign({ credentials: 'include' }, opts));
  let data = null;
  try { data = await r.json(); } catch (e) { /* non-JSON */ }
  if (!r.ok) {
    const msg = (data && data.detail) || ('Request failed (' + r.status + ')');
    throw new ApiError(r.status, msg);
  }
  return data;
}

/* ============ chrome: nav + footer ============ */
function renderNav() {
  const nav = $('nav');
  const u = state.user;
  const links = u
    ? '<a href="#/dashboard">Dashboard</a><a href="#/settings">Settings</a>'
    : '<a href="#how">How it works</a><a href="#features">Features</a>';
  const cta = u
    ? '<div class="menu" id="userMenu"><button class="avatar" id="avatarBtn" aria-label="Account menu">' + escapeHtml(initials(u.name)) + '</button>' +
      '<div class="menu-pop"><div class="menu-user"><b>' + escapeHtml(u.name) + '</b><span>' + escapeHtml(u.email) + '</span></div>' +
      '<button data-go="#/dashboard">Dashboard</button>' +
      '<button data-go="#/settings">Settings</button>' +
      '<button data-go="#/logout" class="danger">Log out</button></div></div>'
    : '<a class="btn btn-ghost btn-sm" href="#/login">Sign in</a>' +
      '<a class="btn btn-primary btn-sm" href="#/register">Get started</a>';
  nav.innerHTML =
    '<a class="brand" href="#/"><span class="monogram">ST</span>' +
    '<span class="brand-name">Interview Coach<small>by ST</small></span></a>' +
    '<nav class="nav-links">' + links + '</nav>' +
    '<div class="nav-cta">' + cta + '</div>';

  const menu = $('userMenu');
  if (menu) {
    $('avatarBtn').addEventListener('click', e => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => {
      menu.classList.remove('open');
      const to = b.dataset.go;
      if (to === '#/logout') logout();
      else location.hash = to;
    }));
  }
}

function renderFooter() {
  $('footer').innerHTML =
    '<div class="footer-inner"><div class="footer-brand"><span class="monogram">ST</span>' +
    '<span class="sig">Interview Coach<small>Designed and built by Shaurya Tiwari</small></span></div>' +
    '<div class="footer-links">' +
    (state.user
      ? '<a href="#/dashboard">Dashboard</a><a href="#/settings">Settings</a>'
      : '<a href="#/login">Sign in</a><a href="#/register">Get started</a>') +
    '</div>' +
    '<div class="footer-note">Practice out loud. Get scored like it is the real thing.</div></div>';
}

/* ============ router ============ */
function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean);
  return { name: parts[0] || '', param: parts[1] || null };
}

async function ensureAuth() {
  if (!state.authChecked) {
    try { state.user = await api('/api/auth/me'); }
    catch (e) { state.user = null; }
    state.authChecked = true;
    renderNav(); renderFooter();
  }
}

async function route() {
  await ensureAuth();
  const h = location.hash || '#/';
  renderNav(); renderFooter();
  const view = $('view');

  // In-page anchor (e.g. #how, #features): render landing underneath and
  // let the browser do its native anchor scroll. Not a route change.
  if (!h.startsWith('#/')) {
    if (!view.dataset.landing) { viewLanding(view); }
    return;
  }
  delete view.dataset.landing;
  window.scrollTo(0, 0);

  const { name, param } = parseHash();
  const authed = !!state.user;

  if ((name === 'dashboard' || name === 'interview' || name === 'settings' || name === 'report') && !authed) {
    state.afterLogin = location.hash;
    location.hash = '#/login';
    return;
  }
  if ((name === 'login' || name === 'register') && authed) {
    location.hash = '#/dashboard';
    return;
  }

  renderNav(); renderFooter();
  if (name === '') viewLanding(view);
  else if (name === 'login') viewLogin(view);
  else if (name === 'register') viewRegister(view);
  else if (name === 'dashboard') viewDashboard(view);
  else if (name === 'interview') viewInterview(view);
  else if (name === 'report' && param) viewReport(view, param);
  else if (name === 'settings') viewSettings(view);
  else view404(view);
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
  state.user = null;
  location.hash = '#/';
}

/* ============ landing ============ */
function viewLanding(view) {
  view.dataset.landing = '1';
  const cta = state.user ? '#/dashboard' : '#/register';
  const ctaLabel = state.user ? 'Open my dashboard' : 'Start practicing free';
  view.innerHTML =
  '<section class="hero wrap">' +
    '<p class="kicker rise">AI mock interview practice</p>' +
    '<h1 class="h-display rise rise-1">Walk in ready<span class="dot">.</span> Leave no answer to chance.</h1>' +
    '<p class="lede rise rise-2">Pick a role, answer real interview questions out loud, and get every answer transcribed, timed and scored like the real thing.</p>' +
    '<div class="hero-ctas rise rise-3">' +
      '<a class="btn btn-primary" href="' + cta + '">' + ctaLabel + ' <span class="arr">&rarr;</span></a>' +
      '<a class="btn btn-ghost" href="#how">See how it works</a>' +
    '</div>' +
    '<div class="hero-meta rise rise-3">' +
      '<span><b>3</b> roles</span><span><b>5</b> questions per round</span>' +
      '<span><b>Whisper</b> transcription</span><span><b>AI</b> rubric scoring</span>' +
    '</div>' +
    '<div class="hero-panel rise rise-4" aria-hidden="true">' +
      '<div class="hero-panel-bar"><i></i><i></i><i></i></div>' +
      '<div class="hero-panel-body">' +
        '<p class="mock-q"><small>Question 3 of 5 &middot; Software Engineer</small>Explain the difference between a process and a thread.</p>' +
        '<div class="mock-wave">' + Array.from({ length: 48 }, (_, i) =>
          '<i style="animation-delay:' + (i * 47 % 1300) + 'ms"></i>').join('') + '</div>' +
        '<div class="mock-scores">' +
          '<div class="mock-score"><b>8.4</b><span>Content</span><div class="mock-bar"><i style="width:84%"></i></div></div>' +
          '<div class="mock-score"><b>7.9</b><span>Clarity</span><div class="mock-bar"><i style="width:79%;animation-delay:.15s"></i></div></div>' +
          '<div class="mock-score"><b>8.1</b><span>Confidence</span><div class="mock-bar"><i style="width:81%;animation-delay:.3s"></i></div></div>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</section>' +

  '<section class="section wrap" id="features">' +
    '<p class="kicker">Features</p>' +
    '<h2 class="h-2xl" style="max-width:20ch">Everything a practice round should give you.</h2>' +
    '<div class="feat-grid">' +
      feat('01', 'Speak your answers', 'Hit record and talk it out. No typing, no multiple choice, just you thinking out loud under pressure.') +
      feat('02', 'Transcribed by Whisper', 'Every answer is transcribed word for word, so you can read exactly what the interviewer would hear.') +
      feat('03', 'Scored like an examiner', 'An AI rubric grades content, clarity and confidence out of 10, with written feedback on each answer.') +
      feat('04', 'Speech analytics', 'Words per minute, filler-word rate and answer duration, tracked across every question you attempt.') +
      feat('05', 'Questions that adapt', 'Retrieval picks follow-up questions based on what you just said, instead of a fixed script.') +
      feat('06', 'Your private history', 'Every round is saved to your account. Watch your scores climb across weeks of practice.') +
    '</div>' +
  '</section>' +

  '<section class="section wrap" id="how">' +
    '<p class="kicker">How it works</p>' +
    '<h2 class="h-2xl" style="max-width:20ch">Three steps to a better interview.</h2>' +
    '<div class="steps">' +
      '<div class="card card-hover step rise"><h3>Create your account</h3><p>Thirty seconds. Your rounds, scores and progress live in your private dashboard.</p></div>' +
      '<div class="card card-hover step rise rise-1"><h3>Pick a role and difficulty</h3><p>Software Engineer, Data Analyst or HR. Easy, mixed or hard question sets.</p></div>' +
      '<div class="card card-hover step rise rise-2"><h3>Answer out loud, get scored</h3><p>Five questions, voice answers, instant transcription, rubric scores and feedback.</p></div>' +
    '</div>' +
    '<div class="cta-band rise">' +
      '<h2>Your next interview is coming.<br>Be ready for it.</h2>' +
      '<p>Free to start. Five minutes to your first scored round.</p>' +
      '<a class="btn btn-primary" href="' + cta + '">' + ctaLabel + ' <span class="arr">&rarr;</span></a>' +
    '</div>' +
  '</section>';
}

function feat(n, title, body) {
  return '<div class="card card-hover feat rise"><div class="feat-ic">' + n + '</div>' +
    '<h3>' + title + '</h3><p>' + body + '</p></div>';
}

function view404(view) {
  view.innerHTML = '<div class="wrap nf"><h1>Lost?</h1>' +
    '<p>This page does not exist.</p>' +
    '<a class="btn btn-primary" href="#/">Back home</a></div>';
}

/* ============ auth views ============ */
function authShell(title, sub, inner) {
  return '<div class="wrap auth-wrap"><div class="auth-card rise">' +
    '<div class="monogram">ST</div><h1>' + title + '</h1><p>' + sub + '</p>' +
    '<div class="form-error" id="formError"></div>' + inner + '</div></div>';
}
function pwField(id, label, autocomplete) {
  return '<div class="field"><label for="' + id + '">' + label + '</label>' +
    '<div class="pw-wrap"><input class="input" type="password" id="' + id + '" autocomplete="' + (autocomplete || 'current-password') + '">' +
    '<button type="button" class="pw-toggle" data-pw="' + id + '">SHOW</button></div></div>';
}
function bindPwToggles(root) {
  root.querySelectorAll('[data-pw]').forEach(b => b.addEventListener('click', () => {
    const inp = $(b.dataset.pw);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    b.textContent = show ? 'HIDE' : 'SHOW';
  }));
}
function formFail(msg) {
  const el = $('formError');
  el.textContent = msg; el.classList.add('show');
}

function viewLogin(view) {
  view.innerHTML = authShell('Welcome back', 'Sign in to pick up where you left off.',
    '<div class="field"><label for="li-email">Email</label>' +
    '<input class="input" id="li-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
    pwField('li-pass', 'Password') +
    '<button class="btn btn-primary btn-block" id="li-go">Sign in</button>' +
    '<p class="form-note">New here? <a href="#/register">Create an account</a></p>');
  bindPwToggles(view);
  const go = async () => {
    const email = $('li-email').value.trim(), password = $('li-pass').value;
    if (!email || !password) { formFail('Enter your email and password.'); return; }
    $('formError').classList.remove('show');
    showLoader('Signing you in...');
    try {
      state.user = await api('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      state.authChecked = true;
      const next = state.afterLogin; state.afterLogin = null;
      location.hash = next || '#/dashboard';
    } catch (e) { formFail(e.message); }
    finally { hideLoader(); }
  };
  $('li-go').addEventListener('click', go);
  view.querySelector('.auth-card').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

function viewRegister(view) {
  view.innerHTML = authShell('Create your account', 'Free. Thirty seconds. Your first scored round is five minutes away.',
    '<div class="field"><label for="rg-name">Name</label>' +
    '<input class="input" id="rg-name" type="text" autocomplete="name" placeholder="Your name"></div>' +
    '<div class="field"><label for="rg-email">Email</label>' +
    '<input class="input" id="rg-email" type="email" autocomplete="email" placeholder="you@example.com"></div>' +
    pwField('rg-pass', 'Password', 'new-password') +
    '<button class="btn btn-primary btn-block" id="rg-go">Create account</button>' +
    '<p class="form-note">Already have one? <a href="#/login">Sign in</a></p>');
  bindPwToggles(view);
  const go = async () => {
    const name = $('rg-name').value.trim(), email = $('rg-email').value.trim(), password = $('rg-pass').value;
    if (!name) { formFail('Tell us your name.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { formFail('That email does not look right.'); return; }
    if (password.length < 8) { formFail('Password needs at least 8 characters.'); return; }
    $('formError').classList.remove('show');
    showLoader('Creating your account...');
    try {
      state.user = await api('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      state.authChecked = true;
      location.hash = '#/dashboard';
    } catch (e) { formFail(e.message); }
    finally { hideLoader(); }
  };
  $('rg-go').addEventListener('click', go);
  view.querySelector('.auth-card').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}

/* ============ dashboard ============ */
async function viewDashboard(view) {
  view.innerHTML =
  '<div class="wrap"><div class="dash-head rise">' +
    '<p class="kicker">Dashboard</p>' +
    '<h1>' + greeting() + ', <span class="accent">' + escapeHtml(state.user.name.split(' ')[0]) + '</span></h1>' +
    '<p class="muted">Your practice at a glance. Start a new round whenever you are ready.</p>' +
  '</div>' +
  '<div class="stat-grid" id="statGrid"></div>' +
  '<div class="card launcher rise rise-1"><p class="kicker">New mock interview</p>' +
    '<h2 class="h-xl">Pick your battlefield</h2>' +
    '<div class="role-grid" id="roleCards">' +
      Object.keys(ROLE_NAMES).map(r =>
        '<button class="role-card' + (state.role === r ? ' selected' : '') + '" data-role="' + r + '">' +
        '<span class="tag">' + r.split('_')[0].toUpperCase() + '</span><h3>' + ROLE_NAMES[r] + '</h3><p>' + ROLE_BLURBS[r] + '</p></button>'
      ).join('') +
    '</div>' +
    '<div class="diff-row" id="diffPills">' +
      ['easy', 'mixed', 'hard'].map(d =>
        '<button class="pill' + (state.difficulty === d ? ' selected' : '') + '" data-diff="' + d + '">' +
        d[0].toUpperCase() + d.slice(1) + '</button>').join('') +
    '</div>' +
    '<button class="btn btn-primary" id="startBtn">Start interview <span class="arr">&rarr;</span></button>' +
    '<p class="muted" id="setupHint" style="margin-top:0.9rem;font-size:var(--t-sm)"></p>' +
  '</div>' +
  '<div class="rise rise-2"><p class="kicker">History</p><h2 class="h-xl">Past rounds</h2>' +
  '<div class="hist-list" id="historyList"></div></div></div>';

  view.querySelectorAll('#roleCards .role-card').forEach(c => c.addEventListener('click', () => {
    view.querySelectorAll('#roleCards .role-card').forEach(x => x.classList.remove('selected'));
    c.classList.add('selected'); state.role = c.dataset.role;
  }));
  view.querySelectorAll('#diffPills .pill').forEach(p => p.addEventListener('click', () => {
    view.querySelectorAll('#diffPills .pill').forEach(x => x.classList.remove('selected'));
    p.classList.add('selected'); state.difficulty = p.dataset.diff;
  }));
  $('startBtn').addEventListener('click', startInterview);
  loadStatsAndHistory(view);
}

async function loadStatsAndHistory(view) {
  try {
    const [stats, sessions] = await Promise.all([api('/api/stats'), api('/api/sessions')]);
    const sg = view.querySelector('#statGrid');
    if (sg) sg.innerHTML =
      statTile(stats.sessions_completed, '', 'Rounds completed') +
      statTile(stats.avg_overall == null ? '--' : stats.avg_overall.toFixed(1), '<small>/10</small>', 'Average score') +
      statTile(stats.answers_total, '', 'Answers given') +
      statTile(stats.avg_wpm == null ? '--' : stats.avg_wpm, '<small>wpm</small>', 'Speaking pace');
    const hl = view.querySelector('#historyList');
    if (!hl) return;
    if (!sessions.length) {
      hl.innerHTML = '<div class="empty"><p>No rounds yet. Your history will live here.</p></div>';
      return;
    }
    hl.innerHTML = sessions.map(s =>
      '<button class="hrow" data-sid="' + s.session_id + '"><div>' +
      '<div class="hrole">' + escapeHtml(ROLE_NAMES[s.role] || s.role) + '</div>' +
      '<div class="hmeta">' + escapeHtml(s.difficulty) + ' &middot; ' + s.turns_answered + ' answers &middot; ' +
      escapeHtml(s.status) + ' &middot; ' + escapeHtml(fmtDate(s.created_at)) + '</div></div>' +
      '<div class="hscore">' + (s.avg_overall == null ? '<span class="na">--</span>' : s.avg_overall.toFixed(1)) +
      '<small>avg / 10</small></div></button>').join('');
    hl.querySelectorAll('.hrow').forEach(row =>
      row.addEventListener('click', () => { location.hash = '#/report/' + row.dataset.sid; }));
  } catch (e) { toast('Could not load dashboard: ' + e.message); }
}
function statTile(value, suffix, label) {
  return '<div class="card stat rise"><b>' + value + (suffix || '') + '</b><span>' + label + '</span></div>';
}

/* ============ interview ============ */
async function startInterview() {
  const hint = $('setupHint');
  if (hint) hint.textContent = '';
  const btn = $('startBtn');
  if (btn) btn.disabled = true;
  showLoader('Setting up your round...');
  try {
    const d = await api('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: state.role, difficulty: state.difficulty }),
    });
    state.sessionId = d.session_id; state.turn = d.turn; state.totalTurns = d.total_turns;
    state.afterQuestion = d.question;
    location.hash = '#/interview';
  } catch (e) {
    if (hint) hint.textContent = 'Could not start: ' + e.message;
    else toast('Could not start: ' + e.message);
  } finally {
    hideLoader();
    if (btn) btn.disabled = false;
  }
}

function viewInterview(view) {
  if (!state.sessionId || !state.afterQuestion) { location.hash = '#/dashboard'; return; }
  const q = state.afterQuestion;
  state.afterQuestion = null;
  view.innerHTML =
  '<div class="wrap wrap-narrow iv-wrap">' +
    '<div class="iv-top rise"><div class="iv-progress"><i id="progressFill"></i></div>' +
    '<span class="iv-count" id="qCount"></span></div>' +
    '<div class="card q-card rise rise-1"><span class="qnum" id="qNum"></span><h2 id="qText"></h2>' +
    '<div class="qdim" id="qDim"></div></div>' +
    '<div class="card rec-zone rise rise-2">' +
      '<button class="mic" id="recBtn" aria-label="Record answer">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="22"/></svg></button>' +
      '<div class="rec-label" id="recLabel">Tap to record your answer</div>' +
      '<div class="rec-timer hidden" id="recTimer">0:00</div>' +
      '<p class="rec-hint">Speak naturally, like the interviewer is across the table. You can re-record before submitting.</p>' +
      '<div class="answer-pane hidden" id="answerPane" style="width:100%">' +
        '<p class="preview">Recording ready. It will be transcribed after you hit submit.</p>' +
        '<div class="answer-actions" style="justify-content:center">' +
          '<button class="btn btn-ghost btn-sm" id="rerecordBtn">Re-record</button>' +
          '<button class="btn btn-primary" id="submitBtn">Submit answer <span class="arr">&rarr;</span></button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="card result-pane hidden rise" id="resultPane"></div>' +
  '</div>';

  showQuestion(q);
  $('recBtn').addEventListener('click', toggleRecording);
  $('rerecordBtn').addEventListener('click', () => { $('answerPane').classList.add('hidden'); resetRecUI(); });
  $('submitBtn').addEventListener('click', submitAnswer);
}

function showQuestion(q) {
  $('qNum').textContent = 'Question ' + state.turn + ' of ' + state.totalTurns;
  $('qCount').textContent = state.turn + ' / ' + state.totalTurns;
  $('qText').textContent = q.text;
  $('qDim').innerHTML =
    '<span class="chip">' + escapeHtml(ROLE_NAMES[state.role] || '') + '</span>' +
    '<span class="chip">' + escapeHtml(q.dimension.replace(/_/g, ' ')) + '</span>' +
    '<span class="chip">' + escapeHtml(q.difficulty) + '</span>';
  $('progressFill').style.width = ((state.turn - 1) / state.totalTurns * 100) + '%';
  $('answerPane').classList.add('hidden');
  $('resultPane').classList.add('hidden');
  resetRecUI();
}

function resetRecUI() {
  const b = $('recBtn');
  if (!b) return;
  b.classList.remove('recording');
  $('recLabel').textContent = 'Tap to record your answer';
  $('recTimer').classList.add('hidden');
  clearInterval(state.timerInt);
  state.audioBlob = null;
}

async function toggleRecording() {
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
      $('recLabel').textContent = 'Recording ready.';
      $('answerPane').classList.remove('hidden');
    };
    mr.start();
    state.recStart = Date.now();
    $('recBtn').classList.add('recording');
    $('recLabel').textContent = 'Recording... tap again to stop';
    const timer = $('recTimer');
    timer.classList.remove('hidden');
    state.timerInt = setInterval(() => {
      timer.textContent = fmtTime((Date.now() - state.recStart) / 1000);
    }, 250);
  } catch (e) {
    toast('Microphone access denied: ' + e.message);
  }
}
function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') state.mediaRecorder.stop();
  clearInterval(state.timerInt);
  const b = $('recBtn');
  if (b) b.classList.remove('recording');
}

async function submitAnswer() {
  if (!state.audioBlob) { toast('Record an answer first.'); return; }
  showLoader('Transcribing and scoring your answer...');
  try {
    const fd = new FormData();
    fd.append('audio', state.audioBlob, 'answer.webm');
    const r = await fetch('/api/sessions/' + state.sessionId + '/answer',
      { method: 'POST', body: fd, credentials: 'include' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.detail) || ('Server error ' + r.status));
    state.turn = d.turn;
    renderResult(d);
  } catch (e) {
    toast('Submit failed: ' + e.message);
  } finally { hideLoader(); }
}

/* score bars */
function scoreRow(label, value) {
  const pct = value == null ? 0 : Math.max(0, Math.min(10, value)) / 10 * 100;
  const num = value == null ? '--' : value.toFixed(1);
  return '<div class="score-row"><span class="score-label">' + label + '</span>' +
    '<span class="score-track"><span class="score-fill" data-w="' + pct + '"></span></span>' +
    '<span class="score-num" data-v="' + (value == null ? '' : value) + '">' + num + '</span></div>';
}
function animateScores(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.score-fill').forEach(f => { f.style.width = f.dataset.w + '%'; });
    root.querySelectorAll('.score-num[data-v]').forEach(el => {
      const v = el.dataset.v;
      if (v !== '') countUp(el, parseFloat(v));
    });
  }));
}
function countUp(el, target, dur) {
  dur = dur || 750;
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
  const badge = d.llm_status === 'ok'
    ? '<span class="badge ok">AI scored</span>'
    : '<span class="badge warn">' + escapeHtml(d.llm_status === 'llm_not_configured' ? 'AI scoring off, no API key' : 'AI scoring unavailable') + '</span>';
  const s = d.scores || {};
  const pane = $('resultPane');
  pane.innerHTML = badge +
    '<div id="dials">' +
    scoreRow('Content', s.content_relevance != null ? s.content_relevance : null) +
    scoreRow('Clarity', s.clarity_structure != null ? s.clarity_structure : null) +
    scoreRow('Confidence', s.confidence != null ? s.confidence : null) + '</div>' +
    '<div class="metric-grid">' +
      '<div class="metric"><b>' + d.wpm + '</b><span>Words per minute</span></div>' +
      '<div class="metric"><b>' + d.duration_sec.toFixed(1) + 's</b><span>Duration</span></div>' +
      '<div class="metric"><b>' + d.filler.count + '</b><span>Fillers, ' + d.filler.rate_per_100w + ' per 100 words</span></div>' +
    '</div>' +
    '<p class="feedback">' + escapeHtml(d.feedback || 'No feedback available.') + '</p>' +
    '<button class="btn btn-primary" id="nextBtn">' +
      (d.session_complete ? 'See my report <span class="arr">&rarr;</span>' : 'Next question <span class="arr">&rarr;</span>') +
    '</button>';
  pane.classList.remove('hidden');
  animateScores(pane);
  $('nextBtn').addEventListener('click', () => {
    if (d.session_complete) { state.sessionId = null; location.hash = '#/report/' + pane.dataset.sid; }
    else { state.turn = d.turn + 1; showQuestion(d.next_question); }
  });
  pane.dataset.sid = state.sessionId;
  pane.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============ report ============ */
async function viewReport(view, sid) {
  view.innerHTML = '<div class="wrap"><div class="rep-head rise"><p class="kicker">Report</p>' +
    '<h1 class="h-2xl" id="reportTitle">How you did</h1><p class="hmeta" id="reportSub"></p></div>' +
    '<div id="reportBody"></div></div>';
  showLoader('Building your report...');
  try {
    const d = await api('/api/sessions/' + encodeURIComponent(sid) + '/report');
    $('reportSub').textContent =
      (ROLE_NAMES[d.role] || d.role) + ' - ' + d.difficulty + ' - ' + d.turns.length +
      ' questions - ' + fmtDate(d.created_at);
    const av = d.averages || {};
    const body = $('reportBody');
    body.innerHTML =
      '<div class="rep-grid two">' +
        '<div class="card rise rise-1"><p class="kicker">Averages</p><div id="avgBars">' +
          scoreRow('Content', av.content_relevance != null ? av.content_relevance : null) +
          scoreRow('Clarity', av.clarity_structure != null ? av.clarity_structure : null) +
          scoreRow('Confidence', av.confidence != null ? av.confidence : null) +
          scoreRow('Overall', av.overall != null ? av.overall : null) +
        '</div></div>' +
        '<div class="card rise rise-2"><p class="trend-label"><span>Score trend</span><span>per question</span></p><div id="trendScore"></div></div>' +
      '</div>' +
      '<div class="rep-grid two">' +
        '<div class="card rise"><p class="trend-label"><span>Speaking pace</span><span>words per minute</span></p><div id="trendWpm"></div></div>' +
        '<div class="card rise rise-1"><p class="trend-label"><span>Filler words</span><span>per 100 words</span></p><div id="trendFiller"></div></div>' +
      '</div>' +
      '<div class="card rise rise-2" style="margin-bottom:1.1rem"><p class="kicker">Question by question</p><div id="turnList">' +
        (d.turns.length ? d.turns.map(turnHtml).join('') : '<p class="muted">No answers recorded yet.</p>') +
      '</div></div>' +
      '<div style="display:flex;gap:0.8rem;flex-wrap:wrap;margin-bottom:2rem">' +
        '<a class="btn btn-primary" href="#/dashboard">Back to dashboard</a>' +
      '</div>';
    animateScores($('avgBars'));
    sparkline($('trendScore'), d.trends.overall_score || [], { ymin: 0, ymax: 10 });
    sparkline($('trendWpm'), d.trends.wpm || [], {});
    sparkline($('trendFiller'), d.trends.filler_rate || [], { ymin: 0 });
  } catch (e) {
    if (e.status === 404) view.innerHTML = '<div class="wrap nf"><h1>Not found</h1><p>This round does not exist or is not yours.</p><a class="btn btn-primary" href="#/dashboard">Back to dashboard</a></div>';
    else toast('Report failed: ' + e.message);
  } finally { hideLoader(); }
}

function turnHtml(t) {
  const sc = t.scores;
  const chips = sc
    ? '<span class="tscore">Content <b>' + sc.content_relevance + '</b></span>' +
      '<span class="tscore">Clarity <b>' + sc.clarity_structure + '</b></span>' +
      '<span class="tscore">Confidence <b>' + sc.confidence + '</b></span>'
    : '<span class="tscore">not AI-scored (' + escapeHtml(t.llm_status) + ')</span>';
  return '<div class="turn"><h4><span class="qn">Q' + t.n + '.</span>' + escapeHtml(t.question) + '</h4>' +
    '<div class="tmeta">' + escapeHtml(t.dimension.replace(/_/g, ' ')) + ' - ' + escapeHtml(t.difficulty) +
    ' - ' + t.wpm + ' WPM - ' + t.filler_count + ' fillers - ' + t.duration_sec.toFixed(1) + 's</div>' +
    '<div class="tscores">' + chips + '</div>' +
    '<p class="ttrans">&ldquo;' + escapeHtml(t.transcript || '(no speech transcribed)') + '&rdquo;</p>' +
    (t.feedback ? '<p class="tfb">' + escapeHtml(t.feedback) + '</p>' : '') + '</div>';
}

/* ============ settings ============ */
function viewSettings(view) {
  const u = state.user;
  view.innerHTML =
  '<div class="wrap set-wrap">' +
    '<div class="rise"><p class="kicker">Settings</p><h1 class="h-2xl">Your account</h1></div>' +
    '<div class="card set-card rise rise-1"><h2>Profile</h2><p>How your name appears across the app.</p>' +
      '<div class="form-error" id="profError"></div>' +
      '<div class="field"><label for="set-name">Name</label>' +
      '<input class="input" id="set-name" type="text" value="' + escapeHtml(u.name) + '" autocomplete="name"></div>' +
      '<div class="field"><label for="set-email">Email</label>' +
      '<input class="input" id="set-email" type="email" value="' + escapeHtml(u.email) + '" disabled style="opacity:.55"></div>' +
      '<button class="btn btn-ghost" id="saveProfile">Save changes</button></div>' +
    '<div class="card set-card rise rise-2"><h2>Password</h2><p>Use at least 8 characters.</p>' +
      '<div class="form-error" id="pwError"></div>' +
      '<div class="field"><label for="set-cur">Current password</label>' +
      '<input class="input" id="set-cur" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="set-new">New password</label>' +
      '<input class="input" id="set-new" type="password" autocomplete="new-password"></div>' +
      '<button class="btn btn-ghost" id="savePw">Change password</button></div>' +
    '<div class="card set-card danger-card rise rise-3"><h2>Delete my data</h2>' +
      '<p>Permanently removes your account, every round, every recording and every score. This cannot be undone.</p>' +
      '<button class="btn btn-danger" id="delBtn">Delete everything</button>' +
      '<div class="confirm-row" id="delConfirm"><p>Type DELETE below, then confirm. Really.</p>' +
      '<input class="input" id="delText" placeholder="DELETE" style="max-width:200px">' +
      '<button class="btn btn-danger btn-sm" id="delYes">Yes, delete it all</button>' +
      '<button class="btn btn-ghost btn-sm" id="delNo">Keep my account</button></div></div>' +
  '</div>';

  $('saveProfile').addEventListener('click', async () => {
    const name = $('set-name').value.trim();
    const err = $('profError'); err.classList.remove('show');
    if (!name) { err.textContent = 'Name cannot be empty.'; err.classList.add('show'); return; }
    showLoader('Saving...');
    try {
      state.user = await api('/api/auth/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      renderNav(); renderFooter();
      toast('Profile updated.');
    } catch (e) { err.textContent = e.message; err.classList.add('show'); }
    finally { hideLoader(); }
  });

  $('savePw').addEventListener('click', async () => {
    const cur = $('set-cur').value, nw = $('set-new').value;
    const err = $('pwError'); err.classList.remove('show');
    if (nw.length < 8) { err.textContent = 'New password needs at least 8 characters.'; err.classList.add('show'); return; }
    showLoader('Changing password...');
    try {
      await api('/api/auth/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: cur, new_password: nw }),
      });
      $('set-cur').value = ''; $('set-new').value = '';
      toast('Password changed.');
    } catch (e) { err.textContent = e.message; err.classList.add('show'); }
    finally { hideLoader(); }
  });

  $('delBtn').addEventListener('click', () => $('delConfirm').classList.add('show'));
  $('delNo').addEventListener('click', () => $('delConfirm').classList.remove('show'));
  $('delYes').addEventListener('click', async () => {
    if ($('delText').value.trim() !== 'DELETE') { toast('Type DELETE to confirm.'); return; }
    showLoader('Deleting everything...');
    try {
      await api('/api/auth/account', { method: 'DELETE' });
      state.user = null;
      location.hash = '#/';
      toast('Your account and all data were deleted.');
    } catch (e) { toast('Delete failed: ' + e.message); }
    finally { hideLoader(); }
  });
}

/* ============ sparkline (clean SVG, no chart lib) ============ */
function sparkline(el, data, opts) {
  opts = opts || {};
  const W = 640, H = 190, padL = 12, padR = 12, padT = 20, padB = 30;
  const NS = 'http://www.w3.org/2000/svg';
  el.innerHTML = '';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  const vals = data.map(v => (v == null || isNaN(v) ? null : Number(v)));
  const nums = vals.filter(v => v !== null);
  if (!nums.length) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', W / 2); t.setAttribute('y', H / 2);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'spark-empty');
    t.textContent = 'No data yet';
    svg.appendChild(t); el.appendChild(svg); return;
  }
  let lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums);
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
  const pts = [];
  vals.forEach((v, i) => { if (v != null) pts.push([X(i), Y(v)]); });
  if (pts.length >= 2) {
    let dAttr = 'M ' + pts[0][0].toFixed(1) + ' ' + pts[0][1].toFixed(1);
    for (let i = 1; i < pts.length; i++) {
      const x0 = pts[i - 1][0], y0 = pts[i - 1][1], x1 = pts[i][0], y1 = pts[i][1];
      const cx = (x0 + x1) / 2;
      dAttr += ' C ' + cx.toFixed(1) + ' ' + y0.toFixed(1) + ', ' + cx.toFixed(1) + ' ' + y1.toFixed(1) + ', ' + x1.toFixed(1) + ' ' + y1.toFixed(1);
    }
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', dAttr);
    p.setAttribute('class', 'spark-line');
    svg.appendChild(p);
  }
  vals.forEach((v, i) => {
    if (v == null) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', X(i).toFixed(1)); c.setAttribute('cy', Y(v).toFixed(1));
    c.setAttribute('r', 4.5); c.setAttribute('class', 'spark-dot');
    svg.appendChild(c);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', X(i).toFixed(1)); t.setAttribute('y', (Y(v) - 11).toFixed(1));
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

/* ============ boot ============ */
window.addEventListener('hashchange', () => {
  // In-page anchors (#how, #features) are handled inside route(); skip them
  // here so the browser performs its native anchor scroll.
  if ((location.hash || '').startsWith('#/')) route();
});
document.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) location.hash = '#/';
  route();
});
