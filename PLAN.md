# PLY Inspector — Implementation Plan

**Tool:** single-file web app (`index.html`) that inspects PLY files and displays their
header contents in a GUI — built around the needs of 3D Gaussian Splatting (3DGS) workflows.
**Status:** draft for review
**Target environment:** modern evergreen browser (Chrome/Edge/Firefox, 2023+), opened via
`file://` or any static host. No server, no network, no build step, no dependencies.

---

## 1. Goal and success criteria

Inspect the *contents* of a PLY file at a glance. The star feature: a complete table of
vertex properties with **names and types**, plus every other piece of critical header
information.

Done when, for a real ~200 MB 3DGS `output.ply`:

1. Drag-and-drop (or file picker) opens it and the full inspection renders **< 1 s**.
2. The vertex property table lists all 59 properties with names, PLY types (and normalized
   types, e.g. `float` → `float32`), byte widths, and byte offsets within the row.
3. A badge recognizes the standard 3DGS signature and verifies family completeness
   (SH rest 45/45, rotation 4/4, scale 3/3, …).
4. File summary shows format, element/vertex counts, header size, bytes/vertex, and a
   **expected-total-size vs actual-size** check that flags truncated/corrupt files.
5. Other elements (faces, edges, …) and comments/`obj_info` are displayed; raw header is
   one click away; results export as CSV/JSON.
6. The whole tool is one HTML file that works offline by double-click — no install.

## 2. Product decisions (confirmed)

| Decision | Choice |
|---|---|
| Form factor | Single-file web app (HTML/CSS/JS, everything inline) |
| Scope | Everything in the header: vertex properties front and center, plus other elements, counts, size, format, comments |
| Dependencies | None (no frameworks, no CDNs, no fonts, no network calls) |
| Build step | None — the HTML file is the deliverable |

## 3. PLY format background (what the parser must handle)

### 3.1 Header structure

```
ply
format binary_little_endian 1.0
comment Software: 3DGS
obj_info whatever
element vertex 1000000
property float x
property float y
property float z
property float f_dc_0
… (59 vertex properties)
element face 302271
property list uchar int vertex_indices
end_header
<binary or ASCII body — never read by the inspector>
```

- `format` is one of `ascii 1.0`, `binary_little_endian 1.0`, `binary_big_endian 1.0`
  (only version `1.0` exists).
- `element <name> <count>` opens a block; the following `property` lines belong to it.
- `comment <text>` and `obj_info <text>` are free text (often the producing tool's name —
  display them).
- `end_header` terminates the header; the body starts on the next byte.

### 3.2 Property types

Canonical spec tokens plus the de-facto numeric aliases (accept both, show normalized form):

| PLY token(s) | Normalized | Bytes | Signedness |
|---|---|---|---|
| `char`, `int8` | int8 | 1 | signed |
| `uchar`, `uint8` | uint8 | 1 | unsigned |
| `short`, `int16` | int16 | 2 | signed |
| `ushort`, `uint16` | uint16 | 2 | unsigned |
| `int`, `int32` | int32 | 4 | signed |
| `uint`, `uint32` | uint32 | 4 | unsigned |
| `float`, `float32` | float32 | 4 | — |
| `double`, `float64` | float64 | 8 | — |

**List properties:** `property list <count_type> <item_type> <name>` (e.g. face
`vertex_indices`). Rows are variable-length: `<count_type>` byte count prefix, then that
many `<item_type>` values. These defeat exact body-size computation (reported as
"variable-length" rather than a hard mismatch).

### 3.3 The standard 3DGS signature

Reference-implementation `output.ply` vertex element:

| Family | Properties | Count | Type |
|---|---|---|---|
| Position | `x`, `y`, `z` | 3 | float |
| SH degree 0 (base color) | `f_dc_0…f_dc_2` | 3 | float |
| SH degree 1–3 (view-dependent) | `f_rest_0…f_rest_44` | 45 | float |
| Opacity | `opacity` | 1 | float |
| Scale (log-space) | `scale_0…scale_2` | 3 | float |
| Rotation (quaternion) | `rot_0…rot_3` | 4 | float |

**Total: 59 properties × 4 bytes = 236 bytes/vertex** (1 M Gaussians ≈ 236 MB).
The tool treats this as a *recognition hint*, not a hard requirement: files that match get
a green "3DGS — standard signature" badge and family-grouped rows; near-matches get a
per-family checklist (present / missing); anything else (meshes, plain point clouds,
2DGS/Mip-Splatting/quantized variants) still renders fully in the generic tables.

**Optional properties (addendum).** Signature families may be marked `optional` in the
signature table. They are part of the signature but never required: they do not change
the standard/near badge or the matched/total count (which stays required-only, 59), are
rendered only inside the feature group(s) that require them — for the shipped table,
the "Relighting required" sub-panel (M7.1: optional families never appear in the main
signature checklist, which lists required families only) — and get a distinct family
grouping in the property table. The first optional set is the per-splat **normal** (`nx`, `ny`, `nz` —
float, 12 bytes/vertex), written by the reference 3DGS exporter right after `x/y/z`
(62 properties × 4 B = 248 B/vertex). A summary badge (`optional: normal 3/3`, amber
when only part of an optional set is present) appears only when at least one optional
property is found. Optional properties count toward the exact size check like any other
property. More optional sets can be added to the same signature table.

**Relighting capability (M7).** A distinct question from the signature badge:
*is this PLY relightable?* For that use case a PLY is **relightable** only when both
of the *optional* signature families are fully present on the vertex element — treated
together as one **"relighting required" property group**:

| Relighting-required group | Properties | Count |
|---|---|---|
| Normals | `nx`, `ny`, `nz` | 3 |
| Material (PBR factors) | `metallicFactor`, `roughnessFactor` | 2 |

Modeling: a small capability table (`FEATURES`) maps a capability to the signature
family keys it requires — `relighting: { requires: ["normal", "material"] }` — and a
pure `detectRelighting(elements)` computes, per required group, `found`/`missing`/
`complete` plus a rollup (5 properties total). Design decisions (scope and
placement confirmed with the user; remaining items are v1 defaults):

- **Shown for 3DGS candidates only (confirmed).** The verdict renders only when the
  file triggers 3DGS signature recognition (badge ≠ `none`); files with no vertex
  element also get no verdict. The pure `detectRelighting` itself stays general (it
  checks property presence on the first `vertex` element, with no candidacy gate) —
  the restriction is a render-layer decision, so the core stays unit-testable on any
  element list. The verdict never changes the standard/near badge or the required
  matched/total counts (59); the two families stay `optional` in the signature table.
- **Name-based**, consistent with family matching (property *types* are not checked
  in v1 — a `metallicFactor` declared `int` still counts as present).
- **Verdict states:** `supported` (5/5) / `partial` (1–4/5, lists what is missing) /
  `not supported` (0/5). With multiple `vertex` elements, the first one is used —
  same convention as the signature.
- **UI surface (confirmed: sub-panel in the signature checklist card):**
  1. a **"Relighting required" sub-panel at the end of the 3DGS signature
     checklist card** — a visually distinct boxed section with the verdict badge
     (`✓ supported (5/5)` green / `◐ partial (3/5)` amber / `✗ not supported (0/5)`
     red), a one-line requirement note, and one row per group (normals, material)
     with found ratio + missing property names. Chosen over a separate card so the
     verdict sits next to the two family rows that drive it — when the answer is
     "no", the *why* is immediately visible;
  2. a compact **file-summary badge** (`relighting: ✓ supported (5/5)` /
     `relighting: ◐ partial (3/5)` / `relighting: ✗ not supported (0/5)`) for
     at-a-glance identification, mirroring the existing `optional:` badge;
  3. a `relighting` pill on the `normal`/`material` rows of the checklist —
     SUPERSEDED by M7.1 (the optional rows left the main checklist, so both row
     pills were retired with them).
  The verdict object is added to the JSON export.

**Checklist scoping revision (M7.1, implemented).** The
optional families are currently listed twice: once as dashed `optional` rows in the
main signature checklist and again as groups in the "Relighting required" sub-panel.
Revision (confirmed direction: *optional properties should not be listed in the main
checklist — they appear only in the groups they are part of*):

- **Render rule:** the main checklist renders **required families only** (6 rows,
  59 properties). `renderSignatureCard` filters `.famcheck` rows to `!f.optional`;
  the dashed `normal`/`material` rows and both row pills (`optional`, `relighting`)
  — plus their now-dead CSS (`.famrow.optional`, `.famrow .st.opt`, `.optpill`,
  `.relpill`) — are removed. No sub-panel change is needed: its one-line
  requirement note already names all five properties (`nx, ny, nz` /
  `metallicFactor, roughnessFactor`), so dropping the checklist rows loses no
  information.
- **Orphaned optional families** (optional, but required by no feature group):
  rendered in neither the main checklist nor any group panel — *designed-out*,
  not an error. None exists today; they remain visible in the property-table
  Group column and in the JSON export, so nothing is silently lost. (Alternative
  considered: keep orphans in the main checklist; rejected as a special case —
  re-decide only if one is ever added.)
- **Unchanged by this revision:** the whole data layer (`SIGNATURES`,
  `detect3DGS`, `detectRelighting`, `FEATURES`, JSON export), the standard/near
  badge, the 59 matched/total counts, both summary badges (`optional: …`,
  `relighting: …`), the property-table Group column with its `optional` tag, and
  all fixtures.
- **Tests:** core suite untouched (49 tests — the change is render-layer only).
  Browser smoke: drop/repurpose the `famOpt` and `relPills` snapshot keys; every
  candidate scenario now asserts exactly **6 checklist rows** and that no main
  checklist row mentions `normal`/`material`; sub-panel (`relRows`) and badge
  assertions unchanged.
- **Docs touched:** §3 (optional-properties addendum wording + UI-surface item 3,
  marked superseded), the §4.2 tree, the milestone table; README "What it shows"
  bullets (checklist rows + pills wording).

## 4. Architecture

### 4.1 The key performance insight: header-only parsing

Everything the GUI needs lives in the ASCII header, which is a few KB even for 1 GB files.
The body (the several-hundred-MB part) is **never read** — except an optional first-vertex
preview (§4.5). In the browser:

```js
// Read only the first 64 KB of a 2 GB file: slice() doesn't materialize the rest.
const bytes = new Uint8Array(await file.slice(0, windowSize).arrayBuffer());
if (!bytesContainEndHeader(bytes)) windowSize *= 2;  // grow: 128K, 256K, … cap 16 MB
```

Result: opening a 1 GB PLY takes milliseconds and uses tens of KB of memory.

### 4.2 Component split (all inside one `<script>` block)

```
index.html
├── <style>            dark theme, tables, badges, drop zone
├── <div id="app">     static template; JS fills sections
└── <script>
   ├── PLY.TYPES       type table (§3.2): token → {normalized, bytes, signedness}
   ├── PLY.parseHeader(bytes)
   │    → { format, headerByteLength, elements[], comments[], objInfo[], warnings[] }
   │    • pure function, no DOM — this is what unit tests run
   │    • line-based scan with CRLF tolerance; strict magic/format validation;
   │      lenient on unknown keywords (warning + skip, raw line preserved)
   ├── PLY.expectedSize(elements, headerByteLength, format)
   │    → { exact?, fixedBytes, variable?, bytesPerElement: {name: n} }
   ├── PLY.detect3DGS(elements)
   │    → { badge, families: [{name, expected, found, missing, extra}] }
   ├── PLY.FEATURES       capability table (M7): relighting → required family keys
   ├── PLY.detectRelighting(elements)           (M7, relighting verdict)
   │    → { label, supported, matched, total, missing,
   │        groups: [{key, name, expected, found, missing, complete}] }
   │    • name-based, first `vertex` element; render layer gates display on badge ≠ none
   ├── PLY.decodeFirstVertex(file, header)      (M5, first-row preview)
   ├── PLY.rowJumpInfo(element)                 (M6, row-N preview)
   │    → { jumpable, rowBytes, reason } — fixed-size rows only (no lists,
   │    no unknown types, finite positive count)
   ├── PLY.tailCheckInfo(rowBytes, count, fileSize, headerByteLength)
   │    → { status: ok | missing | truncated-row, offset, available, need }
   │    • pure arithmetic, no decoding — powers the tail badge
   ├── PLY.decodeRowAt(file, header, rowIndex)  (M6, one max(64 KB, rowBytes) slice)
   ├── UI: drop zone / file input wiring, render(state), copy-CSV, export-JSON
   └── export: globalThis.PLYInspector = { parseHeader, TYPES, detect3DGS,
         detectRelighting, FEATURES, … }
        + DOM init guarded by `typeof document !== "undefined"`
```

The `globalThis` export + DOM guard is what lets the Node test harness execute the exact
shipping code (§8) — no build step, no code duplication.

### 4.3 Data flow

```
File (drag-drop / picker)
  → slice(0, window) → parseHeader
  → expectedSize + detect3DGS + detectRelighting
  → render(summary card, signature card (with "Relighting required" sub-panel),
     vertex table, other elements, size-check, raw header)
```

Parse result is plain data; rendering is a pure-ish `render(state)` so state changes
(re-open, re-drop) just re-render.

### 4.4 Parse rules and edge cases

| Case | Behavior |
|---|---|
| First line ≠ `ply` (optionally after a UTF-8 BOM) | Hard error: "not a PLY file" |
| `format` line missing / unsupported version | Hard error, show offending line |
| `element` before any `property`, or `property` with no open element | Warning; property attached to nearest element or dropped to warnings |
| Unknown keyword | Warning (line number + raw text), parsing continues |
| Unknown property type token | Warning; row shown with type `?` and 0 bytes, flagged |
| `end_header` not found | Grow window up to 16 MB, then hard error "header not terminated" |
| No `end_header` before EOF | Hard error, show how far we got |
| CRLF vs LF | Both accepted (strip trailing `\r`) |
| Non-ASCII in comments | UTF-8 decode, `fatal: false` (never throw on text) |
| Duplicate element names (legal in PLY) | Kept as separate occurrences, indexed (e.g. `vertex #2`) |
| Negative / absurd element counts | Warning; cross-checked against file size where possible |
| Multiple vertex elements | All shown in the vertex section |

### 4.5 Row preview & tail check (M5 first row, M6 row N)

For binary files, decode the first row of the first element: read
`count`-prefixes for list properties, respect endianness, decode int/float widths, and
show `name → value` chips for that row. This is concrete proof the body matches the
header, and for 3DGS it shows the first Gaussian's real position/SH/opacity. Bounded read:
`file.slice(headerByteLength, headerByteLength + 64 KB)`.

When `rowJumpInfo` reports the rows as fixed-size (no `list` properties, no unknown
types, finite positive count), any row N can be previewed on demand: `decodeRowAt`
computes `headerByteLength + N·rowBytes` and reads one slice capped at
`max(64 KB, rowBytes)`. The last row is decoded once during load and reused by the
"Last" button (no re-read). The same offset math drives the **tail check** — pure
arithmetic, no decoding: file size vs the last claimed row's offset yields `ok`
(green), `missing` (body ends before it), or `truncated-row` (body ends mid-row,
reported with exact available/needed bytes). Non-jumpable rows and ASCII bodies show a
gray `n/a` badge with the reason. The tail check and the size check are complementary
by design: a larger-than-expected file whose last row still decodes shows a red size
badge and a green tail badge.

## 5. UI design

Single screen, stacked cards, dark theme, no scroll-hiding information. Real `<table>`
elements for screen-reader friendliness; drop zone is keyboard-focusable (Enter opens the
file dialog); status region is `aria-live`.

```
┌──────────────────────────────────────────────────────────────────────┐
│  PLY Inspector                      [drop .ply here]  or  [Open…]    │
├──────────────────────────────────────────────────────────────────────┤
│ ┌ File summary ────────────────────────────────────────────────────┐ │
│ │ output.ply · 235.4 MB · binary_little_endian 1.0                 │ │
│ │ header 2.1 KB · 1 element · 1,000,000 vertices · 236 B/vertex    │ │
│ │ expected size 235.4 MB  ✓ matches actual                         │ │
│ │ ● 3DGS — standard signature (59/59)        comments [2] ▸        │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌ Vertex properties (59) ─────────────── [copy CSV] [export JSON] ─┐ │
│ │   #  Name          Type      Bytes  Offset  Group                │ │
│ │   0  x             float32   4      0      position              │ │
│ │   1  y             float32   4      4      position              │ │
│ │   2  z             float32   4      8      position              │ │
│ │   3  f_dc_0        float32   4      12     SH dc                 │ │
│ │   …  (45 × f_rest_i, opacity, scale_0…2, rot_0…3)                │ │
│ │   58 rot_3         float32   4      232    rotation              │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌ Other elements (1) ─────────────────────────────────────────────┐ │
│ │ face × 302,271 — 1 property: list uchar int vertex_indices       │ │
│ │   (click to expand per-property table, same columns as above)    │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌ First vertex (optional, M5) ────────────────────────────────────┐ │
│ │ x −1.234  y 0.567  z 3.210  f_dc_0 0.087 …  opacity 0.89         │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│  ▸ Raw header (2.1 KB, verbatim)                                     │
│  ⚠ warnings (0)                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Details:

- **Vertex table** is the default view, uncollapsed, full width. Group column is colored
  by 3DGS family (or "—" for unrecognized). Row hover highlight; row click copies that
  property line (`property float f_dc_0`) to the clipboard.
- **Size-check badge:** `✓ matches` / `✗ truncated (expected ≥ N)` / `✗ larger than
  expected` / `– variable-length rows, exact check n/a` / `– n/a for ASCII`.
- **Relighting (M7):** shown for 3DGS candidates only (signature badge ≠ `none`).
  A compact file-summary badge `relighting: ✓ supported (5/5)` (green) /
  `relighting: ◐ partial (3/5)` (amber) / `relighting: ✗ not supported (0/5)` (red)
  gives the at-a-glance answer; the detail lives in a **"Relighting required"
  sub-panel at the end of the signature checklist card** — a visually distinct
  boxed section with the verdict badge and one row per required group:

  ```
  ┌ Relighting required ──────────────────────── [◐ partial (3/5)] ┐
  │ requires per-vertex normals + PBR material factors             │
  │   ✓ normals   3/3                                              │
  │   ✗ material  0/2   missing: metallicFactor, roughnessFactor   │
  └────────────────────────────────────────────────────────────────┘
  ```

  (M7.1: the `normal`/`material` optional families no longer have rows in the main
  signature checklist — required families only — so the sub-panel is their sole
  checklist-level rendering, and the M7 row pills were retired with it.)
- **Comments/obj_info:** collapsed list, verbatim, monospace.
- **Raw header:** verbatim text in a `<pre>`, byte length labeled, copy button.
- **Errors:** a persistent panel with line numbers for hard errors (rendering of that
  file stops) — warnings never block rendering.
- **Export:** `copy CSV` (vertex table) and `export JSON` (full parse result, download
  via `Blob` + object URL — works under `file://`).
- **Re-open:** dropping a new file replaces the view; a small "last inspected" breadcrumb
  keeps the previous file name.

## 6. Testing strategy

No build step ⇒ the harness executes the shipping script text directly in Node (Node 24
is available; no npm packages needed):

```
test/run-tests.mjs
  1. read index.html
  2. extract the <script> block
  3. run it in a vm context (no DOM — the DOM guard makes this safe)
  4. grab globalThis.PLYInspector, run assertions on real fixtures
```

Fixtures (`test/fixtures/`, generated by `scripts/make-fixtures.mjs` plus a few hand-written):

| Fixture | Verifies |
|---|---|
| `3dgs_standard.ply` | 59-property standard header + 3 binary rows → table, 236 B/vertex, size check, 3DGS badge |
| `3dgs_with_normals.ply` | 62-property standard + optional normals (INRIA layout) → standard badge + `optional: normal 3/3`, 248 B/vertex |
| `3dgs_normals_partial.ply` | 60-property standard + `nx` only → badge stays standard, optional 1/3 partial |
| `3dgs_relightable.ply` | 64-property standard + normals + material (INRIA layout) → standard badge + `relighting: supported (5/5)`, 256 B/vertex |
| `ascii_relightable_mesh.ply` | ASCII mesh with normals + material factors, no SH props → 3DGS badge `none`; core `detectRelighting` still reports `supported (5/5)` — display is gated to candidates by the render layer, so this fixture pins the core-vs-UI split |
| `3dgs_missing_rest.ply` | Near-miss signature → per-family checklist, no false badge |
| `ascii_mesh.ply` | ASCII format, face element with `property list`, color/normal props |
| `big_endian.ply` | BE binary, `double` + `int` + `uchar` mix |
| `crlf_comments.ply` | CRLF endings, non-ASCII comment, `obj_info` |
| `bom.ply` | UTF-8 BOM before `ply` |
| `bad_magic.ply` / `no_end_header.ply` / `bad_format.ply` | Hard errors, correct messages |
| `unknown_kw.ply` | Warning, no crash |
| `weird_props.ply` | Unnamed properties + malformed `property list` lines → warnings, `?` placeholders, no "null" rendered |
| `header_at_boundary.ply` | `end_header` exactly at first-window edge → window growth |
| `truncated_body.ply` | Binary header valid, body 1 row short → truncated warning |
| `tail_midrow.ply` | Binary header valid, body ends mid-row (1 full row + 2 stray bytes) → tail check `truncated-row` (2 of 4 B) + size check truncated |

The row preview (M5/M6) gets its own decode tests (LE/BE, int widths, list counts,
last-row jumps, tail verdicts). The relighting verdict (M7) gets its own `detectRelighting`
tests — supported / partial / not supported / no vertex element / multiple vertex
elements — on the new fixtures plus existing ones (`3dgs_standard` → 0/5 not
supported, `3dgs_with_normals` → 3/5 partial, `ascii_mesh` → 3/5 partial), and the
JSON export gains the verdict object.
Manual smoke: open `index.html` via `file://` in Chrome and Edge, drag a real 3DGS
`output.ply` (≥ 200 MB) — time it, eyeball the table.

## 7. File layout

```
dsh-test/
├── PLAN.md                  this document
├── README.md                how to open the tool, what it shows, limitations
├── index.html               THE tool (single file, ~1–1.5 KB minified… ~40–60 KB readable)
├── scripts/
│   └── make-fixtures.mjs    generates binary/ASCII PLY fixtures for tests + manual use
└── test/
    ├── run-tests.mjs        vm-based harness, zero dependencies
    └── fixtures/            see §6 table
```

## 8. Milestones

| # | Milestone | Contents | Est. |
|---|---|---|---|
| M0 | Scaffold | `git init`, README, empty `index.html` shell, test harness skeleton that extracts + runs the script block | S |
| M1 | Header parser | `parseHeader` + `TYPES` + `expectedSize` + `detect3DGS` as pure functions; full fixture test suite green | M |
| M2 | Core UI | Drop zone + file picker, window-growth reader, file summary card, **vertex property table**, warnings panel | M |
| M3 | Complete header view | Other-elements section, comments/obj_info, raw header, size-check badge, CSV/JSON export | S |
| M4 | 3DGS recognition | Signature badge, family grouping + colors, per-family checklist for near-misses | S |
| M5 | Polish & stretch | First-vertex preview, clipboard-on-row-click, a11y pass, empty/error states, README polish | S–M |
| M6 | Row-N preview & tail check | `rowJumpInfo`/`tailCheckInfo`/`decodeRowAt`, row-jump form + **Last** button, tail badge in the summary, `rowJump`/`lastRow`/`tail` in JSON export, `tail_midrow` fixture | S |
| M7 | Relighting capability | `FEATURES` table + pure `detectRelighting` (tested); file-summary relighting badge; "Relighting required" sub-panel in the signature checklist card (candidates only); M7.1: main checklist scoped to required families (optional families render only inside the sub-panel); verdict in JSON export; `3dgs_relightable` + `ascii_relightable_mesh` fixtures | S–M |

S ≈ under an hour of implementation; M ≈ a focused session. Total single-file size target
< 60 KB, no external requests.

## 9. Out of scope (v1) / future ideas

- Body analysis beyond on-demand single-row reads (histograms, coordinate ranges,
  sampling statistics) — row-N preview reads one row at a time; whole-body stats would
  still require streaming; doable later with a `File`-streaming worker.
- Multi-file comparison (e.g. before/after training) — the JSON export already makes this
  scriptable.
- Variant signatures beyond "standard 3DGS" (2DGS, Mip-Splatting, quantized/compact
  formats) — data model already supports adding more signature definitions.
- 3D preview of the point cloud (out of scope: this is a header inspector, not a viewer).
- Packaging as a native desktop app (Electron/Tauri) if a double-click-exe is ever wanted —
  the single file would drop straight into the Electron `loadFile`.

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Unusual/proprietary headers from specific tools | Lenient keyword handling + warnings + always-visible raw header — nothing is ever lost or fatal unless magic/format is wrong |
| `file://` browser quirks | Only File-API features used (`File`, `slice`, `TextDecoder`, `Blob` object URLs) — all fine under `file://` in evergreen browsers; smoke-tested in both Chrome and Edge |
| Pathologically large headers | Window growth capped at 16 MB with a clear error |
| Test code diverging from shipping code | Tests execute the literal `<script>` from `index.html` (same bytes, no build) |

## 11. Open questions (defaults noted; answer before M0 if you care)

1. **File naming:** ship as `ply-inspector.html` or keep `index.html`? (Default: `index.html`
   in the repo; README shows copying it to a memorable name.)
2. **First-vertex preview:** worth the M5 effort, or cut? (Default: build it — it's the
   strongest "the file is actually what the header claims" signal.)
3. **Signature definitions file:** keep 3DGS families inline (default) or a small JSON table
   in the HTML for easy future variants? (Default: a clearly delimited const table — good
   enough for one signature.)
