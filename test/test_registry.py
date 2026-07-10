"""Registry checks: run_tables shape, styled cells, LaTeX, and the optional
console/dir renderers when their extras (rich / matplotlib) exist.

Run from the repo root: ``python test/test_registry.py``.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import eval_live
from eval_live import latex

_passed = 0


def check(name, cond):
    global _passed
    assert cond, "FAILED: " + name
    _passed += 1
    print("  ok  " + name)


def ratios(_data):
    return [
        {"file": "a.egg", "off": "1.000x", "result": {"text": "faster", "style": {"color": "green"}}},
        {"file": "b.egg", "off": "2.000x", "result": {"text": "slower", "style": {"color": "red", "bold": True}}},
    ]


reg = eval_live.Registry()
reg.table("Ratios", ratios, caption="Ratio is target / baseline.")
reg.table("Empty", lambda _d: [])  # self-suppresses (no rows)
data = {}

rt = reg.run_tables(data)
check("run_tables one entry per registered table", len(rt) == 2)
check("run_tables carries caption", rt[0]["caption"] == "Ratio is target / baseline.")
check("run_tables has_filter_source False", rt[0]["has_filter_source"] is False)
check("run_tables has no columns key", "columns" not in rt[0])

# columns/headers are just the row keys, in first-seen order
cols = list(dict.fromkeys(k for r in rt[0]["rows"] for k in r))
tex = latex.table(rt[0]["rows"], cols)
check("latex header from keys", "file & off & result" in tex)
check("latex unwraps styled cells", "faster" in tex and "'text'" not in tex)

try:
    import rich  # noqa: F401

    reg.render_to_console(data)  # renders non-empty tables, skips "Empty"
    reg.render_to_console(data, tables=["Ratios"])  # explicit selection
    try:
        reg.render_to_console(data, tables=["Nope"])
        raise AssertionError("expected ValueError for unknown table")
    except ValueError:
        pass
    check("render_to_console runs + selects + rejects unknown names", True)
except ImportError:
    print("  skip render_to_console (rich not installed)")

try:
    import matplotlib  # noqa: F401

    with tempfile.TemporaryDirectory() as d:
        written = reg.render_to_dir(data, d)
        names = sorted(os.path.basename(p) for p in written)
        # "Empty" self-suppresses -> only the Ratios files are written.
        check("render_to_dir writes non-empty tables only", names == ["ratios.json", "ratios.tex"])
except ImportError:
    print("  skip render_to_dir (matplotlib not installed)")

print(f"\n{_passed} checks passed")
