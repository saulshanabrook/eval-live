/* Part of eval-live -- the state core: ONE state object plus pure derivations,
   reducers, and SQL-clause helpers. No DOM, no async, no shared mutable globals.
   Everything here is plain JS that runs in node, so it is unit-tested directly
   (see test/state.test.mjs).

   The design: there is a single `state` object (built by makeState). The DOM
   layer (table-view.js) and the Pyodide engine (graph-engine.js) READ derived
   values from it and never keep their own copy of UI state -- which is why
   collapse/filter/active-graph survive a re-render. Reducers mutate `state` in
   place (its identity is stable; the view holds a reference); initEvalLive wraps
   each reducer in setState() to trigger a render.

   Loaded as a plain <script> (global function declarations, no ES modules):
   js() concatenates all modules into one inline tag; index.html loads them as
   separate <script src>. Depends on sql-filter.js (sqlMatchSet, clauseForColumn). */

// ---- construction ---------------------------------------------------------

function makeTableUi(kind) {
  // collapsed: minimized to just its heading. sql: the SQL filter box text
  // (also the single source of truth the checkboxes are derived from).
  // colFilters: per-column substring inputs, ANDed on top of sql.
  // highlight: which numeric cell to mark per row -- "lowest" | "highest" | "none".
  return { kind: kind, collapsed: false, sql: "", colFilters: {}, highlight: "lowest" };
}

function makeState(data, projectName, graphScript, evalLivePy) {
  const tables = {};
  for (const name of Object.keys(data)) {
    const rows = data[name];
    if (Array.isArray(rows) && rows.length > 0) tables[name] = makeTableUi("raw");
  }
  return {
    data: data,
    projectName: projectName || null,
    graphScript: graphScript || null,
    evalLivePy: evalLivePy || null,
    ui: {
      tables: tables,        // tableName -> { kind, collapsed, sql, colFilters }
      activeGraph: null,     // selected graph name (null = first available)
    },
    engine: {
      // "none" when no graph script; otherwise "loading" -> "ready" | "error".
      status: graphScript ? "loading" : "none",
      statusText: "",
      graphs: [],            // [{name, src}]
      computedTables: [],    // [{name, rows, hasFilterSource}]
      narrowing: null,       // {tableName: rows[]} from computed->raw feedback, or null
    },
  };
}

// Ensure a ui entry exists for a (possibly computed) table; returns it. Computed
// tables are not known until Pyodide runs, so their ui is created lazily.
function ensureTableUi(state, name, kind) {
  if (!state.ui.tables[name]) state.ui.tables[name] = makeTableUi(kind || "computed");
  return state.ui.tables[name];
}

// ---- pure helpers ---------------------------------------------------------

// Cell -> text, matching the historic rendering exactly (null -> "null" via
// JSON.stringify; undefined -> "").
function cellText(val) {
  if (val === undefined) return "";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function columnsOf(rows) {
  return [...new Set(rows.flatMap(Object.keys))];
}

// Indices of rows passing a table's filter ui: per-column substring inputs
// (ANDed) and then the SQL box. The SQL box is evaluated once over all rows via
// AlaSQL (sqlMatchSet); plain/invalid text falls back to a substring match
// across all columns -- identical semantics to the old applyFilters().
function visibleRowIndices(rows, cols, ui) {
  const sqlText = (ui.sql || "").trim();
  const sqlSet = sqlText ? sqlMatchSet(sqlText, rows) : null;
  const sqlSubstr = (sqlText && !sqlSet) ? sqlText.toLowerCase() : null;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let show = true;
    for (const col of cols) {
      const q = (ui.colFilters[col] || "").toLowerCase();
      if (!q) continue;
      if (!cellText(row[col]).toLowerCase().includes(q)) { show = false; break; }
    }
    if (show && sqlSet) {
      if (!sqlSet.has(i)) show = false;
    } else if (show && sqlSubstr) {
      const joined = cols.map((c) => cellText(row[c])).join(" ").toLowerCase();
      if (!joined.includes(sqlSubstr)) show = false;
    }
    if (show) out.push(i);
  }
  return out;
}

function visibleRows(rows, ui) {
  return visibleRowIndices(rows, columnsOf(rows), ui).map((i) => rows[i]);
}

// Raw data after applying each raw table's own filter ui. This is the engine
// input that drives graphs + computed tables. It deliberately IGNORES
// engine.narrowing (the computed->raw feedback) so there is no recompute cycle:
// raw filters feed computed tables, computed filters feed raw display, and the
// two never chase each other.
function rawFilteredData(state) {
  const out = {};
  for (const name of Object.keys(state.data)) {
    const rows = state.data[name];
    const ui = state.ui.tables[name];
    if (!Array.isArray(rows) || !rows.length || !ui || ui.kind !== "raw") continue;
    out[name] = visibleRows(rows, ui);
  }
  return out;
}

// rawFilteredData further narrowed by the computed->raw feedback
// (engine.narrowing). This drives the GRAPHS, so they reflect computed-table
// filters as well as raw ones. It is deliberately NOT used for computed-table
// rows: feeding the narrowing back into run_tables would make a computed table's
// own filter change its own input (a recompute cycle). Graph images feed back
// into nothing, so narrowing them is safe.
function effectiveRawData(state) {
  const fd = rawFilteredData(state);
  const narrowing = state.engine.narrowing;
  if (!narrowing) return fd;
  const out = {};
  for (const name of Object.keys(fd)) {
    const allowedRows = narrowing[name];
    if (allowedRows) {
      const allowed = new Set(allowedRows.map((r) => JSON.stringify(r)));
      out[name] = fd[name].filter((r) => allowed.has(JSON.stringify(r)));
    } else {
      out[name] = fd[name];
    }
  }
  return out;
}

// {name, filtered_rows} for every computed table with a filter_source -- the
// input to apply_table_filters (the computed->raw narrowing).
function computedFilterInputs(state) {
  const out = [];
  for (const t of state.engine.computedTables) {
    if (!t.hasFilterSource) continue;
    const ui = state.ui.tables[t.name];
    out.push({ name: t.name, filtered_rows: ui ? visibleRows(t.rows, ui) : t.rows });
  }
  return out;
}

// Stable key for memoizing async engine work (so Pyodide only re-runs when its
// inputs actually change).
function stableKey(value) {
  return JSON.stringify(value);
}

// A cell counts as numeric if it is a finite number or a string that parses as
// one (results.json often carries numbers as strings).
function isNumericValue(v) {
  if (typeof v === "number") return isFinite(v);
  if (typeof v === "string" && v.trim() !== "") return isFinite(Number(v));
  return false;
}

// The columns whose value is the best number in `row` for the given `mode`
// ("lowest" default | "highest" | "none"). Used to highlight the best value per
// row. Only highlights when the row has >= 2 numeric cells, so a lone number
// isn't pointlessly marked. Ties all highlight. Returns a Set of column names.
function bestNumericCols(row, cols, mode) {
  if (mode === "none") return new Set();
  const highest = mode === "highest";
  const nums = [];
  for (const col of cols) if (isNumericValue(row[col])) nums.push({ col, n: Number(row[col]) });
  if (nums.length < 2) return new Set();
  let best = highest ? -Infinity : Infinity;
  for (const x of nums) best = highest ? Math.max(best, x.n) : Math.min(best, x.n);
  return new Set(nums.filter((x) => x.n === best).map((x) => x.col));
}

// ---- SQL-clause <-> checkbox helpers (pure string ops) --------------------
// Checkboxes are a VIEW of ui.sql. extractColumnValues reads which values a
// column is constrained to (for rendering checked state); setColumnClause
// rewrites ui.sql when a checkbox toggles. State for "which clause did this
// column generate" is derived from the SQL text itself -- nothing extra stored.

// Recognize `col = 'v'` or `col IN ('a','b',...)`; returns the value list, or
// null if there is no such clause for `col`.
function extractColumnValues(text, col) {
  const c = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inRe = new RegExp(`\\b${c}\\s+IN\\s*\\(([^)]*)\\)`, "i");
  const eqRe = new RegExp(`\\b${c}\\s*=\\s*'((?:[^']|'')*)'`, "i");
  let m = inRe.exec(text);
  if (m) {
    const vals = [];
    const re = /'((?:[^']|'')*)'/g;
    let mm;
    while ((mm = re.exec(m[1])) !== null) vals.push(mm[1].replace(/''/g, "'"));
    return vals;
  }
  m = eqRe.exec(text);
  if (m) return [m[1].replace(/''/g, "'")];
  return null;
}

// Tidy doubled / dangling AND glue left by removing a clause.
function tidyAnds(text) {
  return text
    .replace(/^\s*AND\s+/i, "")
    .replace(/\s+AND\s*$/i, "")
    .replace(/\s+AND(\s+AND)+\s+/gi, " AND ")
    .replace(/\s+/g, " ")
    .trim();
}

// Remove any recognizable `col = ...` / `col IN (...)` clause for `col` from
// `sql`, healing one adjacent AND so no dangling glue remains.
function removeColumnClause(sql, col) {
  const c = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const inRe = new RegExp(`(\\s*AND\\s+)?\\b${c}\\s+IN\\s*\\([^)]*\\)(\\s+AND\\s*)?`, "i");
  const eqRe = new RegExp(`(\\s*AND\\s+)?\\b${c}\\s*=\\s*'(?:[^']|'')*'(\\s+AND\\s*)?`, "i");
  let text = sql;
  for (const re of [inRe, eqRe]) {
    text = text.replace(re, (full, before, after) => (before && after ? " AND " : ""));
  }
  return tidyAnds(text);
}

// Replace the clause for `col` in `sql` with `newClause` ("" removes it),
// ANDing a non-empty clause onto whatever else the user typed.
function setColumnClause(sql, col, newClause) {
  const removed = removeColumnClause(sql, col);
  if (!newClause) return removed;
  return removed ? removed + " AND " + newClause : newClause;
}

// The SQL clause a set of checked values implies for a column, given the full
// set of distinct values. All checked (or count match) => "" (no constraint).
function columnClauseFor(col, checkedValues, allValues) {
  if (checkedValues.length === allValues.length) return "";
  return clauseForColumn(col, checkedValues); // "" when none checked, from sql-filter.js
}

// ---- reducers (mutate state in place; return true if something changed) ----

function toggleCollapsed(state, name) {
  const ui = ensureTableUi(state, name);
  ui.collapsed = !ui.collapsed;
  return true;
}

function setSql(state, name, sql) {
  const ui = ensureTableUi(state, name);
  if (ui.sql === sql) return false;
  ui.sql = sql;
  return true;
}

function setColFilter(state, name, col, value) {
  const ui = ensureTableUi(state, name);
  const cur = ui.colFilters[col] || "";
  if (cur === (value || "")) return false;
  if (value) ui.colFilters[col] = value; else delete ui.colFilters[col];
  return true;
}

function setActiveGraph(state, name) {
  if (state.ui.activeGraph === name) return false;
  state.ui.activeGraph = name;
  return true;
}

function setHighlight(state, name, mode) {
  const ui = ensureTableUi(state, name);
  if (ui.highlight === mode) return false;
  ui.highlight = mode;
  return true;
}

function clearAllFilters(state) {
  let changed = false;
  for (const name of Object.keys(state.ui.tables)) {
    const ui = state.ui.tables[name];
    if (ui.sql) { ui.sql = ""; changed = true; }
    if (Object.keys(ui.colFilters).length) { ui.colFilters = {}; changed = true; }
  }
  return changed;
}

// Export for node tests only; harmless in the browser (no module global there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    makeState, makeTableUi, ensureTableUi, cellText, columnsOf,
    visibleRowIndices, visibleRows, rawFilteredData, effectiveRawData,
    computedFilterInputs, stableKey, isNumericValue, bestNumericCols,
    extractColumnValues, removeColumnClause, setColumnClause, columnClauseFor, tidyAnds,
    toggleCollapsed, setSql, setColFilter, setActiveGraph, setHighlight, clearAllFilters,
  };
}
