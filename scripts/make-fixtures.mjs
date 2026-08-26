#!/usr/bin/env node
// Generates PLY test fixtures into test/fixtures/ (PLAN.md §6 + §7).
// Zero npm dependencies. Run:  node scripts/make-fixtures.mjs
//
// Value convention for binary fixtures (makes decode tests exact):
//   3dgs_standard.ply:  value(row r, prop i) = r * 100 + i
//   3dgs_missing_rest:  value(row r, prop i) = r * 50  + i
//   3dgs_with_normals:  value(row r, prop i) = r * 100 + i
//   3dgs_normals_partial: value(row r, prop i) = r * 50 + i
//   3dgs_relightable:   value(row r, prop i) = r * 100 + i
//   3dgs_relightable_alias: value(row r, prop i) = r * 100 + i
//
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "test", "fixtures");
mkdirSync(outDir, { recursive: true });

const W = (name, buf) => {
  writeFileSync(join(outDir, name), buf);
  console.log(`  ${name.padEnd(24)} ${String(buf.length).padStart(8)} bytes`);
};

const LF = "\n";
const CRLF = "\r\n";
const headerOf = (ls, eol = LF) => ls.join(eol) + eol;

// ---------------------------------------------------------------------------
// Standard 3DGS vertex signature: 59 float properties (PLAN §3.3)
// ---------------------------------------------------------------------------
const STD3DGS = [
  "x", "y", "z",
  "f_dc_0", "f_dc_1", "f_dc_2",
  ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
  "opacity",
  "scale_0", "scale_1", "scale_2",
  "rot_0", "rot_1", "rot_2", "rot_3",
];
if (STD3DGS.length !== 59) throw new Error(`expected 59 props, got ${STD3DGS.length}`);
if (new Set(STD3DGS).size !== 59) throw new Error("duplicate property names in signature");

// ---------------------------------------------------------------------------
// 3dgs_standard.ply — full standard header + 3 binary rows (value = r*100 + i)
// ---------------------------------------------------------------------------
{
  const rows = 3;
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment Software: make-fixtures.mjs (standard 3DGS signature)",
    "element vertex 3",
    ...STD3DGS.map((n) => `property float ${n}`),
    "end_header",
  ]);
  const body = Buffer.alloc(rows * 59 * 4);
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < STD3DGS.length; i++) body.writeFloatLE(r * 100 + i, r * 59 * 4 + i * 4);
  W("3dgs_standard.ply", Buffer.concat([Buffer.from(header, "utf8"), body]));
}

// ---------------------------------------------------------------------------
// 3dgs_missing_rest.ply — near-miss: f_rest truncated to 11 of 45
// ---------------------------------------------------------------------------
{
  const names = [
    "x", "y", "z",
    "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 11 }, (_, i) => `f_rest_${i}`),
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
  ]; // 25 props
  const rows = 2;
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment near-miss fixture: f_rest truncated to 11 of 45",
    "element vertex 2",
    ...names.map((n) => `property float ${n}`),
    "end_header",
  ]);
  const body = Buffer.alloc(rows * names.length * 4);
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < names.length; i++) body.writeFloatLE(r * 50 + i, r * names.length * 4 + i * 4);
  W("3dgs_missing_rest.ply", Buffer.concat([Buffer.from(header, "utf8"), body]));
}

// ---------------------------------------------------------------------------
// 3dgs_with_normals.ply — standard 59 props + optional normals nx/ny/nz
// (reference 3DGS exporter layout: normals right after x/y/z), 62 props,
// value(row r, prop i) = r * 100 + i
// ---------------------------------------------------------------------------
{
  const names = [
    "x", "y", "z",
    "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
  ];
  if (names.length !== 62) throw new Error(`expected 62 props, got ${names.length}`);
  const rows = 3;
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment standard 3DGS + optional per-splat normals (nx/ny/nz)",
    "element vertex 3",
    ...names.map((n) => `property float ${n}`),
    "end_header",
  ]);
  const body = Buffer.alloc(rows * names.length * 4);
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < names.length; i++) body.writeFloatLE(r * 100 + i, r * names.length * 4 + i * 4);
  W("3dgs_with_normals.ply", Buffer.concat([Buffer.from(header, "utf8"), body]));
}

// ---------------------------------------------------------------------------
// 3dgs_normals_partial.ply — standard 59 props + only nx (1 of 3 optional
// normals), 60 props, value(row r, prop i) = r * 50 + i
// ---------------------------------------------------------------------------
{
  const names = [
    "x", "y", "z",
    "nx",
    "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
  ];
  if (names.length !== 60) throw new Error(`expected 60 props, got ${names.length}`);
  const rows = 2;
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment standard 3DGS + partial normals (nx only) — optional 1/3",
    "element vertex 2",
    ...names.map((n) => `property float ${n}`),
    "end_header",
  ]);
  const body = Buffer.alloc(rows * names.length * 4);
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < names.length; i++) body.writeFloatLE(r * 50 + i, r * names.length * 4 + i * 4);
  W("3dgs_normals_partial.ply", Buffer.concat([Buffer.from(header, "utf8"), body]));
}

// ---------------------------------------------------------------------------
// 3dgs_relightable.ply — standard 59 props + normals + PBR material factors
// (INRIA-style layout: normals right after x/y/z, material at the end),
// 64 props × 4 B = 256 B/vertex, value(row r, prop i) = r * 100 + i.
// Pins the M7 "supported" verdict: standard badge + relighting 5/5.
// ---------------------------------------------------------------------------
{
  const names = [
    "x", "y", "z",
    "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
    "metallicFactor", "roughnessFactor",
  ];
  if (names.length !== 64) throw new Error(`expected 64 props, got ${names.length}`);
  const rows = 2;
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment standard 3DGS + normals + PBR material factors — relightable (M7)",
    "element vertex 2",
    ...names.map((n) => `property float ${n}`),
    "end_header",
  ]);
  const body = Buffer.alloc(rows * names.length * 4);
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < names.length; i++) body.writeFloatLE(r * 100 + i, r * names.length * 4 + i * 4);
  W("3dgs_relightable.ply", Buffer.concat([Buffer.from(header, "utf8"), body]));
}

// ---------------------------------------------------------------------------
// 3dgs_relightable_alias.ply — same layout as 3dgs_relightable.ply, but the
// PBR material factors use their M7.3 ALIAS names (metallic / roughness
// instead of metallicFactor / roughnessFactor), 64 props × 4 B = 256 B/vertex.
// Pins alias matching: standard badge + relighting 5/5 via aliases.
// ---------------------------------------------------------------------------
{
  const names = [
    "x", "y", "z",
    "nx", "ny", "nz",
    "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 45 }, (_, i) => `f_rest_${i}`),
    "opacity",
    "scale_0", "scale_1", "scale_2",
    "rot_0", "rot_1", "rot_2", "rot_3",
    "metallic", "roughness",
  ];
  if (names.length !== 64) throw new Error(`expected 64 props, got ${names.length}`);
  const rows = 2;
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment standard 3DGS + normals + material ALIASES (metallic/roughness) — relightable (M7.3)",
    "element vertex 2",
    ...names.map((n) => `property float ${n}`),
    "end_header",
  ]);
  const body = Buffer.alloc(rows * names.length * 4);
  for (let r = 0; r < rows; r++)
    for (let i = 0; i < names.length; i++) body.writeFloatLE(r * 100 + i, r * names.length * 4 + i * 4);
  W("3dgs_relightable_alias.ply", Buffer.concat([Buffer.from(header, "utf8"), body]));
}

// ---------------------------------------------------------------------------
// ascii_mesh.ply — ASCII format, vertex + face(list) elements, color+normal
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format ascii 1.0",
    "comment tiny ASCII quad mesh",
    "element vertex 4",
    "property float x", "property float y", "property float z",
    "property float nx", "property float ny", "property float nz",
    "property uchar red", "property uchar green", "property uchar blue",
    "element face 2",
    "property list uchar int vertex_indices",
    "end_header",
  ]);
  const body = headerOf([
    "0 0 0   0 0 1   255 0 0",
    "1 0 0   0 0 1   0 255 0",
    "1 1 0   0 0 1   0 0 255",
    "0 1 0   0 0 1   255 255 0",
    "3 0 1 2",
    "3 2 3 0",
  ]);
  W("ascii_mesh.ply", Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(body, "utf8")]));
}

// ---------------------------------------------------------------------------
// ascii_relightable_mesh.ply — ASCII mesh WITH normals + PBR material factors
// but NO SH properties: 3DGS badge is `none` (not a candidate), yet the pure
// core detectRelighting reports supported (5/5). Pins the M7 core-vs-UI split:
// the render layer gates the verdict to candidates, the core stays general.
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format ascii 1.0",
    "comment ASCII mesh with normals + material factors, no SH — not a 3DGS candidate (M7)",
    "element vertex 4",
    "property float x", "property float y", "property float z",
    "property float nx", "property float ny", "property float nz",
    "property float metallicFactor", "property float roughnessFactor",
    "element face 2",
    "property list uchar int vertex_indices",
    "end_header",
  ]);
  const body = headerOf([
    "0 0 0   0 0 1   0.1 0.8",
    "1 0 0   0 0 1   0.1 0.8",
    "1 1 0   0 0 1   0.9 0.2",
    "0 1 0   0 0 1   0.9 0.2",
    "3 0 1 2",
    "3 2 3 0",
  ]);
  W("ascii_relightable_mesh.ply", Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(body, "utf8")]));
}

// ---------------------------------------------------------------------------
// big_endian.ply — BE binary, double + int + uchar mix (row 0: 3.5, 42, 7)
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format binary_big_endian 1.0",
    "comment big-endian fixture: double + int + uchar",
    "element vertex 2",
    "property double x",
    "property int count",
    "property uchar flag",
    "end_header",
  ]);
  const b = Buffer.alloc(2 * 13); // row size = 8 + 4 + 1
  b.writeDoubleBE(3.5, 0);
  b.writeInt32BE(42, 8);
  b.writeUInt8(7, 12);
  b.writeDoubleBE(-2.125, 13);
  b.writeInt32BE(-7, 21);
  b.writeUInt8(255, 25);
  W("big_endian.ply", Buffer.concat([Buffer.from(header, "utf8"), b]));
}

// ---------------------------------------------------------------------------
// crlf_comments.ply — CRLF endings, non-ASCII comment, obj_info
// ---------------------------------------------------------------------------
{
  const header = [
    "ply",
    "format binary_little_endian 1.0",
    "comment Café — generated with naïve tools (non-ASCII on purpose)",
    "obj_info scene: über-splats · v2",
    "element vertex 1",
    "property float x",
    "property float y",
    "property float z",
    "end_header",
  ].join(CRLF) + CRLF;
  const b = Buffer.alloc(12);
  b.writeFloatLE(-1.25, 0);
  b.writeFloatLE(2.5, 4);
  b.writeFloatLE(-3.75, 8);
  W("crlf_comments.ply", Buffer.concat([Buffer.from(header, "utf8"), b]));
}

// ---------------------------------------------------------------------------
// bom.ply — UTF-8 BOM before the magic
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment BOM fixture",
    "element vertex 1",
    "property float x",
    "property float y",
    "property float z",
    "end_header",
  ]);
  const b = Buffer.alloc(12);
  b.writeFloatLE(1, 0);
  b.writeFloatLE(2, 4);
  b.writeFloatLE(3, 8);
  W("bom.ply", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(header, "utf8"), b]));
}

// ---------------------------------------------------------------------------
// Hard-error fixtures
// ---------------------------------------------------------------------------
W("bad_magic.ply", Buffer.from(
  "gibberish not ply\nformat binary_little_endian 1.0\nend_header\n", "utf8"));

W("no_end_header.ply", Buffer.from(
  "ply\nformat binary_little_endian 1.0\nelement vertex 5\nproperty float x\nproperty float y\n", "utf8"));

W("bad_format.ply", Buffer.from(
  "ply\nformat binary_little_endian 2.0\nelement vertex 1\nproperty float x\nend_header\n", "utf8"));

// ---------------------------------------------------------------------------
// unknown_kw.ply — unknown keyword -> warning, parsing continues
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "element vertex 2",
    "property float x",
    "property float y",
    "foo bar 42",
    "end_header",
  ]);
  const b = Buffer.alloc(8);
  b.writeFloatLE(1, 0);
  b.writeFloatLE(2, 4);
  W("unknown_kw.ply", Buffer.concat([Buffer.from(header, "utf8"), b]));
}

// ---------------------------------------------------------------------------
// weird_props.ply — unnamed properties and malformed `property list` lines
// (regression fixture: these must render as "?" placeholders, never as the
// literal text "null"; decodeRow stops at the first malformed list).
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment unnamed + malformed list props (rendering regression fixture)",
    "element vertex 2",
    "property float",
    "property float x",
    "property list",
    "property list uchar",
    "element face 1",
    "property float",
    "property list",
    "end_header",
  ]);
  const b = Buffer.alloc(1024); // body zeros; first vertex decodes 2 floats, then stops
  W("weird_props.ply", Buffer.concat([Buffer.from(header, "utf8"), b]));
}

// ---------------------------------------------------------------------------
// header_at_boundary.ply — 'end_header' starts at exactly byte 65536, i.e.
// precisely at the first reader-window edge (PLAN §6): parsing the first
// 64 KB must fail with UNTERMINATED, parsing the whole file must succeed.
// ---------------------------------------------------------------------------
{
  const pre = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "element vertex 1",
    "property float x",
  ]);
  const target = 65536;
  const tail = "end_header\n";
  // 'end_header' must START at byte `target`, so pre + filler == target
  // (tail comes after and does not count).
  const fillerLen = target - Buffer.byteLength(pre, "utf8");
  if (fillerLen < 10) throw new Error("filler too small");
  const filler = `comment ${"A".repeat(fillerLen - 9)}\n`; // "comment " + filler + "\n"
  const head = pre + filler + tail;
  const at = Buffer.byteLength(head.slice(0, -tail.length), "utf8");
  if (at !== target) throw new Error(`end_header starts at ${at}, expected ${target}`);
  const b = Buffer.alloc(4);
  b.writeFloatLE(9.5, 0);
  W("header_at_boundary.ply", Buffer.concat([Buffer.from(head, "utf8"), b]));
}

// ---------------------------------------------------------------------------
// truncated_body.ply — valid binary header claims 3 rows, body has 2
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment body is one row short — size check must flag truncation",
    "element vertex 3",
    "property float x",
    "end_header",
  ]);
  const b = Buffer.alloc(2 * 4); // only 2 of 3 rows
  b.writeFloatLE(1, 0);
  b.writeFloatLE(2, 4);
  W("truncated_body.ply", Buffer.concat([Buffer.from(header, "utf8"), b]));
}

// ---------------------------------------------------------------------------
// tail_midrow.ply — header claims 2 rows, body ends MID-ROW: one full row
// (4 B) + 2 stray bytes. The tail check must flag "truncated-row"
// (2 available of 4 needed); the size check independently flags truncation.
// ---------------------------------------------------------------------------
{
  const header = headerOf([
    "ply",
    "format binary_little_endian 1.0",
    "comment body ends mid-row — tail check must flag truncated-row",
    "element vertex 2",
    "property float x",
    "end_header",
  ]);
  const b = Buffer.alloc(6); // 1 full row (4 B) + 2 stray bytes
  b.writeFloatLE(1, 0);
  b.writeUInt8(0x3f, 4);
  b.writeUInt8(0x08, 5);
  W("tail_midrow.ply", Buffer.concat([Buffer.from(header, "utf8"), b]));
}

// Clean up the M0 placeholder.
rmSync(join(outDir, "placeholder.ply"), { force: true });

console.log("fixture generation complete");
