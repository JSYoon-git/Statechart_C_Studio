"""QA metrics for the task-style generated code (no framework).

    python editor/tests/qa_metrics.py [--json out.json]

For every example project:
  * builds the visible module files + the example main.c with MSVC  /W4 /WX  (x86 and x64)
  * runs MSVC's static analyzer  /analyze  on the modules
  * code size: .text of each module object (x86, /O1)        - a 32-bit stand-in for an MCU
  * RAM: sizeof(X) per instance (x86)
  * PC time of one X_Main call (x64 /O2, idle inputs)         - relative numbers only
  * forbidden names: RiC*, malloc, free, recursion markers in the visible files
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import server  # noqa: E402
EX = os.path.join(HERE, "..", "static", "examples")

VC = os.path.dirname(server.find_vcvars() or "")


def vcvars(arch):
    return os.path.join(VC, "vcvars32.bat" if arch == "x86" else "vcvars64.bat")


def run_bat(out, name, lines, arch):
    bat = os.path.join(out, name)
    with open(bat, "w", encoding="mbcs") as f:
        f.write("@echo off\r\nset VSLANG=1033\r\n" f'call "{vcvars(arch)}" >nul\r\n' 'cd /d "%~dp0"\r\n' + "\r\n".join(lines) + "\r\n")
    r = subprocess.run(["cmd", "/d", "/c", bat], cwd=out, capture_output=True, text=True, encoding="mbcs",
                       errors="replace", timeout=300)
    return r.returncode, r.stdout + r.stderr


def text_size(out, obj, arch):
    rc, log = run_bat(out, "dump.bat", [f"dumpbin /headers {obj}"], arch)
    size, cur = 0, None
    for ln in log.splitlines():
        m = re.match(r"SECTION HEADER #\d+", ln.strip())
        if m:
            cur = None
        m = re.match(r"\s*(\.\S+)\s+name", ln)
        if m:
            cur = m.group(1)
        m = re.match(r"\s*([0-9A-F]+) size of raw data", ln)
        if m and cur and cur.startswith(".text"):
            size += int(m.group(1), 16)
    return size


def main():
    server.OUT = tempfile.mkdtemp(prefix="sc_qa_")
    rows = []
    for fn in sorted(os.listdir(EX)):
        project = json.load(open(os.path.join(EX, fn), encoding="utf-8"))
        pkg, out, files, warnings = server.do_generate(project)
        mods = [c.name for c in pkg.classes]
        csrc = [f"{m}.c" for m in mods]
        row = {"example": fn, "package": pkg.name, "classes": mods, "warnings": warnings}
        vis = "".join(files.values())
        row["forbidden"] = sorted(set(re.findall(r"\b(RiC\w*|ric_\w+|malloc|calloc|realloc|free)\b", vis)))
        # 1) /W4 /WX, both targets, modules + example main.c
        for arch in ("x86", "x64"):
            rc, log = run_bat(out, f"w4_{arch}.bat", [f"if not exist {arch} mkdir {arch}", f"cl /nologo /W4 /WX /utf-8 /wd4819 /c {' '.join(csrc)} main.c /Fo{arch}\\"], arch)
            row[f"w4_{arch}"] = "clean" if rc == 0 else "\n".join(ln for ln in log.splitlines() if re.search(r"warning|error", ln))[:800]
        # 2) static analysis
        rc, log = run_bat(out, "an.bat", ["if not exist an mkdir an", f"cl /nologo /analyze /W4 /utf-8 /wd4819 /c {' '.join(csrc)} /Foan\\"], "x64")
        row["analyze"] = sorted({m.group(0) for m in re.finditer(r"(warning|error) C\d+[^\n]*", log)})
        # 3) code size (x86 /O1)
        rc, log = run_bat(out, "o1.bat", ["if not exist sz mkdir sz", f"cl /nologo /O1 /GS- /utf-8 /wd4819 /c {' '.join(csrc)} /Fosz\\"], "x86")
        row["text_x86_O1"] = {m: text_size(out, os.path.join("sz", f"{m}.obj"), "x86") for m in mods}
        # 4) sizeof + time per X_Main call
        prog = ["#include <stdio.h>", "#include <windows.h>"] + [f'#include "{m}.h"' for m in mods]
        prog += [f"static {m} o_{m};" for m in mods]
        prog += ["int main(void) {", "    LARGE_INTEGER f, a, b; long i; const long N = 2000000L;",
                 "    QueryPerformanceFrequency(&f);"]
        for g in pkg.classes:
            ins = [a for a in g.attributes if a.dir == "in"]
            outs = [a for a in g.attributes if a.dir == "out"]
            prog.append(f'    printf("sizeof {g.name} %u\\n", (unsigned)sizeof({g.name}));')
            if g.io_struct:          # X_Main(me, const X_In* in, X_Out* out)
                decl = ["    { " + (f"static {g.name}_In vi; " if ins else "") + (f"{g.name}_Out vo;" if outs else "")]
                args = [f"&o_{g.name}"] + (["&vi"] if ins else []) + (["&vo"] if outs else [])
                ret_used = False
            else:
                decl = ["    { " + " ".join(f"{a.type} v_{a.name};" for a in outs)] if len(outs) > 1 else ["    {"]
                args = [f"&o_{g.name}"] + [{"bool": "false"}.get(a.type.strip(), "0") for a in ins]
                if len(outs) > 1:
                    args += [f"&v_{a.name}" for a in outs]
                ret_used = len(outs) == 1
            call = f"{g.name}_Main({', '.join(args)})"
            prog += decl + [f"    {g.name}_Init(&o_{g.name});", "    QueryPerformanceCounter(&a);",
                            f"    for (i = 0; i < N; i++) {{ {'(void)' if ret_used else ''}{call}; }}",
                            "    QueryPerformanceCounter(&b);",
                            f'    printf("ns {g.name} %.2f\\n", (double)(b.QuadPart - a.QuadPart) * 1e9 / (double)f.QuadPart / (double)N);',
                            "    }"]
        prog += ["    return 0;", "}", ""]
        with open(os.path.join(out, "qa_bench.c"), "w", encoding="utf-8") as f:
            f.write("\n".join(prog))
        with open(os.path.join(out, "noprint.h"), "w") as f:      # time the state machine, not the console
            f.write("#include <stdio.h>\n#define printf(...) ((void)0)\n")
        rc, log = run_bat(out, "bench.bat", ["if not exist bn mkdir bn",
                                             f"cl /nologo /O2 /utf-8 /wd4819 /DNDEBUG /D_CRT_SECURE_NO_WARNINGS /FInoprint.h /c {' '.join(csrc)} /Fobn\\",
                                             "cl /nologo /O2 /utf-8 /wd4819 /D_CRT_SECURE_NO_WARNINGS qa_bench.c bn\\*.obj /Fe:qa_bench.exe"], "x64")
        sz, ns = {}, {}
        try:
            res = subprocess.run([os.path.join(out, "qa_bench.exe")], capture_output=True, text=True, timeout=120,
                                 encoding="utf-8", errors="replace").stdout
            for ln in res.splitlines():
                p = ln.split()
                if p[:1] == ["sizeof"]:
                    sz[p[1]] = int(p[2])
                elif p[:1] == ["ns"]:
                    ns[p[1]] = float(p[2])
        except (OSError, subprocess.SubprocessError):
            pass
        row["sizeof_x64"], row["ns_per_main_x64"] = sz, ns
        rows.append(row)
        print(f"{fn:20} W4(x86/x64)={row['w4_x86']}/{row['w4_x64']}  analyze={len(row['analyze'])}  "
              f"text={row['text_x86_O1']}  sizeof={sz}  ns/Main={ns}  forbidden={row['forbidden']}")
    if "--json" in sys.argv:
        with open(sys.argv[sys.argv.index("--json") + 1], "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=1, ensure_ascii=False)
    bad = [r for r in rows if r["w4_x86"] != "clean" or r["w4_x64"] != "clean" or r["forbidden"]]
    print(f"\n{len(rows) - len(bad)}/{len(rows)} examples: /W4 /WX clean on x86 and x64, no framework names")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
