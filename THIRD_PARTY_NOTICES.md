# Third-party notices

The MIT license in [LICENSE](LICENSE) covers the files written for this project. The files below come from other
projects and keep their own licenses.

## In this repository: `editor/static/vendor/clang/`

These make the **Build** button work in the browser (a C compiler running as WebAssembly).

| File | What it is | Source | License |
|---|---|---|---|
| `shared.js`, `worker.js` | JavaScript that runs clang and gives it an in-memory file system | [binji/wasm-clang](https://github.com/binji/wasm-clang) | Apache License 2.0 (copy in `editor/static/vendor/clang/LICENSE`) |
| `clang` | the clang C compiler, compiled to WebAssembly (WASI) | built from the [LLVM project](https://llvm.org/) by the wasm-clang project | Apache License 2.0 with LLVM Exceptions |
| `memfs` | in-memory file system for WASI | [binji/wasm-clang](https://github.com/binji/wasm-clang) | Apache License 2.0 |
| `sysroot.tar` | C headers and libraries (a WASI sysroot) the compiler reads | from the wasm-clang project; it contains parts of other open-source projects (for example wasi-libc and libc++) | each part has its own permissive open-source license (Apache-2.0, MIT, BSD) |

`editor/static/vendor/clang/cc_worker.js` is written for this project (MIT).

I did not change the compiler, `shared.js`, `worker.js`, `memfs` or `sysroot.tar`. If you need the exact license of
a file inside `sysroot.tar`, look in the wasm-clang and wasi-libc projects.

## Loaded from the internet, not stored in this repository

- [Pyodide](https://pyodide.org/) (Python for WebAssembly), loaded from the jsDelivr CDN when the page opens. Mozilla Public License 2.0.

## Names

UML is a standard. Product and company names that appear in the history of this project belong to their owners.
This project is independent and is not affiliated with, or endorsed by, any tool vendor.
