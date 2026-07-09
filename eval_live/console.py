"""Terminal rendering for Registry.render_to_console, using ``rich``.

Kept separate from ``eval_live.py`` because it is only used on the local CLI
path; the browser/Pyodide viewer never imports it.
"""
from rich import box
from rich.console import Console
from rich.table import Table
from rich.text import Text


def _cell_parts(value):
    """Split a cell value into ``(text, style)``.

    A styled cell is ``{"text": ..., "style": ...}``; any other value is a plain
    cell with no style.  The raw display value is always ``text``.  ``style`` is
    a visual spec, not a semantic name: a dict with any of ``color`` (str),
    ``bold`` (bool), ``dim`` (bool), or a plain string used as the color.
    What a style signifies is up to the caller.
    """
    if isinstance(value, dict) and "text" in value:
        return value["text"], value.get("style")
    return value, None


def _rich_style(style):
    """Convert a cell ``style`` spec to a rich style string (``""`` if none)."""
    if not style:
        return ""
    if isinstance(style, str):
        return style
    parts = []
    if style.get("color"):
        parts.append(str(style["color"]))
    if style.get("bold"):
        parts.append("bold")
    if style.get("dim"):
        parts.append("dim")
    return " ".join(parts)


def render(tables, data, console=None):
    """Render registered ``(name, fn, filter_source, caption)`` tables to a rich
    console. Columns and headers are the row keys, in first-seen order; styled
    cells are colored via their ``style`` spec. Returns the console used.
    """
    if console is None:
        console = Console()

    for name, fn, _fs, caption in tables:
        rows = fn(data)
        cols = list(dict.fromkeys(k for r in rows for k in r))

        table = Table(
            title=name,
            title_style="bold",
            caption=caption,
            caption_style="dim",
            caption_justify="left",
            header_style="bold",
            box=box.SIMPLE_HEAVY,
        )
        for col in cols:
            table.add_column(col)
        for row in rows:
            cells = []
            for col in cols:
                text, style = _cell_parts(row.get(col, ""))
                text = "" if text is None else str(text)
                cells.append(Text(text, style=_rich_style(style)))
            table.add_row(*cells)
        console.print(table)
    return console
