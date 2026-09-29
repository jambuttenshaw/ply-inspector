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
(62 properties × 4 B = 248 B/vertex). The `optional: …` summary badge that once
reported them was removed in M7.2 — they are visible only in the "Relighting required"
sub-panel, the property table, and the JSON export. Optional properties count toward
the exact size check like any other property. More optional sets can be added to the
same signature table (M7.3: a property may also carry `aliases` — alternative
names that satisfy it; first user: the material family, see M7.3 below).

**Relighting capability (M7).** A distinct question from the signature badge:
*is this PLY relightable?* For that use case a PLY is **relightable** only when both
of the *optional* signature families are fully present on the vertex element — treated
together as one **"relighting required" property group**:

| Relighting-required group | Properties | Count |
|---|---|---|
| Normals | `nx`, `ny`, `nz` | 3 |
| Material (PBR factors) | `metallicFactor`, `roughnessFactor` (M7.3 aliases: `metallic`, `roughness`) | 2 |

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
     at-a-glance identification, mirroring the then-existing `optional:` badge
     (M7.2 later removed the `optional:` pill; the `relighting:` pill remains);
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
  `detect3DGS`, `detectRelighting`, `FEATURES`, JSON export — extended in M7.3 with
  property aliases), the standard/near
  badge, the 59 matched/total counts, the summary badges (the `relighting: …`
  pill; the `optional: …` pill survived M7.1 but was removed in M7.2), the
  property-table Group column with its `optional` tag, and
  all fixtures.
- **Tests:** core suite untouched (49 tests — the change is render-layer only).
  Browser smoke: drop/repurpose the `famOpt` and `relPills` snapshot keys; every
  candidate scenario now asserts exactly **6 checklist rows** and that no main
  checklist row mentions `normal`/`material`; sub-panel (`relRows`) and badge
  assertions unchanged.
- **Docs touched:** §3 (optional-properties addendum wording + UI-surface item 3,
  marked superseded), the §4.2 tree, the milestone table; README "What it shows"
  bullets (checklist rows + pills wording).

**Summary-pill removal (M7.2, implemented).** Two File-summary pills are no longer
rendered under any circumstances (direct user request):

- **`optional: …`** — the optional-family rollup pill. Nothing replaces it: the
  relighting badge + sub-panel already surface the same information for the two
  families that ship, and `optionalMatched`/`optionalTotal` stay in the JSON
  export.
- **`tail: …`** — the tail-check pill (ok / missing / truncated-row / n-a). The
  `tailCheckInfo` computation is untouched; the verdict stays in the JSON export
  as `tail`, it just has no UI. The `truncated_body` / `tail_midrow` fixtures now
  pin the size-check badge + export instead of the pill.

Render-layer only: `renderSummaryCard` drops both badge blocks; no data-layer,
fixture, or core-test change (49 core tests). Browser smoke: every former
pill-presence assertion becomes a no-pill guard (`!startsWith("tail:")` /
`!startsWith("optional:")`); the count stays 121. Docs: README "What it shows"
bullets reworded; this section + the M7/M7.1 mentions above annotated.

**Property aliases (M7.3, implemented).** A signature property may carry
**aliases** — alternative names that satisfy the same property. First user: the
material family — `metallicFactor` accepts `metallic`, `roughnessFactor` accepts
`roughness` (both spellings appear in the wild; direct user request). Semantics:

- **Any one of `[canonical, ...aliases]` suffices.** Matching stays name-based
  (types still not checked). When several spellings are present, the canonical
  name wins `found`; a redundant alias row is still grouped in the Group column.
- **Mechanism:** an optional `aliases` map on the family in `SIGNATURES`
  (canonical name → alias list), shared by `detect3DGS` and `detectRelighting`
  through `propNames`/`matchProp`; `baseFamilies` carries the map through.
- **`found` records the name actually in the file** (an alias when matched via
  one); **`missing` keeps the canonical name** — the one the user should add.
  Alias names are never reported as extras.
- **Relighting groups gain a `via` map** (file name → canonical name) for
  properties satisfied by an alias — surfaced in the UI and the JSON export.
- **UI reflection (the M7.1 sub-panel is the only place optional families
  render):**
  1. a per-group **`via aliases: metallic → metallicFactor, …`** line, shown
     whenever an alias satisfied a property (complete or partial);
  2. the one-line requirement note now names the aliases
     (`metallicFactor (alias: metallic)`, `roughnessFactor (alias: roughness)`);
  3. the property-table Group column resolves alias rows to the material family
     (`familyOf` maps every signature name present in the file).
- **Unchanged:** the standard/near badge, the 59 matched/total (aliases are
  optional material props), the `relighting:`/`size:` pills, the candidates-only
  verdict gate.
- **Tests:** new fixture `3dgs_relightable_alias.ply` (same layout as
  `3dgs_relightable.ply`, alias spellings at the end) + 4 core tests (aliases
  table, 5/5 via aliases, partial via a single alias, canonical-wins +
  no-extras); core 49 → 53. Browser smoke: new alias scenario (badge, sub-panel
  via-line, Group column, note), snapshot keys `groups` (Group column) +
  `relNote`, and a no-via-line guard on the canonical fixture; 121 → 133.

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
   ├── PLY.propertyGroups(element)              (M8, download grouping)
   │    → [{ kind: indexed|axis|single, label, sublabel, type, members,
   │    bytesPerRow }] — `f_rest_0…44` → one indexed chip, `nx/ny/nz` → one axis
   │    chip, everything else single (lists and unnamed props never grouped)
   ├── PLY.projectRow(src, offset, element, bigEndian, keep)
   │    → { out, complete } — one rewritten row: kept properties projected in
   │    order, list items copied verbatim, dropped properties cut
   ├── PLY.rowBounds(src, offset, element, bigEndian)
   │    → { bytes, complete } — one row's true length (list count prefix read)
   ├── PLY.subsetHeader(header, keepSets)
   │    → { text, byteLength, keptPerElement, expectedBodyBytes, variable }
   │    • re-emits header with kept elements/properties (raw lines verbatim)
   │      + a `comment PLY Inspector: kept …` marker line
   ├── PLY.subsetPlan(header, keepSets, fileSize)
   │    → { ok, reasons, elements: [{mode: copy|rewrite|drop, offset, rows,
   │    newRowBytes, rowBytes, hasList, keep}], estimatedOutSize, headerBytes,
   │    exact, variable } — infeasibility spelled out (no props selected,
   │    non-integer counts, unknown types in a rewrite)
   ├── PLY.streamSubset(readChunk, header, plan, { onProgress, isAborted,
   │    fileSize }) → { chunks, rowsWritten, perElementRows, truncated,
   │    trailingBytes, aborted, shortLines }
   │    • 8 MB windowed body walk; copy mode byte-copies rows verbatim,
   │      rewrite mode re-encodes via projectRow, ASCII mode token-projects
   │      each line; the only whole-body reader in the app
   ├── UI: drop zone / file input wiring, render(state), copy-CSV, export-JSON,
   │        download card (M8: group chips, live estimate, progress + Abort)
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
arithmetic, no decoding: file size vs the last claimed row's offset yields `ok`,
`missing` (body ends before it), or `truncated-row` (body ends mid-row, reported
with exact available/needed bytes); non-jumpable rows and ASCII bodies give `n/a`
with the reason. The tail pill in the summary was removed in M7.2 — the verdict
still runs and is exported as `tail` in the JSON snapshot, but it is no longer
rendered anywhere.

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
| `3dgs_with_normals.ply` | 62-property standard + optional normals (INRIA layout) → standard badge + partial relighting verdict, 248 B/vertex (the optional pill was removed in M7.2) |
| `3dgs_normals_partial.ply` | 60-property standard + `nx` only → badge stays standard, optional 1/3 partial |
| `3dgs_relightable.ply` | 64-property standard + normals + material (INRIA layout) → standard badge + `relighting: supported (5/5)`, 256 B/vertex |
| `3dgs_relightable_alias.ply` | Same layout as `3dgs_relightable.ply` but with the material ALIASES (`metallic`/`roughness`) → standard badge + `relighting: supported (5/5)` via aliases, `via` map in the verdict (M7.3) |
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
| `tail_midrow.ply` | Binary header valid, body ends mid-row (1 full row + 2 stray bytes) → tail verdict `truncated-row` (2 of 4 B) in the JSON export + size check truncated (the tail pill was removed in M7.2) |

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
| M7.2 | Summary-pill removal | `optional: …` and `tail: …` pills no longer rendered under any circumstances (data + JSON export untouched); smoke pill assertions flipped to no-pill guards; README/PLAN reworded | S |
| M7.3 | Property aliases | `aliases` map on signature families (`metallicFactor`/`metallic`, `roughnessFactor`/`roughness`); any spelling satisfies the property; `via` map in relighting groups; sub-panel via-aliases line + note; Group column resolves aliases; `3dgs_relightable_alias` fixture; core 49 → 53, smoke 121 → 133 | S |
| M8 | Download card (subset PLY export) | "Download" card with per-property-group checkboxes for every element (multidimensional properties — `f_rest_0…44`, `nx/ny/nz` — share one checkbox via the pure `propertyGroups` name-pattern helper), live size estimate, non-blocking two-phase progress + Abort, and a Blob download of a rewritten PLY keeping only the selected properties; pure core `propertyGroups`/`projectRow`/`rowBounds`/`subsetHeader`/`subsetPlan`/`streamSubset`/`coalesceParts` (byte-copy projection, binary + ASCII, truncation-tolerant, cooperative freeze guard); CDP download smoke scenario. See §12 | M–L |

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

---

## 12. M8 — Download card (subset PLY export)

**Feature.** A new **Download** card in the results stack. The user selects which
properties (attributes) to keep, per element, and the tool writes a *new* PLY file —
same format/endianness, original property order, bit-exact for every kept value — and
triggers a browser download. Downloading is the one feature that reads the whole body,
and it does so only on explicit user action, streamed in 8 MB windows with progress and
an Abort button.

### 12.1 Scope and decisions

| Decision | Choice | Rationale |
|---|---|---|
| Filtering granularity | One checkbox per **property group**, for **all elements** (not just `vertex`). **Multidimensional properties share a checkbox**: indexed families (`f_rest_0…44`, `scale_0…2`, `rot_0…3`) and axis components (`nx/ny/nz`, bare `x/y/z`) toggle together; everything else is a per-property checkbox | "filter properties out of the PLY" is generic; a face's `vertex_indices` is an attribute too. Grouping is a pure name-pattern rule (`propertyGroups`, §12.3) — signature-independent, so it works on any file. A 64-property relightable 3DGS vertex is **9 chips**, not 64 |
| Property order | Kept properties keep their **original relative order**; never reordered | Consumers expect `x/y/z` first; reordering is a value-transform, out of scope |
| Value handling | **Copy, don't decode** — kept bytes are copied verbatim (raw byte ranges) | Bit-exact by construction (no float round-trip questions), ~10× faster than decode/re-encode |
| Element exclusion | Unchecking **all** properties of an element = element excluded (no `element` line, rows walked & discarded) | Free consequence of the per-property model |
| Comments / obj_info | Preserved verbatim + one added `comment PLY Inspector: …` line; **no timestamp** (deterministic output) | Metadata stays lossless; byte-identical output for identical input |
| Output name | `<basename>.subset.ply` (`output.ply` → `output.subset.ply`) | Simple; the browser handles name collisions on repeat downloads |
| Full-body read | Only on the Download click; chunked (8 MB) with progress + Abort; output materialized once as a `Blob` (≈ output size memory) | Keeps the "body is never read" default intact with an explicit escape hatch |
| 3DGS presets (e.g. "Standard 59", "No SH rest") | **Stretch** — not in the v1 core | The checkbox grid already does it; presets are a cheap follow-up |

**Out of scope (v1):** value transforms (offset/scale/renormalize), type conversion
(float32 → float16, quantization), row-range selection ("first N rows"), property
reordering, multi-file merge, endianness/format conversion (ascii↔binary).

### 12.2 What the box shows (UI spec)

Placement in `render()`: after the Row preview card, before Comments & obj_info —
end of the data-card group. Shown whenever inspection succeeds, including the
infeasible cases (then it explains *why* the download is disabled).

```
┌ Download PLY ──────────────────────────────────────────────────────────────┐
│ output.ply: 235.4 MB → 94.1 MB · keeping 14/59 props        [Download]    │
│ ┌ vertex × 1,000,000 ────────────────────────── [All] [None]  236 → 56 B ┐│
│ │ ☑x,y,z ☑f_dc(3) ☐f_rest(45) ☑opacity ☑scale(3) ☑rot(4)                 ││
│ └─────────────────────────────────────────────────────────────────────────┘│
│ ┌ face × 302,271 ────────────────────────────── [All] [None]  list rows ─┐│
│ │ ☑vertex_indices (list uchar int)                                        ││
│ └─────────────────────────────────────────────────────────────────────────┘│
│ streaming:▓▓▓▓▓▓░░░░░░ 34% · 380,000/1,000,000 rows · 42.7 MB · 0.9 s  [Abort]│
│ assembling:▓▓▓▓▓▓▓▓▓▓▓░ 97% · 91.3/94.1 MB · 1.1 s                           │
│ after:    wrote 1,000,000 rows in 1.2 s → output.subset.ply (94.1 MB)      │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Card head:** title `Download PLY`; right-aligned `.actions` with the live
  **estimate** text and the **Download** button (**Abort** replaces it while running).
- **One subsection per element:** display name (duplicate names use `vertex #2`
  conventions), `× count`, **All** / **None** buttons, `N B/row → M B/row` (or
  `list rows` when variable), and a wrapped grid of **group chips** — one
  checkbox per `propertyGroups` group (§12.3):
  `<label class="prop-chip"><input type="checkbox" checked>
  <span class="nm">f_rest</span> <span class="ct">45</span>
  <span class="tp">float</span></label>`. Toggling a group chip selects/deselects
  **all of its members at once** (e.g. the `nx, ny, nz` chip toggles the whole
  normal; the `f_rest (45)` chip toggles all 45 SH-rest coefficients).
  A 64-property relightable 3DGS vertex renders as **9 chips** (x,y,z / f_dc /
  f_rest / opacity / scale / rot / nx,ny,nz / metallicFactor / roughnessFactor)
  instead of 64. Unnamed properties render as `#i (unnamed)` singles, selectable
  like any other.
- **Estimate line** (card head + per-subsection): recomputed on every checkbox
  change via one delegated `change` listener on the card. Uses `~` when the size
  is a lower bound (variable rows) or conservative (truncated body).
- **Progress line (two phases over one bar):** streaming owns 0–90 %
  (`streaming N% · rows done/total · MB out · seconds`), assembly owns 90–100 %
  (`assembling X of Y MB · seconds`) — monotone, never rewinds. Both phases are
  cooperative: the streamer yields to the event loop every ~24 ms of wall time
  and the assembler after every 16 MB segment, so the bar keeps painting and
  **Abort** (a cooperative flag honored in every phase) stays clickable on
  multi-GB files. `aria-live="polite"`.
- **Result line + toast** after success: `wrote N rows in t s → name.subset.ply (size)`.
- **Infeasible:** Download disabled (not removed), red `.note` listing the reasons (§12.4).
- **Footnote:** "Downloading reads the whole body once — the only feature that does."

### 12.3 Core design (pure functions, Node-testable — §4.2 convention)

New `globalThis.PLYInspector` exports:

1. **`propertyGroups(element)` → `[{ kind, label, sublabel, type, members, bytesPerRow }]`**
   — pure name-pattern grouping that drives the checkboxes (`kind`:
   `"single"` | `"indexed"` | `"axis"`; `members` = property indices in
   declaration order; `bytesPerRow` = sum of member byte widths). Rule (the two
   patterns are disjoint — a name ends in a digit *or* in one of the characters
   `x`/`y`/`z`, never both — so there is no precedence collision):
   - **indexed**: ≥ 2 properties matching `^(.+)_(\d+)$` with the same `base`
     (e.g. `f_dc_0…2`, `f_rest_0…44`, `scale_0…2`, `rot_0…3`). No contiguity is
     required — holes are fine and the label carries the actual member count
     (`f_rest (11)`); all members must share the same normalized type, else the
     family falls back to individual singles;
   - **axis**: ≥ 2 properties sharing a prefix whose names end in one of
     `x`/`y`/`z` (covers `nx/ny/nz`, `normal_x/y/z`, and bare `x/y/z` with an
     empty prefix);
   - everything else (scalars like `opacity`, list properties, 1-member
     candidates, pattern-unrelated triples like `red/green/blue`) is a **single**.
   Labels: indexed → the base + count pill (`f_rest` `45`, sublabel
   `f_rest_0 … f_rest_44`); axis → member names joined (`nx, ny, nz`; `x, y, z`);
   single → the property name. **Grouping is UI sugar over the same model**:
   `keepSets` stays a per-property boolean array — the UI expands group toggles
   into property indices, and the projection/plan/stream functions below are
   unchanged by this refinement.
2. **`projectRow(src, offset, element, keep, bigEndian)` → `{ out, complete }`** —
   projects one binary row onto the kept properties. Walks the row property by
   property: a kept fixed-width property copies its **raw byte range**
   (`out.set(src.subarray(o, o + p.bytes))`); a kept list property reads its count
   (one DataView access, endianness-aware) and copies the count bytes + item range
   verbatim; dropped properties only advance the offset. `out` is preallocated to
   the exact new row size. `complete: false` when `src` runs out mid-row.
3. **`rowBounds(src, offset, element, bigEndian)` → `{ bytes, complete }`** — the
   same walk with no output. Measures variable-length (list) rows so the walker
   knows where each row ends, and skips dropped-element rows.
4. **`subsetHeader(header, keepSets)` → `{ text, byteLength, keptPerElement, expectedBodyBytes, variable }`**
   — rebuilds the header text: `ply` + the original `format` line, original
   `comment`/`obj_info` lines verbatim, one added
   `comment PLY Inspector: kept vertex 14/59; face 1/1` line, then per element
   (in original order, drop-mode elements omitted entirely) the `element` line and
   the kept `property` lines using the **verbatim `rawLine`** so the original type
   tokens (`float` vs `float32`) survive. `keepSets` is an array aligned with
   `header.elements` — **keyed by element index**, so duplicate element names map
   to distinct occurrences (same convention as `elementDisplay`).
5. **`subsetPlan(header, keepSets, fileSize)` → `{ ok, reasons[], elements: [{ mode: "copy" | "rewrite" | "drop", offset, rows, newRowBytes }], estimatedOutSize }`**
   — feasibility plus the numbers behind the live estimate. An element is
   `copy` when its selection equals the original (its body region streams
   verbatim — zero decoding), `rewrite` when any property is dropped (all its
   types must be known, binary), `drop` when nothing is kept.
6. **`streamSubset(readChunk, header, plan, { onProgress, isAborted, yielder, now, yieldBudgetMs })` → `{ chunks, rowsWritten, perElementRows, truncated, trailingBytes, aborted }`**
   — the body walker. `readChunk(start, end) → Promise<Uint8Array>` is injected:
   the browser glue builds it from `file.slice(start, end).arrayBuffer()`, the
   Node tests build it from a Buffer — so the whole transform is testable in the
   vm harness with no DOM. Reads in 8 MB windows with a carry buffer for
   chunk-boundary rows; element regions are walked in header order: copy rows
   append raw slices, rewrite rows go through `projectRow`, drop rows through
   `rowBounds`; variable-length rows are always measured first with `rowBounds`.
   **ASCII bodies** take a text path: windowed reads with a streaming
   `TextDecoder`, one row per line, whitespace-separated tokens, kept-token
   projection (list counts are inline tokens — same treatment), blank lines
   skipped. **Cooperative yielding (freeze guard):** with a `yielder`, every
   per-row loop hands the event loop back to the browser once
   `yieldBudgetMs` (default 24) of wall time (`now`) has passed — the page
   repaints and Abort clicks are handled even mid-window. Without a yielder
   the behavior is unchanged (the Node tests pass none).
7. **`coalesceParts(parts, isAscii, { onProgress, yielder, isAborted }) → { parts, aborted }`**
   — merges the streamer's per-row parts into a few Blob parts: each segment of
   at most 16 MB (or 65 536 string parts, ASCII) is copied exactly ONCE, so the
   total work is O(output size) — the pre-fix grow-a-buffer-per-part merge was
   O(output²/row) and froze the page for minutes on real 3DGS downloads
   (user-reported bug). Progress is reported per segment (the first event
   carries the total up front), a cooperative abort discards everything, and a
   yield after each segment keeps the main thread responsive throughout the
   assembly (freeze guard, §12.4).

**Browser glue** (UI section, not vm-tested): builds `readChunk` from
`state.file`, runs `streamSubset` with the abort flag, the progress callback,
and a `setTimeout 0` yielder on a `performance.now` clock; merges the per-row
parts with the core `coalesceParts` (byte progress, a yield after every
segment, abort honored); assembles
`new Blob([headerText, ...coalesced], { type: "application/octet-stream" })`,
and downloads via object URL + anchor click — the exact pattern `exportJSON`
already uses, proven under `file://`. Memory: input is streamed; the output is
materialized once (≈ output size — documented in README).

### 12.4 Edge cases (exact behavior)

| Case | Behavior |
|---|---|
| Selection unchanged on an element | `copy` mode — its body region streams verbatim, header lines untouched (no decoding at all) |
| Some properties dropped, all types known | `rewrite` mode — rows projected by raw byte-range copy |
| **Unknown-type property on a binary element whose selection changes** | Infeasible: Download disabled with `cannot re-encode "<element>": unknown type "<token>" on "<prop>"`. The *unchanged* case stays `copy` (no decode needed), so `weird_props.ply` remains downloadable with everything kept |
| Non-integer / negative element count (binary) | Infeasible: row counts undeterminable (`"count"` reason) |
| Element with count 0 | `element` line emitted when any property is kept; zero body rows |
| **Truncated body** (actual < claimed) | Walker stops at EOF: the output contains the complete rows written so far, and the **output element count is set to the rows actually written** (the download doubles as a repair tool); note: `wrote N of M claimed rows — body truncated` |
| **Body larger than expected** | Exactly `count` rows per element are emitted; trailing bytes are dropped with a note `ignored K trailing bytes` |
| All properties unchecked on an element | Element excluded: no `element` line; its rows are walked and discarded |
| Everything unchecked | Infeasible: `no properties selected` |
| Duplicate element names | `keepSets` keyed by element index; subsections use display names (`vertex`, `vertex #2`) |
| Unnamed properties | Chips labeled `#i (unnamed)`, selectable |
| **Multidimensional property** (indexed family, axis components) | One shared checkbox; toggling it selects/deselects every member at once. `keepSets` is still per-property — the core projection/plan/stream are unaffected (grouping is UI sugar, §12.3 item 1) |
| Indexed family with holes (only `f_rest_0…10` present) | One group labeled with the actual count (`f_rest (11)`); no contiguity required |
| Indexed family with mixed types (`b_0` float, `b_1` int) | Not grouped — individual chips (a group chip displays one shared type) |
| Pattern-unrelated triple (e.g. `red/green/blue`) | Three single chips — grouping is name-pattern-based, not semantic |
| List properties (`face`/`vertex_indices`) | Always a single chip. Kept → count + item bytes copied verbatim; dropped → walked and skipped. Variable-length rows are always measured with `rowBounds`, never assumed fixed |
| **ASCII bodies** | Token projection, one row per line; blank lines skipped; a line with fewer tokens than declared emits what is present (counted in a note); output count = rows actually present |
| Big-endian files | Same code path; the list-count read is endianness-aware, the byte copies are endian-agnostic |
| Abort mid-download | Cooperative, honored in every phase: the flag is checked per row while streaming and per 16 MB segment while assembling; the partial output is discarded; the card returns to idle |
| **Large output — main-thread freeze guard** | Neither phase blocks the page: the per-row stream loop yields to the event loop every ~24 ms of wall time and the assembly yields after every 16 MB segment, so the bar keeps painting and clicks are handled on multi-GB files. The bar is monotone (streaming 0–90 %, assembly 90–100 %) with explicit phase text (`streaming N% …` / `assembling X of Y MB`), so work is always visibly happening |
| Re-inspecting another file | The card re-renders with all properties checked (fresh state per file; no persistence) |
| Hard-error file | No card, same as every other card — the error card replaces the results |
| `file://` origin | Works — only `File.slice` / `Blob` / object URL / anchor download (same as the existing JSON export) |

### 12.5 Testing

**Core suite** (`test/run-tests.mjs`, 53 → ~69; no new fixtures — existing ones
plus small synthetic in-test buffers):

1. `subsetHeader` keep-all on `3dgs_standard.ply`: starts `ply\nformat binary_little_endian 1.0\n`; all 59 `property float …` lines **verbatim**; original comment preserved; the added comment line present; `parseHeader` round-trip returns 59 properties and `expectedSize` agrees with `expectedBodyBytes`.
2. `subsetHeader` dropping the 45 `f_rest_*`: vertex keeps exactly `x,y,z,f_dc_0…2,opacity,scale_0…2,rot_0…3` **in original order**; `expectedBodyBytes` = 3 × 56; `face`… (n/a here — single element) and, on a two-element synthetic header, the unchanged second element survives verbatim.
3. `subsetPlan` keep-all → every element `copy`, `ok: true`, `estimatedOutSize` = new header + full body.
4. `subsetPlan` infeasible: (a) `weird_props.ply` with a sibling of the unknown-type property unchecked → reason names the unknown type; (b) synthetic non-integer count → count reason; (c) all-empty `keepSets` → `no properties selected`.
5. `projectRow` LE on a synthetic 236 B row with a distinct byte pattern per position: keep `{x,y,z,f_dc_0}` → 16 B output, byte-identical to the source ranges; keep only mid-row `f_rest_0…2` → offset math correct.
6. `projectRow` list property on a synthetic face body (`3 0 1 2` uchar/int): kept → output bit-identical to the input row (13 B); dropped → `rowBounds` = 13 B, empty output.
7. `projectRow`/`rowBounds` truncation: a 10-byte slice of a 236 B row → `complete: false`.
8. `streamSubset` (binary, Buffer-backed `readChunk`) on the full `3dgs_standard` body, 45 `f_rest_*` dropped: output body is exactly 168 B, `perElementRows [3]`, each output row equals its source ranges; concatenating `subsetHeader` text + output and re-parsing yields values **bit-equal** to `decodeRow` on the original fixture.
9. `streamSubset` truncation on `tail_midrow` (1 full row + 2 stray bytes): `rowsWritten 1`, `truncated: true` — combined with `subsetHeader`, the emitted count is 1.
10. `streamSubset` trailing bytes: body + 5 extra bytes → `trailingBytes 5`, `rowsWritten 3`.
11. `streamSubset` ASCII on `ascii_mesh.ply` dropping the color props: every output line has the right token count, tokens equal the input tokens, blank lines tolerated.
12. `streamSubset` abort: `isAborted` flips true after the first chunk → `aborted: true`, no chunks kept.
13. `propertyGroups` on the `3dgs_standard` vertex → exactly **6** groups in declaration order: axis `{x,y,z}`, indexed `f_dc (3)`, indexed `f_rest (45)`, single `opacity`, indexed `scale (3)`, indexed `rot (4)`; member indices and `bytesPerRow` sums check out (236 B total).
14. `propertyGroups` on `3dgs_with_normals` → 7 groups including axis `{nx,ny,nz}`; on `3dgs_relightable` → **9** groups (the scalar material factors stay singles).
15. `propertyGroups` on `3dgs_missing_rest` → the `f_rest` group carries exactly its 11 present members (hole-tolerant); on `ascii_mesh` vertex → 5 groups (axis `{x,y,z}`, axis `{nx,ny,nz}`, `red`, `green`, `blue` singles); its `face` → 1 single list group.
16. `propertyGroups` synthetic: mixed-type family (`b_0` float / `b_1` int) → all singles; a 1-member family → single; empty-prefix axis (`x`,`y`,`z`) groups; pattern-unrelated `red/green/blue` → singles.
17. Export-surface test: the new exports join the asserted list.
18. `coalesceParts` (freeze guard): binary parts reassemble bit-exactly across 16 MB segment boundaries; ASCII parts join exactly; progress events start with `(0, total)`, are monotone, and end exactly at the total; one yield per in-loop segment; an abort raised mid-assembly (or pre-set) discards everything; scale — 200 000 × 232 B parts (≈ 46 MB) coalesce in well under a minute, guarding against a regression to the quadratic O(output²/row) merge behind the user-reported freeze.
19. `streamSubset` cooperative yields: with an injected `yielder` + deterministic `now` clock, the row loop yields roughly once per `yieldBudgetMs` and the output stays byte-identical; without a yielder the behavior is unchanged.

**Browser smoke** (`test/browser-smoke.mjs`, 133 → ~147):

- New CDP plumbing: `Browser.setDownloadBehavior` (allow, temp dir) + `Browser.downloadWillBegin` / `downloadProgress` (completed) to capture the Blob download and read the resulting file in Node.
- Scenario (http origin, `3dgs_standard.ply`): card exists with exactly **6** checked vertex group chips (`x, y, z` / `f_dc (3)` / `f_rest (45)` / `opacity` / `scale (3)` / `rot (4)`) and estimate `236 B/row → 236 B/row`; uncheck the single `f_rest` group chip → estimate flips to `56 B/row` and a smaller output size; click **Download**; the landed file must `parseHeader` to exactly the 14 kept properties in original order, have body size = header + 3 × 56, and `decodeRow` values on rows 0 and 2 bit-equal the values decoded from the original fixture.
- `3dgs_with_normals.ply`: the `nx, ny, nz` group chip unchecks all three components in one click (estimate drops 12 B/row); the other six groups are unaffected.
- `ascii_mesh.ply`: drop the color singles → ASCII output lines assert as in core test 11.
- `weird_props.ply`: uncheck a sibling of the unknown-type property → Download disabled, reason text mentions the unknown type; keep-all → Download enabled.
- `tail_midrow.ply`: download completes with the `wrote 1 of 2` truncation note.
- Abort: not asserted in smoke (fixtures too small to time it) — added to the manual checklist.

**Manual smoke:** drop a real ~200 MB 3DGS `output.ply`, uncheck the single
`f_rest` group chip (drops all 45 coefficients at once), time it, check the
landed size ≈ 1,000,000 × 56 B + header, and open the result in a splat viewer.

### 12.6 Docs touched

- README: "What it shows" bullet for the Download card (per-property-group
  checkboxes — multidimensional properties like `nx/ny/nz` or `f_rest_0…44`
  toggle together); "Limitations" bullets (download reads the whole body once;
  output memory ≈ output size; truncated files are emitted with the count
  corrected to complete rows).
- PLAN §4.2 component tree gains the six core entries; §8 milestone row (M8);
  this section (§12).

### 12.7 Work order

1. **M8.1 core** (test-first, all vm-green before any UI): `propertyGroups`,
   `projectRow`, `rowBounds`, `subsetHeader`, `subsetPlan`, `streamSubset`
   (binary + ASCII) + core tests 1–17.
2. **M8.2 UI:** `renderDownloadCard` + group-chip grid CSS (`.prop-chip`,
   `.dlgrid`, `.dlprog`), All/None, delegated estimate recompute, progress +
   Abort, Blob download glue.
3. **M8.3 smoke:** CDP download plumbing + the four scenarios.
4. **M8.4 docs.**

`index.html` grows by roughly 15–20 KB (the file is already near the §8 < 60 KB
target — this milestone may push past it; accepted trade for the feature).
