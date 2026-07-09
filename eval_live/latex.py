"""LaTeX rendering for Registry.render_to_dir (local, on-disk table dumps).

Kept separate from ``eval_live.py`` because it is only used on the local dump
path; the browser/Pyodide viewer never imports it.
"""

_ESCAPES = {
    "\\": r"\textbackslash{}",
    "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
    "_": r"\_", "{": r"\{", "}": r"\}",
    "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}


def escape(value):
    """Escape a single cell value so it renders literally in LaTeX.

    A styled cell (``{"text": ..., "style": ...}``) is unwrapped to its text;
    the style is ignored in LaTeX.
    """
    if isinstance(value, dict) and "text" in value:
        value = value["text"]
    text = "" if value is None else str(value)
    return "".join(_ESCAPES.get(ch, ch) for ch in text)


def table(rows, cols):
    """Render ``rows`` (list of dicts) as a standalone LaTeX ``tabular``.

    Uses ``\\hline`` rules so it compiles without extra packages.  ``cols`` is
    the ordered list of row keys, also used as headers; missing keys render as
    empty cells.
    """
    lines = [r"\begin{tabular}{" + "l" * len(cols) + "}", r"\hline"]
    lines.append(" & ".join(escape(c) for c in cols) + r" \\")
    lines.append(r"\hline")
    for row in rows:
        lines.append(" & ".join(escape(row.get(c, "")) for c in cols) + r" \\")
    lines.append(r"\hline")
    lines.append(r"\end{tabular}")
    return "\n".join(lines) + "\n"
