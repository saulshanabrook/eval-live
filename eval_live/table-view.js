/* Part of eval-live -- the DOM layer for one table. A "table view" builds its
   persistent DOM ONCE (heading, filter toolbar, checkbox dropdowns, rows) and
   then sync(state) reconciles that DOM to the current state: collapsed class,
   input values, checkbox checked-state, row visibility, row count. It stores NO
   UI state of its own -- it reads everything from state.ui (so collapse/filters
   survive re-renders) and writes back through the `handlers` callbacks, which
   initEvalLive wires to setState(reducer).

   sync() is idempotent: calling it repeatedly with the same state is a no-op, so
   the owner can re-sync the whole page on every change cheaply (rows are toggled,
   never rebuilt). Loaded as a plain <script>; depends on state.js + sql-filter.js.

   Row expand/collapse (+/-) is deliberately kept as transient DOM state on each
   row rather than in the central state: it is per-row and ephemeral, and raw
   rows are never rebuilt, so it persists naturally without bloating state. */

/**
 * @param {string} name        table name (key into state.ui.tables)
 * @param {Array}  rows         the table's rows (fixed for the life of the view)
 * @param {string} kind         "raw" | "computed"
 * @param {boolean} filterable  show the filter toolbar + per-column inputs
 * @param {string} [description] clarifying subtitle
 * @param {Object} handlers     { onToggleCollapse(name), onSql(name,val),
 *                                onColFilter(name,col,val), onHighlight(name,mode),
 *                                onCheckbox(name,col,checkedValues,allValues) }
 * @param {Array} [optionRows]   rows the checkbox dropdowns enumerate (the
 *                               UNFILTERED rows, so options don't vanish as the
 *                               displayed `rows` narrow). Defaults to `rows`.
 * @returns {{name, kind, rows, section, sync(state)}}
 */
function buildTableView(name, rows, kind, filterable, description, handlers, optionRows) {
  const cols = columnsOf(rows);
  optionRows = optionRows || rows;

  const section = document.createElement("div");
  section.className = "table-section";

  // --- heading (click to minimize) ---------------------------------------
  const heading = document.createElement("h2");
  heading.className = "table-heading";
  const caret = document.createElement("span");
  caret.className = "collapse-caret";
  caret.textContent = "▾";          // CSS rotates it when .collapsed
  heading.appendChild(caret);
  const titleText = document.createElement("span");
  titleText.className = "table-title";
  titleText.textContent = name;
  heading.appendChild(titleText);
  const rowCount = document.createElement("span");
  rowCount.className = "row-count";
  heading.appendChild(rowCount);
  heading.addEventListener("click", () => handlers.onToggleCollapse(name));
  section.appendChild(heading);

  if (description) {
    const desc = document.createElement("p");
    desc.className = "table-description";
    desc.textContent = description;
    section.appendChild(desc);
  }

  // --- per-table controls: which numeric cell to highlight per row -------
  const controls = document.createElement("div");
  controls.className = "table-controls";
  const hlLabel = document.createElement("label");
  hlLabel.className = "highlight-control";
  hlLabel.textContent = "Highlight # per row: ";
  const hlSelect = document.createElement("select");
  for (const [val, text] of [["lowest", "lowest"], ["highest", "highest"], ["none", "none"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = text;
    hlSelect.appendChild(opt);
  }
  hlSelect.addEventListener("change", () => handlers.onHighlight(name, hlSelect.value));
  hlLabel.appendChild(hlSelect);
  controls.appendChild(hlLabel);
  section.appendChild(controls);

  // --- filter toolbar: SQL box + per-column checkbox dropdowns ------------
  let sqlInput = null;
  const checkboxGroups = [];    // { col, values, boxes:[{value, cb}] }
  if (filterable) {
    const toolbar = document.createElement("div");
    toolbar.className = "filter-toolbar";

    const sqlWrap = document.createElement("div");
    sqlWrap.className = "sql-filter-wrap";
    sqlInput = document.createElement("input");
    sqlInput.type = "text";
    sqlInput.className = "sql-filter-input";
    sqlInput.placeholder =
      "SQL filter, e.g.  backend IN ('feldera','flowlog') AND mode = 'proofs'   (plain text = substring match)";
    sqlInput.addEventListener("input", () => handlers.onSql(name, sqlInput.value));
    sqlWrap.appendChild(sqlInput);
    const hint = document.createElement("span");
    hint.className = "sql-filter-hint";
    hint.textContent =
      "SQL WHERE clause:  = != <>  LIKE '%x%'  IN (...)  BETWEEN  AND/OR/NOT  ( )";
    hint.title =
      "Type a SQL WHERE condition over the columns (evaluated by AlaSQL). " +
      "Plain text with no SQL operator falls back to a substring match across " +
      "all columns. SQL string comparisons are case-sensitive; use LIKE for " +
      "case-insensitive matching.";
    sqlWrap.appendChild(hint);
    toolbar.appendChild(sqlWrap);

    // Checkbox dropdowns for scalar columns with < 30 distinct values. Options
    // come from optionRows (the unfiltered rows) so they stay stable as the
    // displayed rows narrow.
    const dropdowns = document.createElement("div");
    dropdowns.className = "checkbox-dropdowns";
    for (const col of cols) {
      const values = distinctScalarValues(optionRows, col);
      if (values === null) continue;         // non-scalar column; no dropdown
      if (values.length >= 30) continue;     // too many to checkbox; use typed SQL

      const details = document.createElement("details");
      details.className = "checkbox-dropdown";
      const summary = document.createElement("summary");
      summary.textContent = `${col} (${values.length})`;
      details.appendChild(summary);

      const list = document.createElement("div");
      list.className = "checkbox-list";
      const boxes = [];
      for (const value of values) {
        const label = document.createElement("label");
        label.className = "checkbox-item";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        const span = document.createElement("span");
        span.textContent = value === "" ? "(empty)" : value;
        label.appendChild(cb);
        label.appendChild(span);
        list.appendChild(label);
        const box = { value, cb };
        boxes.push(box);
        cb.addEventListener("change", () => {
          const checked = boxes.filter((b) => b.cb.checked).map((b) => b.value);
          handlers.onCheckbox(name, col, checked, values);
        });
      }
      details.appendChild(list);
      dropdowns.appendChild(details);
      checkboxGroups.push({ col, values, boxes });
    }
    if (checkboxGroups.length > 0) toolbar.appendChild(dropdowns);

    section.appendChild(toolbar);
  }

  // --- table: header, per-column filter inputs, body ----------------------
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const thExpand = document.createElement("th");
  thExpand.className = "expand-col";
  headerRow.appendChild(thExpand);
  for (const col of cols) {
    const th = document.createElement("th");
    th.textContent = col;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);

  const colInputs = {};         // col -> <input>
  if (filterable) {
    const filterRow = document.createElement("tr");
    filterRow.className = "filter-row";
    const filterExpandTh = document.createElement("th");
    filterExpandTh.className = "expand-col";
    filterRow.appendChild(filterExpandTh);
    for (const col of cols) {
      const th = document.createElement("th");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "filter-input";
      input.placeholder = "filter...";
      input.addEventListener("input", () => handlers.onColFilter(name, col, input.value));
      colInputs[col] = input;
      th.appendChild(input);
      filterRow.appendChild(th);
    }
    thead.appendChild(filterRow);
  }
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const rowEls = [];
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.classList.add("collapsed");
    const tdBtn = document.createElement("td");
    tdBtn.className = "expand-col";
    const btn = document.createElement("button");
    btn.className = "expand-btn";
    btn.textContent = "+";
    btn.addEventListener("click", () => {
      const collapsed = tr.classList.toggle("collapsed");
      btn.textContent = collapsed ? "+" : "−";
    });
    tdBtn.appendChild(btn);
    tr.appendChild(tdBtn);
    const tds = {};
    for (const col of cols) {
      const td = document.createElement("td");
      td.textContent = cellText(row[col]);
      tds[col] = td;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    rowEls.push({ tr, tds });
  }
  table.appendChild(tbody);

  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  wrap.appendChild(table);
  section.appendChild(wrap);

  // --- sync: reconcile DOM -> state (idempotent) -------------------------
  function setInputValue(input, value) {
    // Skip while the user is typing in this field (don't fight the caret); the
    // keystroke already pushed its value into state, so they are in sync.
    if (document.activeElement === input) return;
    if (input.value !== value) input.value = value;
  }

  function sync(state) {
    const ui = state.ui.tables[name] || makeTableUi(kind);

    section.classList.toggle("collapsed", !!ui.collapsed);

    if (filterable) {
      setInputValue(sqlInput, ui.sql || "");
      for (const col of cols) {
        if (colInputs[col]) setInputValue(colInputs[col], ui.colFilters[col] || "");
      }
      // Checkboxes are a view of ui.sql: check the values the SQL constrains to
      // (no recognizable clause for a column => all checked = "no constraint").
      for (const group of checkboxGroups) {
        const wanted = extractColumnValues(ui.sql || "", group.col);
        if (wanted === null) {
          for (const b of group.boxes) b.cb.checked = true;
        } else {
          const set = new Set(wanted.map((v) => v.toLowerCase()));
          for (const b of group.boxes) b.cb.checked = set.has(String(b.value).toLowerCase());
        }
      }
    }

    // Row visibility: this table's own filter, then (raw tables only) the
    // computed->raw narrowing feedback.
    const idxs = visibleRowIndices(rows, cols, ui);
    let allowed = null;
    if (kind === "raw" && state.engine.narrowing && state.engine.narrowing[name]) {
      allowed = new Set(state.engine.narrowing[name].map((r) => JSON.stringify(r)));
    }
    const shown = new Array(rows.length).fill(false);
    for (const i of idxs) {
      if (allowed && !allowed.has(JSON.stringify(rows[i]))) continue;
      shown[i] = true;
    }
    const mode = ui.highlight || "lowest";
    hlSelect.value = mode;
    let visible = 0;
    for (let i = 0; i < rowEls.length; i++) {
      const { tr, tds } = rowEls[i];
      tr.style.display = shown[i] ? "" : "none";
      if (shown[i]) visible++;
      const best = bestNumericCols(rows[i], cols, mode);
      for (const col of cols) tds[col].classList.toggle("cell-best", best.has(col));
    }
    rowCount.textContent = visible === rows.length
      ? `(${rows.length} rows)`
      : `(${visible}/${rows.length} rows)`;
  }

  return { name, kind, rows, section, sync };
}
