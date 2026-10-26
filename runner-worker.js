// Runs a compiled WASI program. Terminated from the page to stop it.
// Messages in:  {type: 'run', wasm, files, stdinText, ctrl?, buf?}
//   With ctrl/buf (SharedArrayBuffers), stdin is interactive: the worker asks the page for a line
//   and blocks until it arrives. Without them, stdin is stdinText followed by end-of-file.
// Messages out: {type: 'out', stream: 1|2, text} | {type: 'input'} | {type: 'exit', code} | {type: 'crash', message}

import { WASI, Fd, Inode, File, Directory, PreopenDirectory, wasi as W } from './vendor/wasi-shim/index.js';

const MAX_OUTPUT = 2 * 1024 * 1024;

let sent = 0;
let pending = { 1: '', 2: '' };
let lastFlush = 0;
const dec = { 1: new TextDecoder(), 2: new TextDecoder() };

function flush() {
  for (const stream of [1, 2]) {
    if (pending[stream]) {
      postMessage({ type: 'out', stream, text: pending[stream] });
      pending[stream] = '';
    }
  }
  lastFlush = Date.now();
}

class OutputLimit extends Error {}

class Output extends Fd {
  constructor(stream) {
    super();
    this.stream = stream;
    this.ino = Inode.issue_ino();
  }
  fd_fdstat_get() {
    const s = new W.Fdstat(W.FILETYPE_CHARACTER_DEVICE, 0);
    s.fs_rights_base = BigInt(W.RIGHTS_FD_WRITE);
    return { ret: 0, fdstat: s };
  }
  fd_filestat_get() {
    return { ret: 0, filestat: new W.Filestat(this.ino, W.FILETYPE_CHARACTER_DEVICE, 0n) };
  }
  fd_write(data) {
    sent += data.byteLength;
    if (sent > MAX_OUTPUT) throw new OutputLimit();
    pending[this.stream] += dec[this.stream].decode(data, { stream: true });
    if (Date.now() - lastFlush > 30 || pending[this.stream].length > 8192) flush();
    return { ret: 0, nwritten: data.byteLength };
  }
}

class Input extends Fd {
  constructor(text, ctrl, buf) {
    super();
    this.ino = Inode.issue_ino();
    this.data = new TextEncoder().encode(text || '');
    this.interactive = Boolean(ctrl);
    this.ctrl = ctrl && new Int32Array(ctrl);
    this.bytes = buf && new Uint8Array(buf);
    this.eof = false;
  }
  fd_fdstat_get() {
    const s = new W.Fdstat(W.FILETYPE_CHARACTER_DEVICE, 0);
    s.fs_rights_base = BigInt(W.RIGHTS_FD_READ);
    return { ret: 0, fdstat: s };
  }
  fd_filestat_get() {
    return { ret: 0, filestat: new W.Filestat(this.ino, W.FILETYPE_CHARACTER_DEVICE, 0n) };
  }
  fd_read(size) {
    if (!this.data.length && !this.eof) {
      if (!this.interactive) {
        this.eof = true;
      } else {
        flush();
        postMessage({ type: 'input' });
        Atomics.wait(this.ctrl, 0, 0);          // page sets ctrl[0] = 1 when a line is ready
        const len = this.ctrl[1];
        if (len < 0) this.eof = true;           // Ctrl+D
        else this.data = this.bytes.slice(0, len);
        Atomics.store(this.ctrl, 0, 0);
      }
    }
    const n = Math.min(size, this.data.length);
    const out = this.data.slice(0, n);
    this.data = this.data.slice(n);
    return { ret: 0, data: out };
  }
}

// Project files are visible to the program (e.g. fopen("data.txt", "r")); writes stay in memory.
function directory(files) {
  const root = new Map();
  const enc = new TextEncoder();
  for (const [p, text] of Object.entries(files)) {
    const parts = p.split('/');
    let dir = root;
    for (const d of parts.slice(0, -1)) {
      if (!dir.has(d)) dir.set(d, new Directory(new Map()));
      dir = dir.get(d).contents;
    }
    dir.set(parts.at(-1), new File(enc.encode(text)));
  }
  return root;
}

function describe(err) {
  const m = String(err && err.message || err);
  if (/unreachable/i.test(m)) return 'Program aborted (abort(), a failed assert, or undefined behavior trap).';
  if (/out of bounds/i.test(m)) return 'Memory access out of bounds (like a segmentation fault).';
  if (/call stack|stack overflow|too much recursion/i.test(m)) return 'Stack overflow (runaway recursion?).';
  if (/divide by zero|integer overflow/i.test(m)) return 'Integer division by zero.';
  return m;
}

self.onmessage = async ({ data }) => {
  if (data.type !== 'run') return;
  const stdin = new Input(data.stdinText, data.ctrl, data.buf);
  const fds = [stdin, new Output(1), new Output(2), new PreopenDirectory('.', directory(data.files))];
  const wasi = new WASI(['program'], [], fds);
  try {
    const module = await WebAssembly.compile(data.wasm);
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
    const code = wasi.start(instance);
    flush();
    postMessage({ type: 'exit', code });
  } catch (err) {
    flush();
    if (err instanceof OutputLimit) postMessage({ type: 'crash', message: 'Stopped: the program printed more than 2 MB of output.' });
    else postMessage({ type: 'crash', message: describe(err) });
  }
};
