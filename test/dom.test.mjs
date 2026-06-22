/* End-to-end smoke test of the DOM layer with a tiny hand-rolled DOM shim (no
   jsdom / npm). It drives the real initEvalLive through the raw-tables path (no
   graph script, so no Pyodide) and asserts the state<->DOM wiring: filtering
   hides rows, the heading collapses the section, a checkbox rewrites the SQL box
   and filters rows, and "Clear all filters" resets everything.

   The shim implements only what these modules touch. Run: `node test/dom.test.mjs`. */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

// ---- minimal DOM shim -----------------------------------------------------
class El {
  constructor(tag) {
    this.tagName = (tag || "div").toUpperCase();
    this._children = [];
    this._classes = new Set();
    this._text = "";
    this._listeners = {};
    this.style = {};
    this.value = "";
    this.checked = false;
  }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(" "); }
  get classList() {
    const c = this._classes;
    return {
      add: (n) => c.add(n),
      remove: (n) => c.delete(n),
      contains: (n) => c.has(n),
      toggle: (n, force) => {
        const want = force === undefined ? !c.has(n) : !!force;
        if (want) c.add(n); else c.delete(n);
        return want;
      },
    };
  }
  set textContent(v) { this._children = []; this._text = String(v); }
  get textContent() {
    return (this._text || "") + this._children.map((c) => c.textContent).join("");
  }
  set innerHTML(v) { this._children = []; this._text = ""; }
  get innerHTML() { return ""; }
  appendChild(c) { this._children.push(c); return c; }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  dispatch(type) { for (const fn of this._listeners[type] || []) fn({ target: this }); }
  click() { this.dispatch("click"); }
  *walk() { yield this; for (const c of this._children) yield* c.walk(); }
  find(cls) { for (const n of this.walk()) if (n._classes.has(cls)) return n; return null; }
  findAll(cls) { return [...this.walk()].filter((n) => n._classes.has(cls)); }
  findTag(tag) { const t = tag.toUpperCase(); for (const n of this.walk()) if (n.tagName === t) return n; return null; }
}
const document = {
  activeElement: null,
  createElement: (t) => new El(t),
  getElementById: () => new El("div"),
};

// ---- load the browser modules into a shared context ----------------------
const dir = new URL("../eval_live/", import.meta.url);
const ctx = {
  document, console, module: { exports: {} },
  setTimeout, clearTimeout,
};
vm.createContext(ctx);
for (const f of ["sql-filter.js", "state.js", "table-view.js", "graph-engine.js", "eval-live.js"]) {
  vm.runInContext(readFileSync(new URL(f, dir), "utf8"), ctx, { filename: f });
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ok  " + name); }

const DATA = {
  errors: [
    { backend: "feldera", mode: "proofs", file: "a.egg" },
    { backend: "feldera", mode: "naive", file: "b.egg" },
    { backend: "flowlog", mode: "proofs", file: "c.egg" },
  ],
};
function fresh() {
  const root = new El("div");
  const api = ctx.initEvalLive(root, DATA, "Test");
  const section = root.find("table-section");
  return { root, api, section };
}
function visibleRowCount(section) {
  return section.findTag("tbody")._children.filter((tr) => tr.style.display !== "none").length;
}

test("builds a section per non-empty table with full row count", () => {
  const { root, section } = fresh();
  assert.equal(root.findAll("table-section").length, 1);
  assert.equal(section.find("row-count").textContent, "(3 rows)");
  assert.equal(visibleRowCount(section), 3);
});

test("typing in the SQL box filters rows and updates the count", () => {
  const { api, section } = fresh();
  const sql = section.find("sql-filter-input");
  sql.value = "flowlog";          // bare word -> substring fallback (no AlaSQL here)
  sql.dispatch("input");
  assert.equal(api.getState().ui.tables.errors.sql, "flowlog");
  assert.equal(visibleRowCount(section), 1);
  assert.equal(section.find("row-count").textContent, "(1/3 rows)");
});

test("clicking the heading toggles the collapsed class", () => {
  const { section } = fresh();
  const heading = section.find("table-heading");
  assert.equal(section.classList.contains("collapsed"), false);
  heading.click();
  assert.equal(section.classList.contains("collapsed"), true);
  heading.click();
  assert.equal(section.classList.contains("collapsed"), false);
});

test("unchecking a checkbox rewrites the SQL box (round-trips through state)", () => {
  // Wiring only: the actual row filtering for a generated `backend = '...'`
  // clause needs AlaSQL (absent here -> substring fallback), so it is exercised
  // in the browser. Here we prove checkbox -> state.sql -> input -> checkbox.
  const { api, section } = fresh();
  // cols are backend(2), mode(2), file(3); first checkbox is backend's first value.
  const box = section.findAll("checkbox-item")[0]._children[0]; // the <input>
  assert.equal(box.checked, true);
  box.checked = false;
  box.dispatch("change");
  const sql = api.getState().ui.tables.errors.sql;
  assert.match(sql, /backend (=|IN)/);
  assert.equal(section.find("sql-filter-input").value, sql);
  // a re-render re-derives the checkbox from sql: it stays unchecked.
  api.render();
  assert.equal(box.checked, false);
});

test("Clear all filters resets sql + colFilters and shows every row", () => {
  const { root, api, section } = fresh();
  const sql = section.find("sql-filter-input");
  sql.value = "feldera"; sql.dispatch("input");
  assert.equal(visibleRowCount(section), 2);
  root.find("clear-filters-btn").click();
  assert.equal(api.getState().ui.tables.errors.sql, "");
  assert.equal(visibleRowCount(section), 3);
  assert.equal(sql.value, "");
});

test("collapse state survives a re-render (render is idempotent)", () => {
  const { api, section } = fresh();
  section.find("table-heading").click();
  assert.equal(section.classList.contains("collapsed"), true);
  api.render();                 // a stray re-render must not lose UI state
  assert.equal(section.classList.contains("collapsed"), true);
});

test("the lowest number in each row gets the cell-best class", () => {
  const root = new El("div");
  ctx.initEvalLive(root, {
    times: [
      { bench: "a", naive: 5, proofs: 2 },   // proofs lowest
      { bench: "b", naive: 1, proofs: 4 },   // naive lowest
    ],
  }, "T");
  const trs = root.findTag("tbody")._children;
  const best = (tr) => tr._children.filter((td) => td._classes.has("cell-best")).map((td) => td.textContent);
  assert.equal(JSON.stringify(best(trs[0])), JSON.stringify(["2"]));
  assert.equal(JSON.stringify(best(trs[1])), JSON.stringify(["1"]));
});

test("highlight selector switches lowest -> highest -> none", () => {
  const root = new El("div");
  ctx.initEvalLive(root, {
    times: [{ bench: "a", naive: 5, proofs: 2 }, { bench: "b", naive: 1, proofs: 4 }],
  }, "T");
  const section = root.find("table-section");
  const trs = section.findTag("tbody")._children;
  const best = (tr) => tr._children.filter((td) => td._classes.has("cell-best")).map((td) => td.textContent);
  const sel = section.find("highlight-control")._children.find((c) => c.tagName === "SELECT");
  // default lowest
  assert.equal(JSON.stringify(best(trs[0])), JSON.stringify(["2"]));
  // switch to highest
  sel.value = "highest"; sel.dispatch("change");
  assert.equal(JSON.stringify(best(trs[0])), JSON.stringify(["5"]));
  assert.equal(JSON.stringify(best(trs[1])), JSON.stringify(["4"]));
  // none -> nothing highlighted
  sel.value = "none"; sel.dispatch("change");
  assert.equal(best(trs[0]).length, 0);
});

console.log(`\n${passed} tests passed`);
