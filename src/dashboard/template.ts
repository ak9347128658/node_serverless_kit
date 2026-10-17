/**
 * The dashboard page. Kept as a TypeScript string so it is bundled into the CLI
 * (no asset files to locate at runtime). It is fully self-contained: no
 * external scripts, fonts or network calls, so it works from `file://`.
 *
 * Placeholders: `{{TITLE}}` (HTML-escaped by the generator) and `{{DATA}}`
 * (JSON with `<`, `>`, `&` escaped, safe inside a `<script>` element). All
 * record values are inserted with `textContent` / `setAttribute`, never as HTML.
 */

export const DASHBOARD_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{{TITLE}}</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #5d6677; --line: #e3e6ec;
    --accent: #3b5bdb; --accent-soft: #e7ecff; --ok: #2b8a3e; --ok-soft: #e6f4ea;
    --warn: #b35c00; --warn-soft: #fff1e0; --off: #6c757d; --off-soft: #f1f3f5;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #12151c; --panel: #1a1f29; --text: #e6e9ef; --muted: #98a2b3; --line: #2a3140;
      --accent: #8ea6ff; --accent-soft: #232c4a; --ok: #69db7c; --ok-soft: #1d3324;
      --warn: #ffb057; --warn-soft: #3a2a17; --off: #adb5bd; --off-soft: #262b35;
    }
  }
  :root[data-theme="dark"] {
    --bg: #12151c; --panel: #1a1f29; --text: #e6e9ef; --muted: #98a2b3; --line: #2a3140;
    --accent: #8ea6ff; --accent-soft: #232c4a; --ok: #69db7c; --ok-soft: #1d3324;
    --warn: #ffb057; --warn-soft: #3a2a17; --off: #adb5bd; --off-soft: #262b35;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { padding: 20px 16px 8px; max-width: 1280px; margin: 0 auto; }
  h1 { margin: 0; font-size: 22px; overflow-wrap: anywhere; }
  .sub { color: var(--muted); font-size: 13px; }
  main { max-width: 1280px; margin: 0 auto; padding: 8px 16px 48px; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 16px; }
  .toolbar input, .toolbar select, .toolbar button {
    font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 10px; }
  .toolbar input { flex: 1 1 240px; min-width: 0; }
  .toolbar button { cursor: pointer; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card b { display: block; font-size: 22px; }
  .card span { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  section.dep { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; margin-bottom: 18px; overflow: hidden; }
  .dep-head { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
  .dep-head h2 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: 12px; display: flex; flex-wrap: wrap; gap: 4px 14px; width: 100%; }
  .meta code { font-family: var(--mono); }
  .badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
           background: var(--accent-soft); color: var(--accent); white-space: nowrap; }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.warn { background: var(--warn-soft); color: var(--warn); }
  .badge.off { background: var(--off-soft); color: var(--off); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
  tbody tr:last-child td { border-bottom: none; }
  td.name b { display: block; overflow-wrap: anywhere; }
  td.rt .mono { white-space: nowrap; }
  td.name small, .mono { font-family: var(--mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .chip { display: inline-block; font-family: var(--mono); font-size: 12px; padding: 1px 7px; margin: 0 4px 4px 0;
          border: 1px solid var(--line); border-radius: 6px; white-space: nowrap; }
  .chip.http { border-color: var(--accent); color: var(--accent); }
  a { color: var(--accent); text-decoration: none; word-break: break-all; }
  a:hover { text-decoration: underline; }
  button.copy { font: inherit; font-size: 11px; color: var(--muted); background: none; border: 1px solid var(--line);
                border-radius: 6px; padding: 0 6px; margin-left: 4px; cursor: pointer; }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  .sect-title { padding: 10px 16px 0; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; }
  .empty { padding: 40px 16px; text-align: center; color: var(--muted); }
  .flow { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
  @media (max-width: 720px) {
    thead { display: none; }
    tr { display: block; border-bottom: 1px solid var(--line); padding: 6px 0; }
    td { display: block; border: none; padding: 4px 16px; }
    td[data-label]::before { content: attr(data-label) ": "; color: var(--muted); font-size: 11px; text-transform: uppercase; }
  }
</style>
</head>
<body>
<header>
  <h1 id="title">{{TITLE}}</h1>
  <div class="sub" id="generated"></div>
</header>
<main>
  <div class="cards" id="cards"></div>
  <div class="toolbar">
    <input id="q" type="search" placeholder="Filter by function, trigger, URL, handler, id..." aria-label="Filter">
    <select id="provider" aria-label="Provider"><option value="">All providers</option></select>
    <select id="stage" aria-label="Stage"><option value="">All stages</option></select>
    <button id="theme" type="button" title="Toggle light / dark theme">Theme</button>
  </div>
  <div id="deployments"></div>
</main>
<script type="application/json" id="nskit-data">{{DATA}}</script>
<script>
(function () {
  "use strict";
  var DATA = JSON.parse(document.getElementById("nskit-data").textContent || "{}");
  var deps = DATA.deployments || [];

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined) return;
      if (k === "text") el.textContent = String(v);
      else if (k === "class") el.className = v;
      else el.setAttribute(k, String(v));
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(el, x); }); return; }
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  function str(v) { return v === null || v === undefined ? "" : String(v); }
  function safeUrl(u) { return /^https?:\\/\\//i.test(str(u)) ? str(u) : null; }
  function link(u, label) {
    var s = safeUrl(u);
    return s ? h("a", { href: s, target: "_blank", rel: "noopener noreferrer", text: label || s }) : h("span", { class: "mono", text: str(u) || "-" });
  }
  function copyBtn(value) {
    var b = h("button", { class: "copy", type: "button", title: "Copy", text: "copy" });
    b.addEventListener("click", function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(value).then(function () {
        b.textContent = "copied";
        setTimeout(function () { b.textContent = "copy"; }, 1200);
      });
    });
    return b;
  }
  function statusBadge(s) {
    var cls = s === "deployed" ? "ok" : s === "removed" ? "off" : "warn";
    return h("span", { class: "badge " + cls, text: s || "unknown" });
  }
  function kindBadge(k) { return h("span", { class: "badge" + (k === "invoke-only" ? " off" : ""), text: k || "-" }); }
  function when(v) {
    if (!v) return "-";
    var d = new Date(v);
    return isNaN(d.getTime()) ? str(v) : d.toLocaleString();
  }

  document.getElementById("generated").textContent =
    "Generated " + when(DATA.generatedAt) + " by node_serverless_kit " + str(DATA.nskitVersion);

  var providers = {}, stages = {};
  deps.forEach(function (d) { providers[str(d.provider)] = str(d.providerDisplay || d.provider); stages[str(d.stage)] = 1; });
  var pSel = document.getElementById("provider"), sSel = document.getElementById("stage");
  Object.keys(providers).sort().forEach(function (p) { pSel.appendChild(h("option", { value: p, text: providers[p] })); });
  Object.keys(stages).sort().forEach(function (s) { sSel.appendChild(h("option", { value: s, text: s })); });

  function cards(list) {
    var fns = 0, http = 0, wfs = 0, prov = {};
    list.forEach(function (d) {
      prov[d.provider] = 1;
      wfs += (d.workflows || []).length;
      (d.functions || []).forEach(function (f) {
        fns++;
        if ((f.events || []).some(function (e) { return e.type === "http"; })) http++;
      });
    });
    var el = document.getElementById("cards");
    el.textContent = "";
    [["Deployments", list.length], ["Functions", fns], ["HTTP functions", http], ["Workflows", wfs], ["Providers", Object.keys(prov).length]]
      .forEach(function (c) { el.appendChild(h("div", { class: "card" }, h("b", { text: String(c[1]) }), h("span", { text: c[0] }))); });
  }

  function fnMatches(f, q) {
    if (!q) return true;
    var hay = [f.name, f.resourceName, f.handler, f.kind, f.runtime, f.url, f.id, f.arn, f.description]
      .concat((f.events || []).map(function (e) { return e.summary; }))
      .concat((f.urls || []).map(function (u) { return u.url; }))
      .concat(f.environmentKeys || []).map(str).join(" ").toLowerCase();
    return hay.indexOf(q) !== -1;
  }
  function wfMatches(w, q) {
    if (!q) return true;
    return [w.name, w.description, w.engine, w.id].concat(Object.keys(w.states || {})).concat(w.functions || [])
      .map(str).join(" ").toLowerCase().indexOf(q) !== -1;
  }

  function functionRow(f) {
    var endpoints = [];
    (f.urls || []).forEach(function (u) { endpoints.push(h("div", null, h("span", { class: "chip http", text: u.method }), link(u.url))); });
    if (!endpoints.length && f.url) endpoints.push(h("div", null, link(f.url)));
    var ident = f.arn || f.id;
    var env = f.environmentKeys || [];
    return h("tr", null,
      h("td", { class: "name", "data-label": "Function" },
        h("b", { text: f.name }), h("small", { text: f.resourceName || "" }),
        f.generated ? h("span", { class: "badge off", text: "generated" }) : null),
      h("td", { "data-label": "Type" }, kindBadge(f.kind)),
      h("td", { "data-label": "Triggers" }, (f.events || []).length
        ? f.events.map(function (e) { return h("span", { class: "chip" + (e.type === "http" ? " http" : ""), title: e.type, text: e.summary }); })
        : h("span", { class: "mono", text: "direct invoke" })),
      h("td", { "data-label": "Runtime", class: "rt" },
        h("div", { class: "mono", text: str(f.runtime) + (f.architecture ? " / " + f.architecture : "") }),
        h("div", { class: "mono", text: str(f.memory) + " MB / " + str(f.timeout) + " s" })),
      h("td", { "data-label": "Endpoint" }, endpoints.length ? endpoints : h("span", { class: "mono", text: "-" })),
      h("td", { "data-label": "Resource" },
        ident ? h("div", null, h("span", { class: "mono", text: ident }), copyBtn(str(ident))) : h("span", { class: "mono", text: "not deployed" }),
        f.console ? h("div", null, link(f.console, "Open in console")) : null,
        h("details", null, h("summary", { text: "details" }),
          h("div", { class: "mono", text: "handler: " + str(f.handler) }),
          f.description ? h("div", { class: "mono", text: f.description }) : null,
          h("div", { class: "mono", text: "env: " + (env.length ? env.join(", ") : "-") })))
    );
  }

  function workflowTable(d, q) {
    var list = (d.workflows || []).filter(function (w) { return wfMatches(w, q); });
    if (!list.length) return null;
    var rows = list.map(function (w) {
      var states = Object.keys(w.states || {}).map(function (s) { return s + (w.states[s] ? " (" + w.states[s] + ")" : ""); });
      var flow = (w.startAt ? "start: " + w.startAt + "  |  " : "") + states.join(" -> ");
      return h("tr", null,
        h("td", { class: "name", "data-label": "Workflow" }, h("b", { text: w.name }), h("small", { text: w.description || "" })),
        h("td", { "data-label": "Engine" }, h("span", { class: "badge" + (w.engine === "native" ? " ok" : " warn"), text: w.engine || "-" })),
        h("td", { "data-label": "States", class: "flow" }, flow),
        h("td", { "data-label": "Functions" }, (w.functions || []).map(function (f) { return h("span", { class: "chip", text: f }); })),
        h("td", { "data-label": "Resource" },
          w.id ? h("div", null, h("span", { class: "mono", text: w.id }), copyBtn(str(w.id))) : h("span", { class: "mono", text: "-" }),
          w.url ? h("div", null, link(w.url)) : null,
          w.console ? h("div", null, link(w.console, "Open in console")) : null));
    });
    return [h("div", { class: "sect-title", text: "Workflows (" + list.length + ")" }),
      h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, ["Workflow", "Engine", "States", "Functions", "Resource"].map(function (t) { return h("th", { text: t }); }))),
        h("tbody", null, rows)))];
  }

  function render() {
    var q = document.getElementById("q").value.trim().toLowerCase();
    var p = pSel.value, s = sSel.value;
    var list = deps.filter(function (d) { return (!p || d.provider === p) && (!s || d.stage === s); });
    cards(list);
    var root = document.getElementById("deployments");
    root.textContent = "";
    if (!list.length) {
      root.appendChild(h("div", { class: "empty" }, "No deployments found. Run ", h("code", { text: "nskit deploy" }),
        " and then ", h("code", { text: "nskit dashboard" }), "."));
      return;
    }
    var shown = 0;
    list.forEach(function (d) {
      var fns = (d.functions || []).filter(function (f) { return fnMatches(f, q); });
      var wf = workflowTable(d, q);
      if (q && !fns.length && !wf) return;
      shown++;
      var art = d.artifact || {};
      root.appendChild(h("section", { class: "dep" },
        h("div", { class: "dep-head" },
          h("h2", { text: str(d.service) + " / " + str(d.stage) }),
          h("span", { class: "badge", text: d.providerDisplay || d.provider }),
          d.providerTier && d.providerTier !== "stable" ? h("span", { class: "badge warn", text: d.providerTier }) : null,
          statusBadge(d.status),
          h("div", { class: "meta" },
            h("span", null, "region ", h("code", { text: d.region || "-" })),
            h("span", null, "updated ", h("code", { text: when(d.deployedAt) })),
            typeof art.sha256 === "string" ? h("span", null, "artifact ", h("code", { text: art.sha256.slice(0, 12) })) : null,
            d.endpoint ? h("span", null, "endpoint ", link(d.endpoint)) : null,
            h("span", null, "nskit ", h("code", { text: d.nskitVersion || "?" })))),
        h("div", { class: "sect-title", text: "Functions (" + fns.length + ")" }),
        fns.length ? h("div", { class: "table-wrap" }, h("table", null,
          h("thead", null, h("tr", null, ["Function", "Type", "Triggers", "Runtime", "Endpoint", "Resource"].map(function (t) { return h("th", { text: t }); }))),
          h("tbody", null, fns.map(functionRow)))) : h("div", { class: "empty", text: "No matching functions." }),
        wf));
    });
    if (!shown) root.appendChild(h("div", { class: "empty", text: "Nothing matches the filter." }));
  }

  ["q", "provider", "stage"].forEach(function (id) { document.getElementById(id).addEventListener("input", render); });
  var rootEl = document.documentElement;
  try { var saved = localStorage.getItem("nskit-theme"); if (saved) rootEl.setAttribute("data-theme", saved); } catch (e) { /* storage blocked */ }
  document.getElementById("theme").addEventListener("click", function () {
    var current = rootEl.getAttribute("data-theme");
    var dark = current ? current === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    var next = dark ? "light" : "dark";
    rootEl.setAttribute("data-theme", next);
    try { localStorage.setItem("nskit-theme", next); } catch (e) { /* storage blocked */ }
  });
  render();
})();
</script>
</body>
</html>
`;
