# eval-live

Interactive HTML tables and Pyodide-powered graphs for evaluation results.
Renders JSON data as filterable, collapsible tables with optional in-browser
Python graphs and computed summary tables.

## Install

```bash
pip install git+https://github.com/oflatt/eval-live.git
```

Or for local development:

```bash
pip install -e /path/to/eval-live
```

## Python API

The package bundles JS, CSS, and a Pyodide helper library. Access them as strings
for embedding into a self-contained HTML page:

```python
import eval_live

eval_live.css()          # CSS stylesheet
eval_live.js()           # JavaScript library (defines initEvalLive)
eval_live.pyodide_lib()  # eval_live.py source for Pyodide runtime
```

## JavaScript API

The JS library exposes a single entry point:

```js
initEvalLive(container, data, name, graphScript, evalLivePy)
```

- **container**: DOM element or element ID
- **data**: `{ tableName: [rowObjects] }` dict
- **name**: project name shown in the heading
- **graphScript** (optional): Python script that builds an `eval_live.Registry`
- **evalLivePy** (optional): source of the `eval_live.py` library (from `eval_live.pyodide_lib()`)

## Graphs and computed tables

Define graphs and tables in a Python script using the `Registry` API:

```python
import eval_live

reg = eval_live.Registry()
reg.graph("My Graph", my_graph_fn)
reg.table("Summary", summary_fn, filter_source=summary_filter_fn)
eval_live.registry = reg
```

See `eval_live/eval_live.py` for full documentation on graphs, tables, and
filter propagation.

## Standalone page

Open `eval_live/index.html` in a browser to load a JSON file via file picker.

## Architecture

The viewer is a small state-driven app (no framework). There is one `state`
object (`state.js`); events run reducers via `setState`, which re-renders:

```
event -> setState(reducer) -> render(state)  [+ engine.tick(state)]
```

- **state.js** — the single state object plus *pure* derivations (row filtering,
  `rawFilteredData`, clause helpers) and reducers. No DOM, no async; unit-tested
  directly in node.
- **table-view.js** — `buildTableView` builds a table's DOM once, then
  `sync(state)` reconciles it (collapsed class, input values, checkbox state, row
  visibility). It stores no UI state, so collapse/filters survive re-renders.
- **graph-engine.js** — `createEngine`: the expensive Pyodide work (graphs,
  computed-table rows, computed→raw narrowing) as *memoized async effects* keyed
  on their inputs, writing results back through `setState`.
- **eval-live.js** — `initEvalLive`: owns the state, wires reducers, and
  `render(state)` reconciles the whole page (graph bar, raw + computed tables).

## Tests

Pure-JS unit + DOM-smoke tests, no npm/jsdom (they run the browser modules in a
`node:vm` context with a tiny DOM shim):

```bash
node test/state.test.mjs   # state core: filtering, reducers, SQL-clause helpers
node test/dom.test.mjs      # initEvalLive end-to-end: filter / collapse / checkbox / clear
```

The AlaSQL row-evaluation path and the Pyodide engine are exercised in the
browser, not in these tests.
