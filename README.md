# PLY Inspector

***Disclaimer: This tool was made entirely by Qwen3.8-27B through Deepseek Harness running locally on an RTX 5090 in approximately 2 hours.***

A single-file web tool that inspects PLY file **headers**, built around 3D Gaussian
Splatting (3DGS) workflows. No server, no network, no build step, no dependencies —
one `index.html` is the whole deliverable. See [PLAN.md](PLAN.md) for the design.

## Usage

1. Double-click `index.html` (works from `file://` in any modern evergreen browser),
   or serve it from any static host.
   Tip: copy the file to a memorable name first, e.g. `ply-inspector.html`.
2. Drag a `.ply` file anywhere on the page (or use **browse…**).

Nothing is uploaded and the file body is never read in full — the tool reads at most
a 64 KB window (growing up to 16 MB for very long headers) to find `end_header`,
plus one 64 KB slice of the body for the first-vertex preview.

## What it shows

- **File summary** — format/version, element list with counts, header size,
  bytes/row of the first element, and a **size check** badge: expected-vs-actual
  body size that flags **truncated** or **larger-than-expected** files (gray "n/a"
  for ASCII bodies, variable-length rows, or unknown counts).
- **3DGS signature badge** — `3DGS — standard signature (59/59)` for the standard
  59-float32-property splat layout, an amber **near-match** badge (with a
  per-family checklist showing exactly which properties are missing) when the
  file looks 3DGS-like but deviates, and nothing for ordinary meshes/point clouds.
  **Optional** signature properties are reported separately and never change the
  standard/near badge: the first example is the per-splat **normal**
  (`nx`/`ny`/`nz`) written by the reference 3DGS exporter. When present you get
  a second summary badge (`optional: normal 3/3`, amber if only part of an
  optional set is present), a dashed "optional" row in the signature checklist
  (gray `– absent` instead of a red `missing` when not present), and a distinct
  dashed family grouping in the vertex table. The signature table is a clearly
  delimited `const` (PLAN §3.3 / §11.3) — add 2DGS/Mip-Splatting/quantized
  variants (and more optional sets) there.
- **Vertex property tables** — every property with its raw PLY type, normalized
  type (`float` → `float32`), byte width, byte offset (exact until the first
  `property list`, marked `≈` after), and color-coded 3DGS family group.
  Click a row to copy its `property …` line. **copy CSV** and **export JSON**
  capture the table / the whole inspection.
- **Other elements** — collapsed per element (e.g. `face`), with the same
  property tables inside.
- **First vertex** — the first body row decoded from the binary (64 KB bounded
  read), shown as name/value chips.
- **Comments & obj_info** and the **raw header** verbatim (one click, copyable).
- **Warnings** — unknown keywords, properties before any element, unknown types,
  negative counts, and friends never block rendering; they are listed with line
  numbers. Hard errors (bad magic, unsupported format version, unterminated
  header) stop with a clear error card citing the offending line.

## File layout

```
index.html               the app (deliverable)
PLAN.md                  implementation plan
scripts/make-fixtures.mjs  regenerates test/fixtures/ (15 fixtures)
test/run-tests.mjs       core test suite — runs the inline <script> in a Node vm
test/browser-smoke.mjs   optional UI smoke test — headless Chrome/Edge over CDP
test/fixtures/           generated PLY fixtures (do not edit by hand)
```

## Tests

```
node scripts/make-fixtures.mjs   # regenerate fixtures (already checked in)
node test/run-tests.mjs          # 32 core tests, no browser needed
node test/browser-smoke.mjs      # 68 UI assertions, needs Chrome or Edge
```

The core suite executes the literal inline script of `index.html` in a Node `vm`
context and tests the exported `globalThis.PLYInspector` surface (parser, size
check, signature detection, row decoding). The smoke test drives the real page in
headless Chrome/Edge over CDP (Node's built-in WebSocket — no npm deps) through
both origins the app must support: `http://` and `file://`. It is optional —
skip it where no browser is installed (override the binary via `CHROME_PATH`).

## Limitations (by design, PLAN §8)

- **Header-only inspection.** The binary body is read only for the first-vertex
  preview; the rest is never touched.
- **First row only.** The preview decodes row 0 of the first element.
- **One signature family table** is shipped (standard 3DGS, with the optional
  normal set); near-match is a recognition hint, not a strict validator.
- **List property offsets** are approximate by nature (variable-length items);
  offsets after the first `list` property are marked `≈`.
- **Unknown PLY types** are shown as `?` with 0 bytes plus a warning.
- Headers longer than the 16 MB window cap are reported as unterminated.
