/* Part of eval-live -- the entry point and owner of the single state object.
   Architecture (see state.js for the data shape):

     event -> setState(reducer) -> render(state) [+ engine.tick(state)]

   There is ONE `state`. Reducers mutate it; setState() re-renders and nudges the
   Pyodide engine. render(state) reconciles a persistent DOM skeleton to the
   current state -- it builds structure once (graph section, table views, clear
   button) and is otherwise idempotent: table views toggle row visibility rather
   than rebuilding, so render is cheap to call on every keystroke. The expensive,
   async work (graphs, computed-table rows, narrowing) lives behind the engine's
   memoized effects, which write their results back via setState.

   Loaded as a plain <script>; depends on state.js, table-view.js, graph-engine.js. */

// Clarifying subtitles for known raw result tables.
const TABLE_DESCRIPTIONS = {
  warnings: "Expected, non-bug failures: timeouts and cells that use a feature "
    + "the backend/encoding does not support (push/pop, proofs-incompatible "
    + "commands). Kept out of “errors” on purpose.",
  errors: "Real, unexpected failures (likely bugs). Expected non-bug failures "
    + "live in the “warnings” table instead.",
  skipped: "Files excluded up front (not benchmarked) and why — e.g. "
    + "unsupported by the term encoding, or no bridge-normal reference.",
};

/**
 * Render evaluation tables (and, when a graph script is supplied, Pyodide graphs
 * + computed tables) into a container.
 * @param {HTMLElement|string} container
 * @param {Object} data - { tableName: rows[] }
 * @param {string} [name] - project name shown in the heading
 * @param {string} [graphScript] - Python building an eval_live.Registry
 * @param {string} [evalLivePy] - source of eval_live.py
 * @param {Object.<string,string>} [extraModules] - {filename: source} extra
 *   Python modules written to the Pyodide filesystem, importable by graphScript
 */
function initEvalLive(container, data, name, graphScript, evalLivePy, extraModules = {}) {
  return initEvalLiveApp(container, data, name, graphScript, evalLivePy, extraModules, []);
}

/**
 * Render an ordered catalog of already-computed, independently filterable
 * tables. This entry point does not create the graph engine or load Pyodide.
 *
 * Each descriptor is `{id, name, rows, section?, caption?, columns?}`. `id` is
 * the unique, stable UI-state key; duplicate displayed `name` values are
 * allowed. Optional columns are ordered `{id, name, alignment?}` descriptors.
 * Descriptor, column, and row order are preserved.
 *
 * @param {HTMLElement|string} container
 * @param {Array} tables
 * @param {string} [name] - project name shown in the heading
 */
function initEvalLiveTables(container, tables, name) {
  return initEvalLiveApp(container, {}, name, null, null, {}, normalizePrecomputedTables(tables));
}

function normalizePrecomputedTables(tables) {
  if (!Array.isArray(tables)) throw new TypeError("tables must be an array");
  const ids = new Set();
  return tables.map((table, tableIndex) => {
    if (table === null || typeof table !== "object" || Array.isArray(table)) {
      throw new TypeError(`table ${tableIndex} must be an object`);
    }
    const id = ownValue(table, "id");
    const name = ownValue(table, "name");
    const rows = ownValue(table, "rows");
    const section = ownValue(table, "section");
    const caption = ownValue(table, "caption");
    const columns = ownValue(table, "columns");
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`table ${tableIndex} id must be a non-empty string`);
    }
    if (ids.has(id)) throw new TypeError(`duplicate table id: ${id}`);
    ids.add(id);
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`table ${id} name must be a non-empty string`);
    }
    if (!Array.isArray(rows)) throw new TypeError(`table ${id} rows must be an array`);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const row = rows[rowIndex];
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new TypeError(`table ${id} row ${rowIndex} must be an object`);
      }
    }
    if (section != null && typeof section !== "string") {
      throw new TypeError(`table ${id} section must be a string`);
    }
    if (caption != null && typeof caption !== "string") {
      throw new TypeError(`table ${id} caption must be a string`);
    }
    return {
      id,
      name,
      rows,
      section: section || null,
      caption: caption || null,
      columns: normalizePrecomputedColumns(columns, id),
    };
  });
}

function normalizePrecomputedColumns(columns, tableId) {
  if (columns == null) return null;
  if (!Array.isArray(columns)) throw new TypeError(`table ${tableId} columns must be an array`);
  const ids = new Set();
  return columns.map((column, columnIndex) => {
    if (column === null || typeof column !== "object" || Array.isArray(column)) {
      throw new TypeError(`table ${tableId} column ${columnIndex} must be an object`);
    }
    const id = ownValue(column, "id");
    const name = ownValue(column, "name");
    const alignment = ownValue(column, "alignment");
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(`table ${tableId} column ${columnIndex} id must be a non-empty string`);
    }
    if (ids.has(id)) throw new TypeError(`table ${tableId} has duplicate column id: ${id}`);
    ids.add(id);
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(`table ${tableId} column ${id} name must be a non-empty string`);
    }
    if (alignment != null && !["left", "center", "right"].includes(alignment)) {
      throw new TypeError(`table ${tableId} column ${id} alignment must be left, center, or right`);
    }
    return { id, name, alignment: alignment || null };
  });
}

function initEvalLiveApp(container, data, name, graphScript, evalLivePy, extraModules, precomputedTables) {
  if (typeof container === "string") container = document.getElementById(container);
  container.classList.add("eval-live");
  container.innerHTML = "";

  const state = makeState(data, name, graphScript, evalLivePy);
  let engine = null;   // created at the end, once the DOM skeleton exists

  // --- reducer dispatch ---------------------------------------------------
  function setState(mutator) {
    const changed = mutator(state);
    if (changed === false) return;          // reducer reported a no-op
    render();
    if (engine) engine.tick(state);
  }

  const handlers = {
    onToggleCollapse: (n) => setState((s) => toggleCollapsed(s, n)),
    onSql: (n, val) => setState((s) => setSql(s, n, val)),
    onColFilter: (n, col, val) => setState((s) => setColFilter(s, n, col, val)),
    onHighlight: (n, mode) => setState((s) => setHighlight(s, n, mode)),
    onCheckbox: (n, col, checked, all) => setState((s) => toggleCheckbox(s, n, col, checked, all)),
  };

  // --- persistent DOM skeleton (built once) -------------------------------
  if (name) {
    const h1 = document.createElement("h1");
    h1.className = "eval-live-title";
    h1.textContent = name + " — Eval Live";
    container.appendChild(h1);
  }

  // Graph section (only with a graph script). render() fills bar + display.
  let graphStatusEl = null, graphBar = null, graphDisplay = null;
  let lastGraphsRef = null;
  if (graphScript && evalLivePy) {
    const graphSection = document.createElement("div");
    graphSection.className = "graph-section";
    graphStatusEl = document.createElement("div");
    graphStatusEl.className = "graph-status";
    graphSection.appendChild(graphStatusEl);
    graphBar = document.createElement("div");
    graphBar.className = "graph-bar";
    graphSection.appendChild(graphBar);
    graphDisplay = document.createElement("div");
    graphDisplay.className = "graph-display";
    graphSection.appendChild(graphDisplay);
    container.appendChild(graphSection);
  }

  const clearBtn = document.createElement("button");
  clearBtn.className = "clear-filters-btn";
  clearBtn.textContent = "Clear all filters";
  clearBtn.addEventListener("click", () => setState((s) => clearAllFilters(s)));
  container.appendChild(clearBtn);

  const computedContainer = document.createElement("div");
  computedContainer.className = "computed-container";
  container.appendChild(computedContainer);

  // Precomputed report tables are presentation-ready data. Their stable ids,
  // rather than their potentially duplicated display names, own UI state.
  const precomputedViews = [];
  if (precomputedTables.length > 0) {
    const precomputedContainer = document.createElement("div");
    precomputedContainer.className = "precomputed-container";
    let previousSection = null;
    for (const table of precomputedTables) {
      if (table.section !== previousSection) {
        previousSection = table.section;
        if (table.section) {
          const heading = document.createElement("h2");
          heading.className = "report-section-heading";
          heading.textContent = table.section;
          precomputedContainer.appendChild(heading);
        }
      }
      ensureTableUi(state, table.id, "precomputed");
      const view = buildTableView(
        table.name, table.rows, "precomputed", true, table.caption,
        handlers, table.rows, table.id, table.columns);
      precomputedViews.push(view);
      precomputedContainer.appendChild(view.section);
    }
    container.appendChild(precomputedContainer);
  }

  let rawHeader = null;
  const rawContainer = document.createElement("div");
  rawContainer.className = "raw-container";

  // Raw table views: data is fixed, so build once.
  const rawViews = [];
  for (const [tableName, rows] of Object.entries(data)) {
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const view = buildTableView(tableName, rows, "raw", true,
                                ownValue(TABLE_DESCRIPTIONS, tableName), handlers);
    rawViews.push(view);
  }
  if (rawViews.length > 0) {
    rawHeader = document.createElement("h2");
    rawHeader.className = "raw-tables-header";
    rawHeader.textContent = "Raw Tables";
    container.appendChild(rawHeader);
    container.appendChild(rawContainer);
    for (const v of rawViews) rawContainer.appendChild(v.section);
  }

  // Computed table views: rebuilt whenever the engine replaces computedTables
  // (detected by array-reference identity, which the engine bumps only on a real
  // recompute). UI state lives in state.ui, so it survives the rebuild.
  let computedViews = [];
  let lastComputedRef = null;
  let lastUnfilteredRef = null;
  function rebuildComputedViews() {
    computedContainer.innerHTML = "";
    computedViews = [];
    for (const t of state.engine.computedTables) {
      if (!t.rows || t.rows.length === 0) continue;
      ensureTableUi(state, t.name, "computed");     // persist ui across rebuilds
      // Checkbox options come from the UNFILTERED version of this table, so
      // unchecking a value doesn't make it disappear as the display narrows.
      const unfiltered = state.engine.computedUnfiltered.find((u) => u.name === t.name);
      const optionRows = unfiltered ? unfiltered.rows : t.rows;
      const view = buildTableView(t.name, t.rows, "computed", t.hasFilterSource,
                                  t.caption, handlers, optionRows);
      computedViews.push(view);
      computedContainer.appendChild(view.section);
    }
  }

  // --- graph section reconcile -------------------------------------------
  function syncGraphs() {
    if (!graphStatusEl) return;
    const eng = state.engine;
    graphStatusEl.textContent =
      eng.status === "ready" ? (eng.graphs.length ? "" : "No graphs registered.")
                             : eng.statusText || "";

    if (eng.graphs !== lastGraphsRef) {
      lastGraphsRef = eng.graphs;
      graphBar.innerHTML = "";
      for (const g of eng.graphs) {
        const btn = document.createElement("button");
        btn.className = "graph-btn";
        btn.textContent = g.name;
        btn.addEventListener("click", () => setState((s) => setActiveGraph(s, g.name)));
        graphBar.appendChild(btn);
      }
    }

    const active = resolveActiveGraph(state);
    const btns = graphBar.querySelectorAll(".graph-btn");
    btns.forEach((b) => b.classList.toggle("active", b.textContent === active));

    graphDisplay.innerHTML = "";
    const g = eng.graphs.find((x) => x.name === active);
    if (g && g.src) {
      const img = document.createElement("img");
      img.src = g.src;
      img.alt = g.name;
      graphDisplay.appendChild(img);
    }
  }

  // --- the render: reconcile everything from state ------------------------
  function render() {
    syncGraphs();
    // Rebuild computed views when the displayed rows OR the unfiltered rows
    // (which feed the dropdown options) change.
    if (state.engine.computedTables !== lastComputedRef ||
        state.engine.computedUnfiltered !== lastUnfilteredRef) {
      lastComputedRef = state.engine.computedTables;
      lastUnfilteredRef = state.engine.computedUnfiltered;
      rebuildComputedViews();
    }
    for (const v of computedViews) v.sync(state);
    for (const v of precomputedViews) v.sync(state);
    for (const v of rawViews) v.sync(state);
  }

  render();
  if (graphScript && evalLivePy) {
    engine = createEngine(graphScript, evalLivePy, setState, extraModules);
    engine.tick(state);     // kick off Pyodide load + initial graphs/tables
  }

  return { getState: () => state, setState, render };
}
