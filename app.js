// C exam IDE that runs entirely in the browser: Monaco editor, clang (WebAssembly) compiler,
// WASI program runner. Opened as index.html?exam=<id>; the exam is exams/<id>.json.

import { makeZip } from './zip.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const examId = (params.get('exam') || '').replace(/[^\w.-]/g, '');
const STORE_KEY = `cexam:${examId}:v1`;
const interactive = self.crossOriginIsolated === true && typeof SharedArrayBuffer === 'function';

let exam = null;
let editor = null;
let monaco = null;
const models = new Map();       // path -> monaco model
let active = null;              // path of the open file
let openTabs = [];
let compilerReady = false;
let buildSeq = 0;
let runner = null;
let stdinCtrl = null, stdinBuf = null;
let site = {};                  // site.json: {relay: "https://…workers.dev"}
const CANVAS_KEY = `cexam:${examId}:canvas`;
let canvasLink = null;          // {code, name} once linked to the student's Canvas assignment

// ---- console --------------------------------------------------------------------

const con = $('console');
let inputLine = null;

function print(text, cls = '') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  con.insertBefore(span, inputLine);
  con.scrollTop = con.scrollHeight;
  return span;
}

function printDiagnostics(log) {
  // file.c:12:5: error: message  -> clickable, and squiggles in the editor
  const markers = new Map();
  for (const line of log.split('\n')) {
    const m = line.match(/^([^:\s][^:]*):(\d+):(\d+): (error|warning|note|fatal error): (.*)$/);
    if (m && models.has(m[1])) {
      const [, file, ln, col, sev, msg] = m;
      const a = document.createElement('a');
      a.className = `diag ${sev.includes('error') ? 'err' : sev === 'warning' ? 'warn' : 'note'}`;
      a.textContent = line;
      a.href = '#';
      a.onclick = (e) => { e.preventDefault(); openFile(file); editor.revealLineInCenter(+ln); editor.setPosition({ lineNumber: +ln, column: +col }); editor.focus(); };
      con.insertBefore(a, inputLine);
      con.insertBefore(document.createTextNode('\n'), inputLine);
      if (sev !== 'note') {
        if (!markers.has(file)) markers.set(file, []);
        markers.get(file).push({
          startLineNumber: +ln, startColumn: +col, endLineNumber: +ln, endColumn: +col + 1,
          message: msg, severity: sev.includes('error') ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        });
      }
    } else if (line) {
      print(line + '\n', 'dim');
    }
  }
  for (const [p, model] of models) monaco.editor.setModelMarkers(model, 'clang', markers.get(p) || []);
  con.scrollTop = con.scrollHeight;
}

function showInputLine() {
  hideInputLine();
  inputLine = document.createElement('input');
  inputLine.className = 'stdin-line';
  inputLine.spellcheck = false;
  inputLine.autocomplete = 'off';
  inputLine.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendInput(inputLine.value + '\n');
    } else if (e.key === 'd' && e.ctrlKey) {
      e.preventDefault();
      sendInput(null);
    }
  };
  con.appendChild(inputLine);
  $('btn-eof').hidden = false;
  inputLine.focus();
  con.scrollTop = con.scrollHeight;
}

function hideInputLine() {
  if (inputLine) inputLine.remove();
  inputLine = null;
  $('btn-eof').hidden = true;
}

function sendInput(text) {
  if (!stdinCtrl) return;
  const ctrl = new Int32Array(stdinCtrl);
  if (text === null) {
    print('^D\n', 'dim');
    ctrl[1] = -1;
  } else {
    print(text, 'stdin');
    const bytes = new TextEncoder().encode(text).slice(0, stdinBuf.byteLength);
    new Uint8Array(stdinBuf).set(bytes);
    ctrl[1] = bytes.length;
  }
  hideInputLine();
  Atomics.store(ctrl, 0, 1);
  Atomics.notify(ctrl, 0);
}

$('btn-clear').onclick = () => { con.replaceChildren(); if (inputLine) con.appendChild(inputLine); };
$('btn-eof').onclick = () => sendInput(null);

// ---- files & persistence ---------------------------------------------------------

function languageFor(p) {
  if (/\.(c|h)$/.test(p)) return 'c';
  if (/\.md$/.test(p)) return 'markdown';
  return 'plaintext';
}

function currentFiles() {
  const out = {};
  for (const [p, m] of models) out[p] = m.getValue();
  return out;
}

let saveTimer = null;
function scheduleSave() {
  $('save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ files: currentFiles(), active, savedAt: Date.now() }));
    $('save-state').textContent = 'Saved';
  } catch {
    $('save-state').textContent = 'Not saved (browser storage unavailable)';
  }
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

function addModel(p, text) {
  const model = monaco.editor.createModel(text, languageFor(p), monaco.Uri.file('/' + p));
  model.onDidChangeContent(scheduleSave);
  models.set(p, model);
}

function sortedPaths() {
  return [...models.keys()].sort((a, b) => {
    const rank = (p) => (/^readme/i.test(p) ? 0 : p.endsWith('.h') ? 1 : p.endsWith('.c') ? 2 : 3);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

function renderFiles() {
  const ul = $('file-list');
  ul.replaceChildren();
  for (const p of sortedPaths()) {
    const li = document.createElement('li');
    li.className = p === active ? 'active' : '';
    const name = document.createElement('span');
    name.textContent = p;
    name.className = 'fname ' + (p.endsWith('.c') ? 'c' : p.endsWith('.h') ? 'h' : '');
    li.appendChild(name);
    li.onclick = () => openFile(p);
    if (!/^readme/i.test(p)) {
      const del = document.createElement('button');
      del.className = 'icon del';
      del.title = `Delete ${p}`;
      del.textContent = '×';
      del.onclick = (e) => { e.stopPropagation(); confirmDialog(`Delete ${p}?`, 'This cannot be undone.', 'Delete', () => deleteFile(p)); };
      li.appendChild(del);
    }
    ul.appendChild(li);
  }
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const p of openTabs) {
    const t = document.createElement('div');
    t.className = 'tab' + (p === active ? ' active' : '');
    t.textContent = p;
    t.onclick = () => openFile(p);
    const x = document.createElement('span');
    x.className = 'tab-x';
    x.textContent = '×';
    x.onclick = (e) => {
      e.stopPropagation();
      openTabs = openTabs.filter((q) => q !== p);
      if (active === p) openFile(openTabs.at(-1) || sortedPaths()[0]);
      else renderTabs();
    };
    t.appendChild(x);
    tabs.appendChild(t);
  }
}

function openFile(p) {
  if (!models.has(p)) return;
  active = p;
  if (!openTabs.includes(p)) openTabs.push(p);
  editor.setModel(models.get(p));
  editor.updateOptions({ readOnly: false });
  renderFiles();
  renderTabs();
  scheduleSave();
}

function deleteFile(p) {
  models.get(p).dispose();
  models.delete(p);
  openTabs = openTabs.filter((q) => q !== p);
  if (active === p) openFile(openTabs.at(-1) || sortedPaths()[0]);
  renderFiles();
  renderTabs();
  scheduleSave();
}

$('btn-new').onclick = () => {
  $('new-file-row').hidden = false;
  const input = $('new-file-name');
  input.value = '';
  input.focus();
};
$('new-file-name').onkeydown = (e) => {
  if (e.key === 'Escape') { $('new-file-row').hidden = true; return; }
  if (e.key !== 'Enter') return;
  const name = e.target.value.trim();
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(name) || name.includes('..')) { e.target.classList.add('bad'); return; }
  e.target.classList.remove('bad');
  $('new-file-row').hidden = true;
  if (!models.has(name)) {
    addModel(name, name.endsWith('.h') ? `#ifndef ${name.replace(/\W/g, '_').toUpperCase()}\n#define ${name.replace(/\W/g, '_').toUpperCase()}\n\n#endif\n` : '');
  }
  openFile(name);
};

$('btn-reset').onclick = () => confirmDialog('Reset to starter code?',
  'All your changes in every file will be lost.', 'Reset', () => {
    for (const m of models.values()) m.dispose();
    models.clear();
    openTabs = [];
    loadFiles(exam.files);
    save();
  });

// ---- build & run ------------------------------------------------------------------

const compiler = new Worker('compiler-worker.js', { type: 'module' });
const builds = new Map();
let progressLine = null;

compiler.onmessage = ({ data }) => {
  if (data.type === 'progress') {
    const pct = data.total ? Math.floor((100 * data.done) / data.total) : 0;
    progressLine ||= print('', 'dim');
    progressLine.textContent = `Loading the C compiler… ${pct}% (${(data.done / 1e6).toFixed(0)} of ${(data.total / 1e6).toFixed(0)} MB)\n`;
  } else if (data.type === 'ready') {
    compilerReady = true;
    if (progressLine) progressLine.textContent = 'C compiler ready.\n';
    else print('C compiler ready.\n', 'dim');
    setBusy(false);
  } else if (data.type === 'built') {
    const resolve = builds.get(data.id);
    builds.delete(data.id);
    if (resolve) resolve(data);
  }
};
compiler.onerror = (e) => print(`Compiler failed to load: ${e.message || 'unknown error'}\n`, 'err');

function build() {
  const id = ++buildSeq;
  return new Promise((resolve) => {
    builds.set(id, resolve);
    const files = currentFiles();
    compiler.postMessage({ type: 'build', id, files, cflags: exam.cflags });
  });
}

let busy = false;
function setBusy(b) {
  busy = b;
  $('btn-build').disabled = b || !compilerReady;
  $('btn-run').disabled = b || !compilerReady;
}

async function doBuild(andRun) {
  if (busy || !compilerReady) return;
  save();
  setBusy(true);
  hideInputLine();
  print(`\n$ clang ${exam.cflags.join(' ')} *.c\n`, 'cmd');
  const t0 = performance.now();
  const r = await build();
  printDiagnostics(r.log);
  if (!r.ok) {
    print('Build failed.\n', 'err');
    setBusy(false);
    return;
  }
  print(`Build succeeded (${Math.round(performance.now() - t0)} ms).\n`, 'ok');
  if (!andRun) { setBusy(false); return; }
  run(r.wasm);
}

function run(wasm) {
  print('$ ./program\n', 'cmd');
  runner = new Worker('runner-worker.js', { type: 'module' });
  const msg = { type: 'run', wasm, files: currentFiles(), stdinText: $('stdin-text').value };
  if (interactive) {
    stdinCtrl = new SharedArrayBuffer(8);
    stdinBuf = new SharedArrayBuffer(64 * 1024);
    msg.ctrl = stdinCtrl;
    msg.buf = stdinBuf;
  } else {
    stdinCtrl = stdinBuf = null;
  }
  $('btn-stop').disabled = false;
  runner.onmessage = ({ data }) => {
    if (data.type === 'out') print(data.text, data.stream === 2 ? 'stderr' : '');
    else if (data.type === 'input') showInputLine();
    else if (data.type === 'exit') finishRun(`\n[program exited with code ${data.code}]\n`, data.code === 0 ? 'ok' : 'warn');
    else if (data.type === 'crash') finishRun(`\n[runtime error] ${data.message}\n`, 'err');
  };
  runner.onerror = (e) => finishRun(`\n[runtime error] ${e.message || 'worker failed'}\n`, 'err');
  runner.postMessage(msg, [wasm]);
}

function finishRun(text, cls) {
  hideInputLine();
  if (runner) runner.terminate();
  runner = null;
  print(text, cls);
  $('btn-stop').disabled = true;
  setBusy(false);
  editor.focus();
}

$('btn-build').onclick = () => doBuild(false);
$('btn-run').onclick = () => doBuild(true);
$('btn-stop').onclick = () => { if (runner) finishRun('\n[stopped]\n', 'warn'); };

// ---- submit ------------------------------------------------------------------------

// ---- Canvas link (via the relay; see relay/) ------------------------------------------

const canvasEnabled = () => Boolean(site.relay && exam && exam.canvasSubmit);

async function relay(path, payload) {
  let res;
  try {
    res = await fetch(new URL(path, site.relay), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error('Could not reach Canvas. Check the connection, or paste your code into the quiz.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Canvas relay error ${res.status}`);
  return data;
}

function renderCanvasButton() {
  const b = $('btn-canvas');
  b.hidden = !canvasEnabled();
  b.textContent = canvasLink ? `Canvas: ${canvasLink.name} ✓` : 'Link to Canvas';
  b.classList.toggle('linked', Boolean(canvasLink));
}

function linkCanvasDialog(then) {
  const body = document.createElement('div');
  body.innerHTML = `
    <p>Enter the <strong>exam code</strong> shown when you opened the exam <strong>assignment</strong> in Canvas
    (8 letters and numbers). This lets the Submit button send your code straight to Canvas.</p>`;
  const input = document.createElement('input');
  input.className = 'code-input';
  input.placeholder = 'ABCD2345';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 12;
  input.value = canvasLink ? canvasLink.code : '';
  body.appendChild(input);
  const status = document.createElement('p');
  status.className = 'small';
  body.appendChild(status);
  const link = async () => {
    status.className = 'small';
    status.textContent = 'Checking…';
    try {
      const who = await relay('/api/whoami', { code: input.value, exam: examId });
      canvasLink = { code: input.value.trim().toUpperCase(), name: who.name };
      try { localStorage.setItem(CANVAS_KEY, JSON.stringify(canvasLink)); } catch {}
      renderCanvasButton();
      print(`Linked to Canvas as ${who.name}.\n`, 'ok');
      closeModal();
      if (then) then();
    } catch (err) {
      status.className = 'small warn';
      status.textContent = err.message;
    }
    return false;
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); link(); } };
  openModal('Link to Canvas', body, [
    ['Link', 'primary', link],
    ['Not now', '', () => true],
  ]);
  setTimeout(() => input.focus(), 0);
}

$('btn-canvas').onclick = () => linkCanvasDialog();

function submissionFiles() {
  return Object.fromEntries(Object.entries(currentFiles()).filter(([p]) => !/^readme/i.test(p)));
}

function submissionText() {
  const files = currentFiles();
  return sortedPaths()
    .filter((p) => !/^readme/i.test(p))
    .map((p) => `===== ${p} =====\n${files[p].replace(/\s+$/, '')}\n`)
    .join('\n');
}

// Copy to the clipboard; falls back to selecting the text box (which must be on the page)
async function copyToClipboard(text, ta) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  ta.focus();
  ta.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

$('btn-copy').onclick = async () => {
  save();
  const text = submissionText();
  const body = document.createElement('div');
  const msg = document.createElement('div');
  body.appendChild(msg);
  const ta = document.createElement('textarea');
  ta.className = 'submission';
  ta.readOnly = true;
  ta.value = text;
  body.appendChild(ta);
  const status = document.createElement('p');
  status.className = 'small';
  body.appendChild(status);
  const showResult = (ok) => {
    msg.innerHTML = ok ? `
      <p><strong>Your code is copied.</strong> Switch to the <strong>quiz tab</strong>, click in the answer box,
      and paste (Ctrl+V or ⌘V). Check that all your code appears, then submit the quiz.</p>
      <p class="muted small">This is what was copied:</p>` : `
      <p><strong>Copying was blocked.</strong> Click in the box below, select all (Ctrl+A or ⌘A), copy (Ctrl+C or ⌘C),
      then paste it into the answer box in the <strong>quiz tab</strong>.</p>`;
  };
  const actions = [['Copy again', '', async () => { showResult(await copyToClipboard(text, ta)); return false; }]];
  // Optional: send the code straight to a Canvas assignment through the relay (see relay/)
  if (canvasEnabled()) actions.push(['Submit to Canvas', 'submit', async () => {
    if (!canvasLink) { linkCanvasDialog(() => $('btn-copy').click()); return false; }
    status.className = 'small';
    status.textContent = 'Sending to Canvas…';
    try {
      const r = await relay('/api/submit', { code: canvasLink.code, exam: examId, files: submissionFiles() });
      const when = new Date(r.submittedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      status.className = 'small ok';
      status.textContent = `Submitted to Canvas at ${when} as ${r.name}.`;
      print(`Submitted to Canvas at ${when}.\n`, 'ok');
    } catch (err) {
      status.className = 'small warn';
      status.textContent = err.message;
    }
    return false;
  }]);
  // LockDown Browser blocks downloads, so the zip button is only offered when the exam enables it
  if (exam.allowDownload) actions.push(['Download .zip', '', () => {
    const blob = makeZip(submissionFiles());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'submission.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    return false;
  }]);
  actions.push(['Close', 'primary', () => true]);
  openModal('Paste your code into the quiz', body, actions);
  showResult(await copyToClipboard(text, ta));
};

// ---- modal -------------------------------------------------------------------------

function openModal(title, bodyNode, actions) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(bodyNode);
  const bar = $('modal-actions');
  bar.replaceChildren();
  for (const [label, cls, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = async () => { if ((await fn()) !== false) closeModal(); };
    bar.appendChild(b);
  }
  $('modal').hidden = false;
}
function closeModal() { $('modal').hidden = true; editor && editor.focus(); }
function confirmDialog(title, text, okLabel, onOk) {
  const p = document.createElement('p');
  p.textContent = text;
  openModal(title, p, [[okLabel, 'danger', () => { onOk(); return true; }], ['Cancel', '', () => true]]);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

// ---- panel resizer -----------------------------------------------------------------

(function resizer() {
  const panel = $('panel');
  const area = $('editor-area');
  let startY = 0, startH = 0;
  $('resizer').onpointerdown = (e) => {
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    $('resizer').setPointerCapture(e.pointerId);
    $('resizer').onpointermove = (ev) => {
      const h = Math.min(area.clientHeight - 120, Math.max(80, startH + startY - ev.clientY));
      panel.style.flexBasis = `${h}px`;
      editor && editor.layout();
    };
  };
  $('resizer').onpointerup = (e) => { $('resizer').onpointermove = null; $('resizer').releasePointerCapture(e.pointerId); };
})();

// ---- startup -----------------------------------------------------------------------

function loadFiles(files, activeHint) {
  for (const [p, text] of Object.entries(files)) addModel(p, text);
  const paths = sortedPaths();
  const first = (activeHint && models.has(activeHint) && activeHint) || paths.find((p) => /^readme/i.test(p)) || paths[0];
  openTabs = [];
  const firstC = paths.find((p) => p.endsWith('.c') && p !== first);
  if (first) openFile(first);
  if (firstC && !openTabs.includes(firstC)) { openTabs.push(firstC); renderTabs(); }
}

function fail(title, text) {
  document.body.innerHTML = `<div class="fatal"><h1></h1><p></p></div>`;
  document.querySelector('.fatal h1').textContent = title;
  document.querySelector('.fatal p').textContent = text;
}

async function start() {
  if (!examId) return fail('No exam selected', 'Open this page from the link in your Canvas quiz.');
  try {
    const res = await fetch(`exams/${examId}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    exam = await res.json();
  } catch {
    return fail('Exam not found', 'Check the link in your Canvas quiz, or ask your instructor.');
  }
  try {
    const s = await fetch('site.json', { cache: 'no-cache' });
    if (s.ok) site = await s.json();
  } catch {}
  try { canvasLink = JSON.parse(localStorage.getItem(CANVAS_KEY) || 'null'); } catch {}
  document.title = exam.title;
  $('exam-title').textContent = exam.title;
  $('io-mode').textContent = interactive ? 'keyboard input: type when the program asks' : 'keyboard input: enter it in the box above before running';
  $('stdin-box').hidden = interactive;

  self.MonacoEnvironment = { getWorkerUrl: () => new URL('monaco-worker.js', location.href).href };
  window.require.config({ paths: { vs: 'vendor/monaco/vs' } });
  monaco = await new Promise((resolve) => window.require(['vs/editor/editor.main'], () => resolve(window.monaco)));

  editor = monaco.editor.create($('editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    tabSize: 4,
    insertSpaces: true,
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    // No AI or network features exist here; keep suggestions to words in the open files
    quickSuggestions: { other: true, comments: false, strings: false },
    wordBasedSuggestions: 'currentDocument',
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => doBuild(true));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => doBuild(false));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, save);

  const saved = loadSaved();
  loadFiles(saved && saved.files ? saved.files : exam.files, saved && saved.active);
  if (saved) print(`Restored your work from ${new Date(saved.savedAt).toLocaleString()}.\n`, 'dim');

  setBusy(true);
  compiler.postMessage({ type: 'warm' });

  renderCanvasButton();
  if (canvasEnabled() && !canvasLink) linkCanvasDialog();
}

// Don't lose the last half-second of typing if the page closes or the lockdown browser restarts
addEventListener('pagehide', () => editor && save());
document.addEventListener('visibilitychange', () => { if (document.hidden && editor) save(); });

document.addEventListener('keydown', (e) => {
  // Keep the browser's own Save/Print dialogs out of the way
  if ((e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key)) e.preventDefault();
});

start();
