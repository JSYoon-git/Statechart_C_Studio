/* Simulation worker: builds the generated C + the harness (sim_main.c) to a wasm module with the wasm clang +
   lld (binji/wasm-clang, Apache-2.0) and runs it with a stdin text. Host side: static/backend.js (simHost).
     {id, op:'build', mid, files:{name:text}}  ->  {id, ok, log, wasm}
     {id, op:'load',  mid, wasm}               ->  {id}
     {id, op:'run',   mid, stdin}              ->  {id, out, err}   (err: why the run ended abnormally, if it did) */
self.importScripts('shared.js');

let out = '';
const enc = new TextEncoder();
const api = new API({
  async readBuffer(f) { return (await fetch(f)).arrayBuffer(); },
  async compileStreaming(f) { return WebAssembly.compile(await (await fetch(f)).arrayBuffer()); },
  hostWrite(s) { out += s; },
});

const CC = ['-cc1', '-emit-obj', '-disable-free', '-isysroot', '/', '-internal-isystem', '/include',
  '-internal-isystem', '/lib/clang/8.0.1/include', '-ferror-limit', '50', '-fmessage-length', '0', '-O0', '-x', 'c'];
const mods = new Map();       // mid -> WebAssembly.Module
const errLines = (text) => text.split('\n').filter((l) => /\b(error|fatal error)\b|: note:/i.test(l)).map((l) => l.trim().replace(/\bb\d+\//g, ''));

async function build(mid, files) {
  await api.ready;
  const clang = await api.getModule('clang');
  const lld = await api.getModule('lld');
  const dir = 'b' + mid;
  api.memfs.addDirectory(dir);
  for (const [name, text] of Object.entries(files)) api.memfs.addFile(dir + '/' + name, enc.encode(text).buffer);
  const objs = [], lines = [];
  let ok = true;
  for (const name of Object.keys(files).filter((n) => n.endsWith('.c')).sort()) {
    out = '';
    const obj = dir + '/' + name.replace(/\.c$/, '.o');
    try { await api.run(clang, 'clang', ...CC, '-I', dir, '-o', obj, dir + '/' + name); objs.push(obj); } catch (e) { ok = false; }
    lines.push(...errLines(out));
  }
  if (lines.some((l) => /\berror\b/.test(l))) ok = false;
  let wasm = null;
  if (ok) {
    const libdir = 'lib/wasm32-wasi', exe = dir + '/sim.wasm';
    out = '';
    try {
      await api.run(lld, 'wasm-ld', '--no-threads', '--export-dynamic', '-z', 'stack-size=1048576', '-L' + libdir,
        libdir + '/crt1.o', ...objs, '-lc', '-lm', '-o', exe);
      wasm = api.memfs.getFileContents(exe).slice();
    } catch (e) { ok = false; }
    lines.push(...errLines(out));
    if (!wasm) ok = false;
  }
  if (ok) mods.set(mid, new WebAssembly.Module(wasm));
  return { ok, log: lines.join('\n'), wasm };
}

async function runSim(mid, stdin) {
  await api.ready;
  out = '';
  api.memfs.setStdinStr(stdin);
  let err = null;
  try { await api.run(mods.get(mid), 'sim.wasm'); } catch (e) { err = String((e && e.message) || e); }
  const arrow = '\x1b[1;93m> sim.wasm\n';                // api.run announces itself on the output
  return { out: out.startsWith(arrow) ? out.slice(arrow.length) : out, err };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.op === 'build') {
      const r = await build(m.mid, m.files);
      self.postMessage({ id: m.id, ok: r.ok, log: r.log, wasm: r.wasm }, r.wasm ? [r.wasm.buffer] : []);
    } else if (m.op === 'load') {
      await api.ready;
      mods.set(m.mid, new WebAssembly.Module(m.wasm));
      self.postMessage({ id: m.id });
    } else if (m.op === 'run') {
      const r = await runSim(m.mid, m.stdin);
      self.postMessage({ id: m.id, out: r.out, err: r.err });
    }
  } catch (e) {
    self.postMessage({ id: m.id, fatal: String((e && e.message) || e) });
  }
};
