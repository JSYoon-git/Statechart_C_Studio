/* Compile-check worker: runs the wasm clang (binji/wasm-clang, Apache-2.0) with the same strict C89 flags
   the Python server gives gcc. Message in:  {files: {name: text}}   out: {ok, log, text}  */
self.importScripts('shared.js');

let out = '';
const enc = new TextEncoder();
const api = new API({
  async readBuffer(f) { return (await fetch(f)).arrayBuffer(); },
  async compileStreaming(f) { return WebAssembly.compile(await (await fetch(f)).arrayBuffer()); },
  hostWrite(s) { out += s; },
});

const ARGS = ['-cc1', '-fsyntax-only', '-disable-free', '-isysroot', '/', '-internal-isystem', '/include',
  '-internal-isystem', '/lib/clang/8.0.1/include', '-ferror-limit', '200', '-fmessage-length', '0',
  '-std=c89', '-pedantic', '-Wall', '-Wextra', '-Wdeclaration-after-statement', '-I', '/', '-x', 'c'];

self.onmessage = async (ev) => {
  const files = ev.data.files;
  let ok = true;
  const lines = [];
  try {
    await api.ready;
    const clang = await api.getModule('clang');
    for (const [name, text] of Object.entries(files)) api.memfs.addFile(name, enc.encode(text).buffer);
    for (const name of Object.keys(files).filter((n) => n.endsWith('.c')).sort()) {
      out = '';
      try { await api.run(clang, 'clang', ...ARGS, name); } catch (e) { ok = false; }
      for (const ln of out.split('\n')) if (/\b(error|warning|fatal error)\b|: note:/i.test(ln)) lines.push(ln.trim());
    }
    if (lines.some((l) => /\berror\b/.test(l))) ok = false;
    self.postMessage({ ok, log: lines.join('\n') });
  } catch (e) {
    self.postMessage({ ok: false, log: '', error: String(e && e.message || e) });
  }
};
