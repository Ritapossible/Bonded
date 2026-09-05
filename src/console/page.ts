/**
 * The console page.
 *
 * A single self-contained document: no build step, no framework, no external requests.
 * That is a deliberate constraint — this screen has to work offline, on a machine
 * being recorded, with nothing to install and nothing to go wrong on camera.
 *
 * Design priorities, in order:
 *
 * 1. **It must read on mute.** The bond state is the largest thing on screen and
 *    changes colour. Someone watching a muted video should see it flip.
 * 2. **Nothing that scrolls matters.** The bond card, the mandate and the counters are
 *    all above the fold; only the activity feed scrolls.
 * 3. **The environment is always visible.** A permanent TESTNET badge, so no viewer
 *    can mistake this for a live account.
 */

export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BONDED</title>
<style>
  :root {
    --bg: #0b0d10;
    --panel: #14181d;
    --line: #242b33;
    --text: #e7ecf2;
    --muted: #8b98a8;
    --ok: #2fbf71;
    --bad: #ff4d4f;
    --warn: #f0a020;
    --accent: #f0b90b;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; gap: 14px;
    padding: 18px 28px; border-bottom: 1px solid var(--line);
  }
  .brand { font-size: 22px; font-weight: 700; letter-spacing: .14em; }
  .badge {
    font-size: 12px; font-weight: 700; letter-spacing: .1em;
    padding: 5px 10px; border-radius: 4px;
    background: var(--accent); color: #000;
  }
  .spacer { flex: 1; }
  .meta { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }

  main { padding: 24px 28px; display: grid; gap: 20px; grid-template-columns: 1fr 1fr; align-items: start; }
  @media (max-width: 980px) { main { grid-template-columns: 1fr; } }

  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
  .panel h2 {
    margin: 0 0 14px; font-size: 12px; font-weight: 700;
    letter-spacing: .14em; text-transform: uppercase; color: var(--muted);
  }

  /* The bond card is the thing a muted viewer watches. */
  .bond { grid-column: 1 / -1; text-align: center; padding: 30px 20px; transition: all .25s ease; }
  .bond.cleared { border-color: var(--ok); box-shadow: inset 0 0 0 1px rgba(47,191,113,.25); }
  .bond.burned  { border-color: var(--bad); box-shadow: inset 0 0 0 1px rgba(255,77,79,.35); background: #1b1113; }
  .bond .state { font-size: 68px; font-weight: 800; letter-spacing: .06em; line-height: 1; }
  .bond.cleared .state { color: var(--ok); }
  .bond.burned  .state { color: var(--bad); }
  .bond .label { margin-top: 10px; font-size: 13px; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
  .bond .reason { margin-top: 14px; color: var(--bad); font-size: 15px; max-width: 900px; margin-inline: auto; }

  table { width: 100%; border-collapse: collapse; }
  td { padding: 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td.k { color: var(--muted); width: 46%; }
  td.v { font-variant-numeric: tabular-nums; }

  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
  .stat { background: #0e1216; border: 1px solid var(--line); border-radius: 8px; padding: 12px; text-align: center; }
  .stat .n { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-top: 4px; }
  .stat.alert .n { color: var(--bad); }

  .sources { display: flex; gap: 16px; font-size: 13px; color: var(--muted); }
  .cov { margin-top: 8px; font-size: 13px; }
  .cov.ok   { color: var(--ok); }
  .cov.warn { color: var(--warn); }
  .cov.bad  { color: var(--bad); }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .dot.up { background: var(--ok); } .dot.down { background: var(--bad); }

  #findings { grid-column: 1 / -1; border-color: var(--bad); }
  #findings[hidden] { display: none !important; }
  .finding { border-left: 3px solid var(--bad); padding: 10px 0 10px 14px; margin-bottom: 14px; }
  .finding:last-child { margin-bottom: 0; }
  .finding .o { font-weight: 700; color: var(--bad); letter-spacing: .08em; }
  .finding .ref { color: var(--muted); font-size: 13px; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .finding ul { margin: 8px 0 0; padding-left: 18px; color: var(--muted); font-size: 13px; }

  #feed { grid-column: 1 / -1; }
  .rows { max-height: 320px; overflow-y: auto; }
  .row { display: grid; grid-template-columns: 96px 74px 1fr; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); align-items: baseline; }
  .row:last-child { border-bottom: 0; }
  .t { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .tag { font-size: 11px; font-weight: 700; letter-spacing: .08em; padding: 3px 7px; border-radius: 4px; text-align: center; }
  .tag.allow { background: rgba(47,191,113,.14); color: var(--ok); }
  .tag.deny  { background: rgba(240,160,32,.14); color: var(--warn); }
  .tag.find  { background: rgba(255,77,79,.16); color: var(--bad); }
  .tag.info  { background: rgba(255,255,255,.08); color: var(--muted); }
  .why { color: var(--muted); font-size: 13px; margin-top: 3px; }
  .empty { color: var(--muted); padding: 14px 0; }
</style>
</head>
<body>
<header>
  <span class="brand">BONDED</span>
  <span class="badge" id="env">…</span>
  <span class="spacer"></span>
  <span class="meta">mandate <span id="hash">…</span> · <span id="sources"></span></span>
</header>

<main>
  <section class="panel bond cleared" id="bond">
    <div class="state" id="bondState">…</div>
    <div class="label">bond</div>
    <div class="reason" id="bondReason" hidden></div>
  </section>

  <section class="panel">
    <h2>Mandate</h2>
    <table id="clauses"></table>
  </section>

  <section class="panel">
    <h2>Reconciliation</h2>
    <div class="stats">
      <div class="stat"><div class="n" id="sObserved">0</div><div class="l">observed</div></div>
      <div class="stat"><div class="n" id="sAuthorised">0</div><div class="l">authorised</div></div>
      <div class="stat" id="sFindingsBox"><div class="n" id="sFindings">0</div><div class="l">findings</div></div>
    </div>
    <div class="sources" id="sourceList"></div>
    <div class="cov" id="coverage"></div>
  </section>

  <section class="panel" id="findings" hidden>
    <h2>Findings</h2>
    <div id="findingList"></div>
  </section>

  <section class="panel" id="feed">
    <h2>Activity</h2>
    <div class="rows" id="rows"><div class="empty">No activity yet.</div></div>
  </section>
</main>

<script>
(function () {
  "use strict";

  // Every value from the server is inserted as text, never as markup. The feed
  // contains exchange-supplied strings such as client order ids, and treating those
  // as HTML would be an injection path straight into the operator's screen.
  function text(el, value) { el.textContent = value == null ? "" : String(value); }

  function el(tag, cls, value) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (value !== undefined) text(node, value);
    return node;
  }

  function clockOf(iso) {
    if (!iso) return "--:--:--";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "--:--:--" : d.toISOString().slice(11, 19);
  }

  function renderBond(state) {
    var card = document.getElementById("bond");
    var burned = state.bond.state === "BURNED";
    card.className = "panel bond " + (burned ? "burned" : "cleared");
    text(document.getElementById("bondState"), state.bond.state);
    var reason = document.getElementById("bondReason");
    if (burned && state.bond.reason) {
      text(reason, state.bond.reason);
      reason.hidden = false;
    } else {
      reason.hidden = true;
    }
    document.title = burned ? "BONDED — BURNED" : "BONDED";
  }

  function renderMandate(state) {
    text(document.getElementById("env"), state.env.toUpperCase());
    text(document.getElementById("hash"), state.mandate.shortHash);
    var table = document.getElementById("clauses");
    table.replaceChildren();
    state.mandate.clauses.forEach(function (clause) {
      var row = el("tr");
      row.append(el("td", "k", clause.name), el("td", "v", clause.value));
      table.append(row);
    });
  }

  function renderReconciliation(state) {
    var r = state.reconciliation;
    text(document.getElementById("sObserved"), r.observed);
    text(document.getElementById("sAuthorised"), r.authorised);
    text(document.getElementById("sFindings"), r.findings);
    document.getElementById("sFindingsBox").className = "stat" + (r.findings > 0 ? " alert" : "");

    var list = document.getElementById("sourceList");
    list.replaceChildren();
    r.sources.forEach(function (source) {
      var wrap = el("span");
      wrap.append(el("span", "dot " + (source.healthy ? "up" : "down")));
      var scope = source.coverage === "account" ? "account-wide" : "mandate symbols";
      wrap.append(document.createTextNode(source.name + (source.healthy ? " live" : " down") + " · " + scope));
      list.append(wrap);
    });

    // Health alone hid the state that matters: with the stream down the poller still
    // reads live, while detection has narrowed to the mandate's own symbols.
    var cov = document.getElementById("coverage");
    if (r.coverage === "full") {
      text(cov, "coverage: account-wide");
      cov.className = "cov ok";
    } else if (r.coverage === "partial") {
      text(cov, "coverage: DEGRADED — mandate symbols only, orders on other symbols are not observable");
      cov.className = "cov warn";
    } else {
      text(cov, "coverage: NONE — no source is delivering");
      cov.className = "cov bad";
    }

    var summary = document.getElementById("sources");
    text(summary, "last seen " + clockOf(r.lastObservedAt));
  }

  function renderFindings(state) {
    var panel = document.getElementById("findings");
    var list = document.getElementById("findingList");
    list.replaceChildren();
    if (!state.findings.length) { panel.hidden = true; return; }
    panel.hidden = false;

    if (state.findingsOmitted > 0) {
      list.append(el("div", "omitted", state.findingsOmitted + " further findings not shown"));
    }

    state.findings.forEach(function (f) {
      var box = el("div", "finding");
      box.append(el("div", "o", f.outcome));
      box.append(el("div", null, f.explanation));
      box.append(el("div", "ref", f.symbol + " · order " + f.orderId + " · clientOrderId " + (f.clientOrderId || "(none)")));
      if (f.uncertainty && f.uncertainty.length) {
        var ul = el("ul");
        f.uncertainty.forEach(function (note) { ul.append(el("li", null, note)); });
        box.append(ul);
      }
      list.append(box);
    });
  }

  function renderActivity(state) {
    var rows = document.getElementById("rows");
    rows.replaceChildren();
    if (!state.activity.length) {
      rows.append(el("div", "empty", "No activity yet."));
      return;
    }
    state.activity.forEach(function (entry) {
      var row = el("div", "row");
      row.append(el("div", "t", clockOf(entry.at)));

      if (entry.kind === "finding") {
        row.append(el("div", "tag find", "FINDING"));
        var body = el("div");
        body.append(el("div", null, entry.summary));
        body.append(el("div", "why", entry.symbol + " · order " + entry.orderId));
        row.append(body);
      } else {
        var allow = entry.outcome === "ALLOW";
        var cancel = entry.outcome === "CANCEL";
        var tone = allow ? "allow" : cancel ? "info" : "deny";
        row.append(el("div", "tag " + tone, entry.outcome));
        var cell = el("div");
        cell.append(el("div", null, entry.summary));
        if (!allow && !cancel && entry.clause) {
          var detail = entry.clause + " — observed " + entry.observed;
          if (entry.limit) detail += ", limit " + entry.limit;
          cell.append(el("div", "why", detail));
        }
        row.append(cell);
      }
      rows.append(row);
    });
  }

  function render(state) {
    renderBond(state);
    renderMandate(state);
    renderReconciliation(state);
    renderFindings(state);
    renderActivity(state);
  }

  var source = new EventSource("/api/events");
  source.addEventListener("state", function (event) {
    try { render(JSON.parse(event.data)); } catch (_) { /* ignore a malformed frame */ }
  });
  source.addEventListener("error", function () {
    // EventSource reconnects on its own; the badge shows staleness meanwhile.
    document.getElementById("env").textContent = "RECONNECTING";
  });
})();
</script>
</body>
</html>
`;
