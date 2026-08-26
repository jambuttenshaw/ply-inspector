// Browser smoke test for the PLY Inspector UI (optional, needs Chrome or Edge).
//
//   node test/browser-smoke.mjs
//
// Why: the vm harness (test/run-tests.mjs) runs the inline script without a DOM,
// so initUI() and every render path have never executed there. This script
// drives the real page in headless Chrome/Edge over CDP (Node 24's built-in
// WebSocket — no npm deps) and asserts on the rendered DOM.
//
// It exercises BOTH origins the tool must support (PLAN §1):
//   1. http://  — served by a tiny local static server (so fixtures can be
//                 fetched in-page and the 64 KB→window-growth path is tested);
//   2. file://  — the "double-click index.html" scenario (fixtures are embedded
//                 as base64, because pages may not fetch file:// resources).
//
// It also drives the row-preview card: the standard fixture clicks "Last"
// (post-drop `act` hook) and asserts the caption/values switch to row 2,
// which is served from the last-row decode cached during loadFile.
//
// Override the browser binary with the CHROME_PATH env var if needed.
// Exit codes: 0 = all assertions passed, 1 = failure, 2 = no browser found.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "test", "fixtures");

function findChrome() {
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    return process.env.CHROME_PATH;
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    console.error("No Chrome/Edge found. Install one or set CHROME_PATH.");
    process.exit(2);
  }
  return found;
}

const CHROME = findChrome();

// ---------------- tiny static server (http origin scenarios) ----------------
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

const MIME = { ".html": "text/html", ".json": "application/json", ".ply": "application/octet-stream" };
function startStaticServer(root) {
  const srv = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const p = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
      if (!p.startsWith(root) || !fs.existsSync(p) || !fs.statSync(p).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
      res.end(fs.readFileSync(p));
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res({ srv, port: srv.address().port })));
}

// ---------------- CDP over the built-in WebSocket ----------------
async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP websocket failed to open"));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString());
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(m.error.message));
      else res(m.result);
    } else if (m.method) {
      for (const f of listeners.get(m.method) || []) f(m.params);
    }
  };
  return {
    send(method, params) {
      return new Promise((res, rej) => {
        const i = ++id;
        pending.set(i, { res, rej });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    on(method, f) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(f);
    },
    close() { ws.close(); },
  };
}

async function launchChrome(port) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ply-smoke-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  const gotPort = new Promise((res, rej) => {
    const t = setTimeout(() => { clearTimeout(t); rej(new Error(`Chrome did not report a DevTools port in 20 s\n${out}`)); }, 20000);
    // "DevTools listening on …" is printed to stderr (not stdout) — watch both.
    const feed = (d) => {
      out += d.toString();
      const m = out.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) { clearTimeout(t); res(m[1]); }
    };
    proc.stdout.on("data", feed);
    proc.stderr.on("data", feed);
    proc.on("exit", (code) => { clearTimeout(t); rej(new Error(`Chrome exited early (code ${code})\n${out}`)); });
  });
  let wsUrl;
  try { wsUrl = await gotPort; }
  catch (e) {
    try { proc.kill(); } catch { /* already gone */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked; leave it */ }
    throw e;
  }
  return { proc, wsUrl, profile };
}

async function getPageTarget(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch { /* server warming up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("no page target appeared");
}

// ---------------- page-side snippets ----------------
// Drives the app's real drop path (loadFile is closure-private, so the only
// public way in is the window "drop" listener with a DataTransfer).
function dropExpr(name, bytesB64) {
  const load = bytesB64
    ? `(async () => {
        const bin = atob(${JSON.stringify(bytesB64)});
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new File([bytes], ${JSON.stringify(name)}, { type: "application/octet-stream" });
      })()`
    : `fetch('/test/fixtures/${name}').then((r) => r.arrayBuffer()).then((b) => new File([b], ${JSON.stringify(name)}, { type: "application/octet-stream" }))`;
  return `(async () => {
    const file = await ${load};
    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const st = document.getElementById("status").textContent;
      if (st.startsWith("Inspected") || st.startsWith("Error:")) return st;
    }
    return "TIMEOUT: " + document.getElementById("status").textContent;
  })()`;
}

const DOM_SNAPSHOT = `(() => {
  const q = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));
  const t = (n) => (n ? n.textContent.trim().replace(/\\s+/g, " ") : null);
  const table0 = q("#results table.ptable");
  const kvEl = q("#results dl.kv");
  return {
    status: document.getElementById("status").textContent,
    badges: qsa("#results .badge").map(t),
    cardTitles: qsa("#results .card-head h2").map(t),
    kv: kvEl ? Array.from(kvEl.children).map((c) => t(c)) : null,
    vertexRows: table0 ? table0.querySelectorAll("tbody tr").length : -1,
    fams: qsa("#results .famrow").map(t),
    fvCount: qsa("#results .fvcell").length,
    fvFirst: q("#results .fvcell .v") ? q("#results .fvcell .v").textContent : null,
    fvLast: qsa("#results .fvcell .v").length ? t(qsa("#results .fvcell .v").slice(-1)[0]) : null,
    fvCaption: t(q("#results .fvcap")),
    hasRowJump: q("#results #lastRowBtn") !== null,
    rowInput: q("#results #rowInput") ? q("#results #rowInput").value : null,
    errMsg: t(q("#results .errorcard .msg")),
    warnText: t(q("#results .warn")),
    listRows: qsa("#results table.ptable tr").map(t).filter((x) => x.includes("list uchar int")),
    otherSummary: t(q("#results .pl")),
    famOpt: qsa("#results .famrow.optional").map(t),
    relBadges: qsa("#results .badge").map(t).filter((b) => b.startsWith("relighting:")),
    relPills: qsa("#results .relpill").length,
    relRows: qsa("#results .relrow").map(t),
    // Global regression guard (user-reported bug: bare "null" on the page):
    // no visible text node whose ENTIRE content is exactly "null"/"undefined"
    // (that is exactly what Element.append(null) renders). Regions that echo
    // file content verbatim are exempt — a file may legitimately contain
    // those words. (Template-literal leaks like "float null" are covered by
    // per-scenario targeted assertions, e.g. the weird_props summary check.)
    nullText: (() => {
      const ECHO = ".ctl .inner, .count, td.name, .fvcell .n";
      const hits = [];
      const walk = (n) => {
        if (n.nodeType === 1 && (n.tagName === "SCRIPT" || n.tagName === "STYLE")) return;
        if (n.nodeType === 3) {
          const s = n.textContent.trim();
          if ((s === "null" || s === "undefined") && !(n.parentElement && n.parentElement.closest(ECHO)))
            hits.push(s);
        } else for (const c of n.childNodes) walk(c);
      };
      walk(document.body);
      return hits;
    })(),
  };
})()`;

// Clicks the row-preview card's "Last" button, then waits (up to 8 s) for the
// caption to stop saying "Reading row N …" and resolves with the full DOM
// snapshot. Last-row loads resolve synchronously when s.lastRow is cached,
// but an uncached load goes through decodeRowAt's real file.slice() await —
// the wait loop keeps the test honest on either path.
const CLICK_LAST_ROW = `(() => {
  const btn = document.querySelector("#results #lastRowBtn");
  if (!btn) return "NO_LAST_ROW_BTN";
  btn.click();
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const cap = document.querySelector("#results .fvcap");
      const txt = cap ? cap.textContent : "";
      if (!txt.toLowerCase().includes("reading") || Date.now() - t0 > 8000) resolve(${DOM_SNAPSHOT});
      else setTimeout(tick, 25);
    };
    tick();
  });
})()`;

// ---------------- assertion bookkeeping ----------------
let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; failures.push(label); console.log(`  FAIL ${label}${detail !== undefined ? ` — got: ${JSON.stringify(detail)}` : ""}`); }
}

// ---------------- scenarios ----------------
const scenariosHttp = [
  {
    name: "3dgs_standard.ply",
    act: (evalJs) => evalJs(CLICK_LAST_ROW),
    expect: (d, a) => {
      check("standard: status reports inspected", d.status.startsWith("Inspected"), d.status);
      check("standard: green 59/59 badge with label", d.badges.some((b) => b === "3DGS — standard signature (59/59)"), d.badges);
      check("standard: size check matches actual", d.badges.some((b) => b.startsWith("size: expected") && b.includes("matches actual")), d.badges);
      check("standard: green tail badge (last row intact)", d.badges.some((b) => b === "tail: ✓ last row intact"), d.badges);
      check("standard: 59 property rows", d.vertexRows === 59, d.vertexRows);
      check("standard: vertex card title", d.cardTitles.includes("Vertex properties vertex (59)"), d.cardTitles);
      const req = d.fams.filter((f) => !f.includes("optional"));
      check("standard: 6 required family rows, all complete", req.length === 6 && req.every((f) => f.startsWith("✓ complete")), d.fams);
      check("standard: 8 checklist rows (6 required + 2 optional)", d.fams.length === 8, d.fams);
      check("standard: both optional rows absent (normal + material)", d.famOpt.length === 2 && d.famOpt[0].startsWith("– absent") && d.famOpt[0].includes("normal") && d.famOpt[1].startsWith("– absent") && d.famOpt[1].includes("material"), d.famOpt);
      check("standard: no optional summary badge (0/5 is not notable)", !d.badges.some((b) => b.startsWith("optional:")), d.badges);
      check("standard: red relighting badge (not supported 0/5)", d.relBadges.length === 1 && d.relBadges[0] === "relighting: ✗ not supported (0/5)", d.relBadges);
      check("standard: sub-panel lists both groups missing with the full prop list",
        d.relRows.length === 2 &&
        d.relRows[0].includes("✗ missing") && d.relRows[0].includes("normal") && d.relRows[0].includes("0/3") && d.relRows[0].includes("missing: nx, ny, nz") &&
        d.relRows[1].includes("✗ missing") && d.relRows[1].includes("material") && d.relRows[1].includes("0/2") && d.relRows[1].includes("missing: metallicFactor, roughnessFactor"),
        d.relRows);
      check("standard: relighting pills on the two optional checklist rows", d.relPills === 2, d.relPills);
      check("standard: row-jump controls present (input at 0)", d.hasRowJump === true && d.rowInput === "0", { hasRowJump: d.hasRowJump, rowInput: d.rowInput });
      check("standard: caption is row 0 of 3", d.fvCaption !== null && d.fvCaption.startsWith("Row 0 of 3"), d.fvCaption);
      check("standard: first row decoded (59 cells)", d.fvCount === 59, d.fvCount);
      check("standard: row 0 x = 0", d.fvFirst === "0", d.fvFirst);
      check("standard: row 0 rot_3 = 58 (last value)", d.fvLast === "58", d.fvLast);
      check("standard: no warnings card", d.warnText === null, d.warnText);
      // After clicking "Last": row 2 (value = r*100 + i), served from the
      // cached s.lastRow decoded during loadFile.
      check("standard: post-act snapshot is an object", a && typeof a === "object", a);
      if (a && typeof a === "object") {
        check("standard: post-act caption is row 2 of 3", a.fvCaption !== null && a.fvCaption.startsWith("Row 2 of 3"), a.fvCaption);
        check("standard: last row x = 200", a.fvFirst === "200", a.fvFirst);
        check("standard: last row rot_3 = 258", a.fvLast === "258", a.fvLast);
        check("standard: last row fully decoded (59 cells)", a.fvCount === 59, a.fvCount);
      }
    },
  },
  {
    name: "3dgs_missing_rest.ply",
    expect: (d) => {
      check("near: amber 25/59 badge", d.badges.some((b) => b === "3DGS near-match (25/59)"), d.badges);
      check("near: 25 property rows", d.vertexRows === 25, d.vertexRows);
      check("near: sh_rest partial with missing list", d.fams.some((f) => f.includes("SH rest") && f.includes("partial") && f.includes("missing: f_rest_11")), d.fams);
      check("near: 8 checklist rows (6 required + 2 optional)", d.fams.length === 8 && d.famOpt.length === 2, d.fams);
      check("near: both optional rows absent (normal + material)", d.famOpt[0].includes("normal") && d.famOpt[1].includes("material"), d.famOpt);
      check("near: green tail badge (both rows present)", d.badges.some((b) => b === "tail: ✓ last row intact"), d.badges);
      check("near: no standard badge", !d.badges.some((b) => b.includes("standard signature")), d.badges);
      check("near: red relighting badge (not supported 0/5)", d.relBadges.length === 1 && d.relBadges[0] === "relighting: ✗ not supported (0/5)", d.relBadges);
    },
  },
  {
    name: "3dgs_with_normals.ply",
    expect: (d) => {
      check("normals: status reports inspected", d.status.startsWith("Inspected"), d.status);
      check("normals: standard 59/59 badge (required count unchanged)", d.badges.some((b) => b === "3DGS — standard signature (59/59)"), d.badges);
      check("normals: amber optional badge (normal 3/3, material 0/2)", d.badges.some((b) => b === "optional: normal 3/3, material 0/2"), d.badges);
      check("normals: 62 property rows", d.vertexRows === 62, d.vertexRows);
      check("normals: 8 checklist rows; normal complete, material absent", d.fams.length === 8 && d.famOpt.length === 2 && d.famOpt[0].startsWith("✓ complete") && d.famOpt[0].includes("normal") && d.famOpt[1].startsWith("– absent") && d.famOpt[1].includes("material"), d.famOpt);
      check("normals: first row decoded (62 cells)", d.fvCount === 62, d.fvCount);
      check("normals: row 0 last value = 61 (rot_3)", d.fvLast === "61", d.fvLast);
      check("normals: size matches actual (248 B/row)", d.badges.some((b) => b.startsWith("size: expected") && b.includes("matches actual")), d.badges);
      check("normals: green tail badge", d.badges.some((b) => b === "tail: ✓ last row intact"), d.badges);
      check("normals: amber relighting badge (partial 3/5)", d.relBadges.length === 1 && d.relBadges[0] === "relighting: ◐ partial (3/5)", d.relBadges);
      check("normals: sub-panel — normals complete, material group is the gap",
        d.relRows.length === 2 &&
        d.relRows[0].includes("✓ complete") && d.relRows[0].includes("3/3") &&
        d.relRows[1].includes("✗ missing") && d.relRows[1].includes("0/2") && d.relRows[1].includes("missing: metallicFactor, roughnessFactor"),
        d.relRows);
    },
  },
  {
    name: "3dgs_normals_partial.ply",
    expect: (d) => {
      check("partial normals: standard badge stays", d.badges.some((b) => b === "3DGS — standard signature (59/59)"), d.badges);
      check("partial normals: amber optional badge (normal 1/3, material 0/2)", d.badges.some((b) => b === "optional: normal 1/3, material 0/2"), d.badges);
      check("partial normals: 60 property rows", d.vertexRows === 60, d.vertexRows);
      check("partial normals: normal row partial with missing list, material absent", d.famOpt.length === 2 && d.famOpt[0].includes("partial") && d.famOpt[0].includes("missing: ny, nz") && d.famOpt[1].startsWith("– absent") && d.famOpt[1].includes("material"), d.famOpt);
      check("partial normals: green tail badge", d.badges.some((b) => b === "tail: ✓ last row intact"), d.badges);
      check("partial normals: amber relighting badge (partial 1/5)", d.relBadges.length === 1 && d.relBadges[0] === "relighting: ◐ partial (1/5)", d.relBadges);
    },
  },
  {
    name: "3dgs_relightable.ply",
    expect: (d) => {
      check("relightable: standard 59/59 badge (material props don't affect it)", d.badges.some((b) => b === "3DGS — standard signature (59/59)"), d.badges);
      check("relightable: green optional badge (normal 3/3, material 2/2)", d.badges.some((b) => b === "optional: normal 3/3, material 2/2"), d.badges);
      check("relightable: green relighting badge (supported 5/5)", d.relBadges.length === 1 && d.relBadges[0] === "relighting: ✓ supported (5/5)", d.relBadges);
      check("relightable: 64 property rows", d.vertexRows === 64, d.vertexRows);
      check("relightable: sub-panel — both groups complete",
        d.relRows.length === 2 &&
        d.relRows[0].includes("✓ complete") && d.relRows[0].includes("3/3") &&
        d.relRows[1].includes("✓ complete") && d.relRows[1].includes("2/2"),
        d.relRows);
      check("relightable: two relighting pills on the optional rows", d.relPills === 2, d.relPills);
      check("relightable: first row decoded (64 cells)", d.fvCount === 64, d.fvCount);
      check("relightable: green tail badge", d.badges.some((b) => b === "tail: ✓ last row intact"), d.badges);
    },
  },
  {
    name: "ascii_relightable_mesh.ply",
    expect: (d) => {
      check("ascii relightable mesh: no 3DGS badge (no SH props)", !d.badges.some((b) => b.includes("3DGS")), d.badges);
      check("ascii relightable mesh: no relighting UI (candidates only — the core says 5/5 but the render gate hides it)",
        d.relBadges.length === 0 && d.relRows.length === 0 && d.relPills === 0,
        { relBadges: d.relBadges, relRows: d.relRows, relPills: d.relPills });
      check("ascii relightable mesh: 8 vertex property rows", d.vertexRows === 8, d.vertexRows);
    },
  },
  {
    name: "weird_props.ply",
    expect: (d) => {
      check("weird props: file still inspected", d.status.startsWith("Inspected"), d.status);
      check("weird props: warnings card shown", d.warnText !== null, d.warnText);
      check("weird props: 4 vertex property rows", d.vertexRows === 4, d.vertexRows);
      check("weird props: other-elements summary uses '?' placeholders, never 'null'", d.otherSummary !== null && d.otherSummary.includes("list ? ? ?") && !d.otherSummary.includes("null"), d.otherSummary);
      check("weird props: first row partial (2 cells before the bad list)", d.fvCount === 2, d.fvCount);
      check("weird props: gray tail n/a badge (list rows)", d.badges.some((b) => b === "tail: n/a (variable-length rows)"), d.badges);
      check("weird props: no row-jump controls", d.hasRowJump === false, d.hasRowJump);
      check("weird props: no relighting verdict (not a 3DGS candidate)", d.relBadges.length === 0 && d.relRows.length === 0 && d.relPills === 0, { relBadges: d.relBadges, relRows: d.relRows });
    },
  },
  {
    name: "bad_magic.ply",
    expect: (d) => {
      check("bad magic: error status", d.status.startsWith("Error:"), d.status);
      check("bad magic: hard-error card cites the line", d.errMsg && d.errMsg.includes("gibberish"), d.errMsg);
      check("bad magic: no other cards", d.cardTitles.length === 1 && d.cardTitles[0] === "Hard error", d.cardTitles);
    },
  },
  {
    name: "header_at_boundary.ply",
    expect: (d) => {
      check("boundary: window growth rendered the file", d.status.startsWith("Inspected"), d.status);
      check("boundary: header size shown as 64.0 KB", d.kv && d.kv.includes("64.0 KB"), d.kv);
      check("boundary: first vertex decoded as 9.5", d.fvFirst !== null && Number(d.fvFirst) === 9.5, d.fvFirst);
    },
  },
  {
    name: "truncated_body.ply",
    expect: (d) => {
      check("truncated: red truncated badge", d.badges.some((b) => b.startsWith("size: truncated")), d.badges);
      check("truncated: still renders the vertex table", d.vertexRows === 1, d.vertexRows);
      check("truncated: red tail badge (last row missing)", d.badges.some((b) => b === "tail: ✗ last row missing — body ends before it"), d.badges);
      check("truncated: row-jump controls still present", d.hasRowJump === true, d.hasRowJump);
      check("truncated: caption is row 0 of 3", d.fvCaption !== null && d.fvCaption.startsWith("Row 0 of 3"), d.fvCaption);
    },
  },
  {
    name: "tail_midrow.ply",
    expect: (d) => {
      check("midrow: status reports inspected", d.status.startsWith("Inspected"), d.status);
      check("midrow: size check flags truncation", d.badges.some((b) => b.startsWith("size: truncated")), d.badges);
      check("midrow: red partial-tail badge (2 of 4 bytes)", d.badges.some((b) => b === "tail: ✗ last row partial (2 of 4 bytes)"), d.badges);
      check("midrow: row-jump controls present", d.hasRowJump === true, d.hasRowJump);
      check("midrow: caption is row 0 of 2", d.fvCaption !== null && d.fvCaption.startsWith("Row 0 of 2"), d.fvCaption);
      check("midrow: row 0 x = 1", d.fvFirst === "1", d.fvFirst);
    },
  },
  {
    name: "ascii_mesh.ply",
    expect: (d) => {
      check("ascii: size check n/a", d.badges.some((b) => b.includes("n/a for ASCII")), d.badges);
      check("ascii: Other elements card", d.cardTitles.includes("Other elements (1)"), d.cardTitles);
      check("ascii: no 3DGS badge", !d.badges.some((b) => b.includes("3DGS")), d.badges);
      check("ascii: list property row present", d.listRows.length === 1, d.listRows);
      check("ascii: no tail badge (binary rows only)", !d.badges.some((b) => b.startsWith("tail:")), d.badges);
      check("ascii: no row preview card", d.fvCaption === null && d.hasRowJump === false, { fvCaption: d.fvCaption, hasRowJump: d.hasRowJump });
      check("ascii: no relighting verdict (render gate: not a candidate)", d.relBadges.length === 0 && d.relPills === 0, d.relBadges);
    },
  },
  {
    name: "unknown_kw.ply",
    expect: (d) => {
      check("unknown kw: warning card shown", d.warnText !== null && d.warnText.includes("line"), d.warnText);
      check("unknown kw: file still inspected", d.status.startsWith("Inspected"), d.status);
    },
  },
];

const scenariosFile = [
  { name: "3dgs_standard.ply", embed: true, expect: (d) => check("file:// standard: 59/59 badge", d.badges.some((b) => b === "3DGS — standard signature (59/59)"), d.badges) },
  { name: "3dgs_missing_rest.ply", embed: true, expect: (d) => check("file:// near: 25/59 badge", d.badges.some((b) => b === "3DGS near-match (25/59)"), d.badges) },
  { name: "3dgs_with_normals.ply", embed: true, expect: (d) => check("file:// with normals: 62 rows + optional badge (normal 3/3, material 0/2)", d.vertexRows === 62 && d.badges.some((b) => b === "optional: normal 3/3, material 0/2"), { rows: d.vertexRows, badges: d.badges }) },
  { name: "3dgs_relightable.ply", embed: true, expect: (d) => check("file:// relightable: green relighting badge (supported 5/5)", d.relBadges.length === 1 && d.relBadges[0] === "relighting: ✓ supported (5/5)", d.relBadges) },
  { name: "bad_magic.ply", embed: true, expect: (d) => check("file:// bad magic: error card", d.errMsg !== null, d.errMsg) },
];

// ---------------- main ----------------
async function main() {
  const guard = setTimeout(() => { console.error("global timeout (120 s)"); hardExit(1); }, 120000);
  const port = await freePort();
  const { srv, port: staticPort } = await startStaticServer(ROOT);
  const chrome = await launchChrome(port);
  let cdp = null;
  try {
    const page = await getPageTarget(port);
    cdp = await connectCdp(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const evalJs = async (expression) => {
      const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text;
        throw new Error(`page exception: ${d}`);
      }
      return r.result.value;
    };
    const navigate = async (url) => {
      await cdp.send("Page.navigate", { url });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const r = await evalJs("document.readyState");
        if (r === "complete") return;
        await new Promise((res) => setTimeout(res, 50));
      }
      throw new Error(`page did not finish loading (${url})`);
    };
    const dropFixture = async (name, bytesB64) => {
      const status = await evalJs(dropExpr(name, bytesB64));
      const dom = await evalJs(DOM_SNAPSHOT);
      return { status, ...dom };
    };

    // ---- origin 1: http (full fixture set) ----
    console.log(`\n[http origin] ${CHROME}`);
    await navigate(`http://127.0.0.1:${staticPort}/index.html`);
    const ready = await evalJs("document.getElementById('status').textContent + '|' + typeof window.PLYInspector");
    check("http: initial ready status + core exported", ready === "Ready — drop a .ply file anywhere on this page.|object", ready);
    for (const s of scenariosHttp) {
      console.log(`\ndrop ${s.name}`);
      const d = await dropFixture(s.name, null);
      let a = null;
      if (s.act) a = await s.act(evalJs); // optional post-drop action (row jump)
      s.expect(d, a);
      // Global regression guard: the user-reported "bare null on the page" bug.
      check(`${s.name}: no null/undefined text rendered`, d.nullText.length === 0, d.nullText);
      if (a && typeof a === "object")
        check(`${s.name}: no null/undefined text after row jump`, a.nullText.length === 0, a.nullText);
    }

    // ---- origin 2: file:// (double-click scenario) ----
    console.log(`\n[file:// origin]`);
    const fileUrl = "file:///" + ROOT.replace(/\\/g, "/") + "/index.html";
    await navigate(fileUrl);
    const ready2 = await evalJs("document.getElementById('status').textContent");
    check("file://: initial ready status", ready2 === "Ready — drop a .ply file anywhere on this page.", ready2);
    for (const s of scenariosFile) {
      console.log(`\ndrop ${s.name} (embedded bytes)`);
      const b64 = fs.readFileSync(path.join(FIX, s.name)).toString("base64");
      const d = await dropFixture(s.name, b64);
      s.expect(d);
      check(`${s.name}: no null/undefined text rendered`, d.nullText.length === 0, d.nullText);
    }
  } finally {
    clearTimeout(guard);
    if (cdp) cdp.close();
    if (chrome.proc.exitCode === null) chrome.proc.kill();
    srv.close();
    try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* Windows: still locked by Chrome */ }
  }
  hardExit(fail === 0 ? 0 : 1);

  function hardExit(code) {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log(`failed: ${failures.join(" | ")}`);
    process.exit(code);
  }
}

main().catch((e) => {
  console.error(`\nsmoke crashed: ${e.stack || e}`);
  process.exit(1);
});
