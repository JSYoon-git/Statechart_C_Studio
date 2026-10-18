# Statechart C Studio

Draw a statechart in the browser, get framework-free C89 (`X.c` / `X.h`) for a 10 ms task.
Runs entirely in the browser on GitHub Pages: the Python code generator runs in Pyodide and **Build**
compiles with a WebAssembly clang (`-std=c89 -pedantic -Wall -Wextra -Wdeclaration-after-statement`).
No server needed. First load downloads Pyodide and clang (~40 MB), then the browser caches them.

Locally with the Python server (also compiles with MSVC `/W4` or gcc): `python editor/server.py`
Details: [editor/README.md](editor/README.md).

`editor/static/py/` is a copy of `editor/model.py` and `codegen/{sc_ir,rhp_c,task_c}.py`; the Pages workflow refreshes it.
The bundled clang is [binji/wasm-clang](https://github.com/binji/wasm-clang) (Apache-2.0).
