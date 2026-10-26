// Compiles the project with clang (WebAssembly build of LLVM) to a WASI program.
// Messages in:  {type: 'warm'} | {type: 'build', id, files: {path: text}, cflags: [...]}
// Messages out: {type: 'progress', done, total} | {type: 'ready'} | {type: 'built', id, ok, log, wasm?}

import { runClang } from './vendor/clang/bundle.js';

// Linked into every program: unbuffered stdout so prompts appear before the program waits for input.
const RUNTIME = `#include <stdio.h>
__attribute__((constructor)) static void __cexam_unbuffer(void) { setvbuf(stdout, NULL, _IONBF, 0); }
`;
const RUNTIME_NAME = '__cexam_runtime.c';
const OUTPUT = '__cexam_program.wasm';
const LINK_FLAGS = ['-Wl,-z,stack-size=8388608']; // 8 MB stack, like a typical Linux default

const progress = new Map();
function onProgress({ source, totalLength, doneLength }) {
  progress.set(source, { totalLength, doneLength });
  let done = 0, total = 0;
  for (const p of progress.values()) { done += p.doneLength; total += p.totalLength; }
  postMessage({ type: 'progress', done, total });
}

// {"src/a.c": "..."} -> {src: {"a.c": "..."}}
function toTree(files) {
  const tree = {};
  for (const [p, text] of Object.entries(files)) {
    const parts = p.split('/');
    let node = tree;
    for (const dir of parts.slice(0, -1)) node = node[dir] ||= {};
    node[parts.at(-1)] = text;
  }
  return tree;
}

async function compile(files, cflags) {
  const dec = new TextDecoder();
  let log = '';
  const capture = (bytes) => { if (bytes) log += dec.decode(bytes, { stream: true }); };
  const sources = Object.keys(files).filter((f) => f.endsWith('.c'));
  if (!sources.length) return { ok: false, log: 'No .c files to compile.\n' };
  const tree = toTree(files);
  tree[RUNTIME_NAME] = RUNTIME;
  try {
    const out = await runClang(['clang', ...cflags, ...sources, RUNTIME_NAME, ...LINK_FLAGS, '-o', OUTPUT], tree,
      { stdout: capture, stderr: capture, fetchProgress: onProgress });
    return { ok: true, log, wasm: out[OUTPUT] };
  } catch (err) {
    if (err && typeof err.code === 'number') return { ok: false, log }; // clang exited with errors
    return { ok: false, log: `${log}Internal compiler error: ${err && err.message ? err.message : err}\n` };
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'warm') {
    await compile({ 'warm.c': 'int main(void) { return 0; }\n' }, []);
    postMessage({ type: 'ready' });
  } else if (data.type === 'build') {
    const r = await compile(data.files, data.cflags);
    const msg = { type: 'built', id: data.id, ok: r.ok, log: r.log };
    if (r.wasm) {
      const buf = r.wasm.buffer.slice(r.wasm.byteOffset, r.wasm.byteOffset + r.wasm.byteLength);
      msg.wasm = buf;
      postMessage(msg, [buf]);
    } else {
      postMessage(msg);
    }
  }
};
