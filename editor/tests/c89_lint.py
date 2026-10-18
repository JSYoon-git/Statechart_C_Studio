"""A small C89 lint for the generated files.

MSVC's C compiler accepts C99 extras (// comments, mixed declarations ...), so it cannot show that
the output is C89. This checks what a C89 compiler rejects in generated code:

  * // comments, <stdbool.h>, designated initializers ({ .x = 1 }), inline / restrict / _Bool /
    long long, a declaration inside a for ( ... ) header
  * a declaration after a statement in the same { } block
"""
import re

DECL = re.compile(r"^(static\s+)?(const\s+)?(unsigned\s+)?(void|bool|char|short|int|long|float|double|u?int\d+_t|[A-Z]\w*)"
                  r"\s*\**\s*\w+(\[[^\]]*\])?(\s*=\s*[^;]+)?;$")


def strip_comments_strings(text):
    text = re.sub(r"/\*.*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text, flags=re.S)
    return re.sub(r'"(?:\\.|[^"\\])*"', '""', text)


def problems(name, text):
    """List of "file:line: what" for everything in `text` that C89 does not allow."""
    bad = []
    code = strip_comments_strings(text).splitlines()
    for n, c in enumerate(code, 1):
        if "//" in c:
            bad.append(f"{name}:{n}: // comment")
        if re.search(r"#\s*include\s*<stdbool\.h>", c):
            bad.append(f"{name}:{n}: <stdbool.h> is C99")
        if re.search(r"(\{|,)\s*\.\w+\s*=", c):
            bad.append(f"{name}:{n}: designated initializer")
        if re.search(r"\b(inline|restrict|_Bool)\b|\blong\s+long\b", c):
            bad.append(f"{name}:{n}: C99 keyword")
        if re.search(r"\bfor\s*\(\s*(unsigned|u?int\w*|bool|char|short|long)\b", c):
            bad.append(f"{name}:{n}: declaration in a for loop")
    top = [False]            # per open block: has a statement been seen yet?
    for n, c in enumerate(code, 1):
        t = c.strip()
        if not t or t.startswith("#"):
            continue
        if t.startswith("}"):
            if len(top) > 1:
                top.pop()
            t = t.lstrip("} ").strip()
            if not t:
                continue
        if len(top) > 1 and DECL.match(t):
            if top[-1]:
                bad.append(f"{name}:{n}: declaration after a statement: {t}")
            continue
        if t.endswith("{"):
            if len(top) > 1:
                top[-1] = True               # the line opening a block is a statement of the outer block
            top.append(False)
            continue
        if len(top) > 1 and not t.startswith(("case ", "default:")) and t != "break;":
            top[-1] = True
    return bad


if __name__ == "__main__":
    sample = "void f(void) {\n    int a;\n    a = 1;\n    int b;\n    // x\n}\nstatic S s = { .x = 1 };\n"
    got = problems("t.c", sample)
    print(got)
    assert len(got) == 3, got
