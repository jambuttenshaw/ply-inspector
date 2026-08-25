#!/usr/bin/env node
// PLY Inspector test harness (PLAN.md §6).
//
// Strategy: no build step, so execute the literal <script> block of index.html
// inside a Node vm context (no DOM — the DOM guard in the script makes this
// safe), grab globalThis.PLYInspector, and run assertions on real fixtures.
// Zero npm dependencies. Node >= 18.
//
// Run:  node test/run-tests.mjs
// (generate fixtures first:  node scripts/make-fixtures.mjs)

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// loader: extract the inline <script> and execute it in a DOM-less context
// ---------------------------------------------------------------------------
function extractInlineScript(html) {
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, tag, body] of blocks) {
    if (/\bsrc\s*=/.test(tag)) continue; // skip external scripts
    return body;
  }
  throw new Error("no inline <script> block found in index.html");
}

function loadInspector() {
  const html = readFileSync(join(root, "index.html"), "utf8");
  const code = extractInlineScript(html);
  // The vm context has ECMAScript builtins (Uint8Array, DataView, …) but not
  // Web/Node globals — provide what the core needs.
  const sandbox = { console, TextDecoder, TextEncoder };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: "index.html<script>" });
  return ctx.PLYInspector;
}

// ---------------------------------------------------------------------------
// tiny test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}
function assertEq(actual, expected, msg) {
  if (actual !== expected)
    throw new Error(`${msg ?? "value"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertDeepEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "deep"}: expected ${e}, got ${a}`);
}
function assertThrows(fn, code, msgPart) {
  try {
    fn();
  } catch (e) {
    if (code && e.code !== code)
      throw new Error(`wrong error code: expected ${code}, got ${e.code} (${e.message})`);
    if (msgPart && !String(e.message).includes(msgPart))
      throw new Error(`error message ${JSON.stringify(e.message)} missing ${JSON.stringify(msgPart)}`);
    return e;
  }
  throw new Error(`expected throw${code ? ` (code ${code})` : ""}, but none was thrown`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------
const fxPath = (name) => join(root, "test", "fixtures", name);
function fx(name) {
  const p = fxPath(name);
  if (!existsSync(p)) throw new Error(`missing fixture ${name} — run: node scripts/make-fixtures.mjs`);
  return readFileSync(p); // Node Buffer (a Uint8Array subclass)
}

const P = loadInspector();

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------
test("exports: PLYInspector surface is complete", () => {
  assertEq(P.version, undefined, "no version pin in v1 core (kept dynamic)");
  for (const k of ["TYPES", "SIGNATURES", "parseHeader", "expectedSize", "sizeCheck", "detect3DGS", "decodeRow", "rowJumpInfo", "tailCheckInfo", "decodeRowAt"])
    assert(P[k], `missing export: ${k}`);
  assertEq(Object.keys(P.TYPES).length, 16, "16 type tokens");
  assertEq(P.TYPES.float.normalized, "float32");
  assertEq(P.TYPES.uint.bytes, 4);
});

// ---------------------------------------------------------------------------
// 3dgs_standard.ply
// ---------------------------------------------------------------------------
test("3dgs_standard: 59 float32 properties, 236 B/vertex, offsets 0..232", () => {
  const h = P.parseHeader(fx("3dgs_standard.ply"));
  assertEq(h.format.kind, "binary_little_endian");
  assertEq(h.format.version, "1.0");
  assertEq(h.elements.length, 1);
  const v = h.elements[0];
  assertEq(v.name, "vertex");
  assertEq(v.count, 3);
  assertEq(v.properties.length, 59);
  for (const p of v.properties) assertEq(p.normalized, "float32", `prop ${p.name} type`);
  assertEq(v.properties[3].name, "f_dc_0");
  assertEq(v.properties[6].name, "f_rest_0");
  assertEq(v.properties[50].name, "f_rest_44");
  assertEq(v.properties[51].name, "opacity");
  assertEq(v.properties[58].name, "rot_3");
  let off = 0;
  for (const p of v.properties) { off += p.bytes; }
  assertEq(off, 236, "bytes/vertex");
  assert(h.warnings.length === 0, `unexpected warnings: ${h.warnings.length}`);
});

test("3dgs_standard: expected size matches actual file size (exact)", () => {
  const buf = fx("3dgs_standard.ply");
  const h = P.parseHeader(buf);
  const e = P.expectedSize(h.elements, h.headerByteLength, h.format.kind);
  assertEq(e.exact, true, "exact");
  assertEq(e.variable, false);
  assertEq(e.expectedTotal, buf.length, "expected total == file size");
  assertEq(e.bytesPerElement["vertex"].fixed, 236);
  assertEq(P.sizeCheck(e, buf.length).status, "match");
});

test("3dgs_standard: 3DGS badge, complete required families, normal optional absent", () => {
  const h = P.parseHeader(fx("3dgs_standard.ply"));
  const s = P.detect3DGS(h.elements);
  assertEq(s.badge, "standard");
  assertEq(s.isStandard, true);
  assertEq(s.matched, 59);
  assertEq(s.total, 59);
  assertEq(s.optionalMatched, 0);
  assertEq(s.optionalTotal, 5, "optional: normal 3 + material 2");
  assertEq(s.extras.length, 0);
  const required = s.families.filter((f) => !f.optional);
  assertEq(required.length, 6);
  for (const f of required) assertEq(f.missing.length, 0, `family ${f.key}`);
  const normal = s.families.find((f) => f.key === "normal");
  assertEq(normal.optional, true);
  assertEq(normal.missing.length, 3, "absent optionals are reported, not errors");
  const material = s.families.find((f) => f.key === "material");
  assertEq(material.optional, true);
  assertEq(material.missing.length, 2, "absent optionals are reported, not errors");
  assert(!s.familyOf["metallicFactor"], "absent optional not grouped");
  assertEq(s.familyOf["f_rest_44"], "sh_rest");
  assertEq(s.familyOf["rot_3"], "rotation");
  assertEq(s.familyOf["x"], "position");
  assert(!s.familyOf["nx"], "absent optional not grouped");
  assertEq(Object.keys(s.familyOf).length, 59);
});

test("SIGNATURES: two optional families (normal, material); required total stays 59", () => {
  const sig = P.SIGNATURES["3dgs-standard"];
  assertEq(sig.families.length, 8);
  const opt = sig.families.filter((f) => f.optional);
  assertEq(opt.length, 2, "exactly two optional families");
  assertDeepEq(opt[0].props, ["nx", "ny", "nz"]);
  assertDeepEq(opt[1].props, ["metallicFactor", "roughnessFactor"]);
  const requiredProps = sig.families.filter((f) => !f.optional).flatMap((f) => f.props);
  assertEq(requiredProps.length, 59, "59 required props");
  assertEq(new Set(sig.families.flatMap((f) => f.props)).size, 64, "64 distinct signature props (59 + 3 + 2)");
});

test("3dgs_standard: first-row decode (LE float32), rows 0 and 1", () => {
  const buf = fx("3dgs_standard.ply");
  const h = P.parseHeader(buf);
  const body = buf.subarray(h.headerByteLength);
  const r0 = P.decodeRow(body, h.elements[0], false);
  assertEq(r0.complete, true);
  assertEq(r0.values.length, 59);
  assertEq(r0.values[0].value, 0, "row0 x = 0*100+0");
  assertEq(r0.values[3].value, 3, "row0 f_dc_0");
  assertEq(r0.values[50].value, 50, "row0 f_rest_44");
  assertEq(r0.values[58].value, 58, "row0 rot_3");
  assertEq(r0.bytesRead, 236);
  const r1 = P.decodeRow(body.subarray(236), h.elements[0], false);
  assertEq(r1.values[0].value, 100, "row1 x");
  assertEq(r1.values[58].value, 158, "row1 rot_3");
});

// ---------------------------------------------------------------------------
// 3dgs_with_normals.ply — standard 59 + optional normals (62 props)
// ---------------------------------------------------------------------------
test("3dgs_with_normals: 62 props, 248 B/row, standard + optional 3/3, no extras", () => {
  const buf = fx("3dgs_with_normals.ply");
  const h = P.parseHeader(buf);
  const v = h.elements[0];
  assertEq(v.properties.length, 62);
  assertEq(v.properties[3].name, "nx", "INRIA layout: normals after x/y/z");
  const e = P.expectedSize(h.elements, h.headerByteLength, h.format.kind);
  assertEq(e.exact, true);
  assertEq(e.bytesPerElement["vertex"].fixed, 248, "236 + 12 B optional normals");
  assertEq(e.expectedTotal, buf.length, "optional props count toward the exact size");
  assertEq(P.sizeCheck(e, buf.length).status, "match");
  const s = P.detect3DGS(h.elements);
  assertEq(s.badge, "standard");
  assertEq(s.isStandard, true);
  assertEq(s.matched, 59);
  assertEq(s.total, 59, "matched/total stay required-only");
  assertEq(s.optionalMatched, 3);
  assertEq(s.optionalTotal, 5, "optional: normal 3 + material 2");
  assertEq(s.extras.length, 0, "nx/ny/nz are signature props, not extras");
  const normal = s.families.find((f) => f.key === "normal");
  assertDeepEq(normal.found, ["nx", "ny", "nz"]);
  assertEq(normal.missing.length, 0);
  assertEq(s.familyOf["nx"], "normal");
  assertEq(s.familyOf["ny"], "normal");
  assertEq(s.familyOf["nz"], "normal");
  assertEq(Object.keys(s.familyOf).length, 62);
});

test("3dgs_with_normals: first-row decode includes normals (value = r*100 + i)", () => {
  const buf = fx("3dgs_with_normals.ply");
  const h = P.parseHeader(buf);
  const body = buf.subarray(h.headerByteLength);
  const r0 = P.decodeRow(body, h.elements[0], false);
  assertEq(r0.complete, true);
  assertEq(r0.values.length, 62);
  assertEq(r0.values[3].value, 3, "row0 nx");
  assertEq(r0.values[5].value, 5, "row0 nz");
  assertEq(r0.values[61].value, 61, "row0 rot_3 (last)");
  assertEq(r0.bytesRead, 248);
});

// ---------------------------------------------------------------------------
// 3dgs_normals_partial.ply — standard 59 + nx only (1/3 optional)
// ---------------------------------------------------------------------------
test("3dgs_normals_partial: standard + partial optional (1/3), badge stays standard", () => {
  const buf = fx("3dgs_normals_partial.ply");
  const h = P.parseHeader(buf);
  assertEq(h.elements[0].properties.length, 60);
  const s = P.detect3DGS(h.elements);
  assertEq(s.badge, "standard", "optionals never downgrade the standard badge");
  assertEq(s.isStandard, true);
  assertEq(s.matched, 59);
  assertEq(s.optionalMatched, 1);
  assertEq(s.optionalTotal, 5, "optional: normal 3 + material 2");
  assertEq(s.extras.length, 0);
  const normal = s.families.find((f) => f.key === "normal");
  assertDeepEq(normal.found, ["nx"]);
  assertDeepEq(normal.missing, ["ny", "nz"]);
  assertEq(s.familyOf["nx"], "normal");
  assert(!s.familyOf["ny"], "missing optional not grouped");
});

// ---------------------------------------------------------------------------
// 3dgs_missing_rest.ply
// ---------------------------------------------------------------------------
test("3dgs_missing_rest: near-match checklist, no false standard badge", () => {
  const h = P.parseHeader(fx("3dgs_missing_rest.ply"));
  assertEq(h.elements[0].properties.length, 25);
  const s = P.detect3DGS(h.elements);
  assertEq(s.badge, "near");
  assertEq(s.isStandard, false);
  assertEq(s.matched, 25);
  const rest = s.families.find((f) => f.key === "sh_rest");
  assertEq(rest.found.length, 11);
  assertEq(rest.missing.length, 34);
  assertEq(rest.missing[0], "f_rest_11");
  for (const key of ["position", "sh_dc", "opacity", "scale", "rotation"]) {
    const f = s.families.find((x) => x.key === key);
    assertEq(f.missing.length, 0, `family ${key}`);
  }
  assertEq(s.familyOf["f_rest_10"], "sh_rest", "found props still grouped");
  assert(!s.familyOf["f_rest_11"], "missing prop not grouped");
});

// ---------------------------------------------------------------------------
// ascii_mesh.ply
// ---------------------------------------------------------------------------
test("ascii_mesh: ASCII format, list property, size check n/a, no 3DGS badge", () => {
  const buf = fx("ascii_mesh.ply");
  const h = P.parseHeader(buf);
  assertEq(h.format.kind, "ascii");
  assertEq(h.elements.length, 2);
  assertEq(h.elements[0].name, "vertex");
  assertEq(h.elements[0].count, 4);
  assertEq(h.elements[0].properties.length, 9);
  const face = h.elements[1];
  assertEq(face.name, "face");
  assertEq(face.count, 2);
  const lp = face.properties[0];
  assertEq(lp.isList, true);
  assertEq(lp.countType.normalized, "uint8");
  assertEq(lp.itemType.normalized, "int32");
  assertEq(lp.name, "vertex_indices");
  assertEq(lp.rawType, "list uchar int");
  const e = P.expectedSize(h.elements, h.headerByteLength, h.format.kind);
  assertEq(e.formatKind, "ascii");
  assertEq(e.variable, true, "face element has a list property");
  assertEq(e.exact, false, "ascii + list rows => not exact");
  assertEq(P.sizeCheck(e, buf.length).status, "ascii", "ascii takes precedence");
  const s = P.detect3DGS(h.elements);
  assertEq(s.badge, "none", "plain mesh with normals is not a 3DGS candidate — normals do not confer candidacy");
  assertEq(Object.keys(s.familyOf).length, 0);
});

// ---------------------------------------------------------------------------
// big_endian.ply
// ---------------------------------------------------------------------------
test("big_endian: BE decode of double/int/uchar (rows 0 and 1)", () => {
  const buf = fx("big_endian.ply");
  const h = P.parseHeader(buf);
  assertEq(h.format.kind, "binary_big_endian");
  const props = h.elements[0].properties;
  assertEq(props[0].normalized, "float64");
  assertEq(props[1].normalized, "int32");
  assertEq(props[2].normalized, "uint8");
  let rowFixed = 0;
  for (const p of props) rowFixed += p.bytes;
  assertEq(rowFixed, 13, "row size 8+4+1");
  const body = buf.subarray(h.headerByteLength);
  const r0 = P.decodeRow(body, h.elements[0], true);
  assertEq(r0.complete, true);
  assertEq(r0.values[0].value, 3.5, "row0 x");
  assertEq(r0.values[1].value, 42, "row0 count");
  assertEq(r0.values[2].value, 7, "row0 flag");
  const r1 = P.decodeRow(body.subarray(13), h.elements[0], true);
  assertEq(r1.values[0].value, -2.125, "row1 x");
  assertEq(r1.values[1].value, -7, "row1 count");
  assertEq(r1.values[2].value, 255, "row1 flag");
});

// ---------------------------------------------------------------------------
// crlf_comments.ply
// ---------------------------------------------------------------------------
test("crlf_comments: CRLF endings, non-ASCII comment, obj_info, byte-exact body", () => {
  const buf = fx("crlf_comments.ply");
  const h = P.parseHeader(buf);
  assert(h.warnings.length === 0, `unexpected warnings: ${JSON.stringify(h.warnings)}`);
  assertEq(h.comments.length, 1);
  assert(h.comments[0].text.includes("Café"), "non-ASCII comment intact");
  assert(h.comments[0].text.includes("naïve"), "more non-ASCII intact");
  assertEq(h.objInfo.length, 1);
  assert(h.objInfo[0].text.includes("über-splats"), "obj_info intact");
  // multi-byte comment text must not skew headerByteLength: body decodes exactly
  const body = buf.subarray(h.headerByteLength);
  const r = P.decodeRow(body, h.elements[0], false);
  assertEq(r.complete, true);
  assertEq(r.values[0].value, -1.25, "x");
  assertEq(r.values[1].value, 2.5, "y");
  assertEq(r.values[2].value, -3.75, "z");
});

// ---------------------------------------------------------------------------
// bom.ply
// ---------------------------------------------------------------------------
test("bom: UTF-8 BOM before the magic is accepted", () => {
  const h = P.parseHeader(fx("bom.ply"));
  assertEq(h.format.kind, "binary_little_endian");
  assertEq(h.elements[0].name, "vertex");
  assert(h.warnings.length === 0);
});

// ---------------------------------------------------------------------------
// hard errors
// ---------------------------------------------------------------------------
test("bad_magic: hard error with offending line", () => {
  const e = assertThrows(() => P.parseHeader(fx("bad_magic.ply")), "MAGIC", "not a PLY");
  assertEq(e.line, 1);
  assertEq(e.raw, "gibberish not ply");
});

test("no_end_header: hard error UNTERMINATED", () => {
  assertThrows(() => P.parseHeader(fx("no_end_header.ply")), "UNTERMINATED", "end_header");
});

test("bad_format: unsupported version is a hard error showing the line", () => {
  const e = assertThrows(() => P.parseHeader(fx("bad_format.ply")), "FORMAT", "2.0");
  assert(e.raw.includes("format binary_little_endian 2.0"), "raw line preserved");
});

// ---------------------------------------------------------------------------
// leniency
// ---------------------------------------------------------------------------
test("unknown_kw: warning only, parsing continues", () => {
  const h = P.parseHeader(fx("unknown_kw.ply"));
  assert(h.warnings.length >= 1, "at least one warning");
  assert(h.warnings.some((w) => w.message.includes("foo")), "unknown keyword warned");
  assertEq(h.elements.length, 1);
  assertEq(h.elements[0].properties.length, 2);
  assertEq(h.format.kind, "binary_little_endian");
});

test("weird_props: unnamed + malformed list props warn and keep parsing", () => {
  const buf = fx("weird_props.ply");
  const h = P.parseHeader(buf);
  assertEq(h.elements.length, 2);
  const v = h.elements[0];
  assertEq(v.properties.length, 4);
  assertEq(v.properties[0].name, null, "unnamed property");
  assertEq(v.properties[0].normalized, "float32");
  const badList = v.properties[2];
  assertEq(badList.isList, true);
  assertEq(badList.countTypeRaw, null);
  assertEq(badList.itemTypeRaw, null);
  assertEq(badList.name, null);
  assertEq(badList.fixedBytes, 0);
  assertEq(badList.unknown, true);
  assert(h.warnings.some((w) => w.message.includes("without a name")));
  assert(h.warnings.some((w) => w.message.includes("malformed list")));
  // decodeRow keeps values before the first malformed list, then stops
  const body = buf.subarray(h.headerByteLength);
  const r = P.decodeRow(body, v, false);
  assertEq(r.complete, false);
  assertEq(r.values.length, 2, "two floats decoded before the bad list");
  assertEq(r.values[0].name, null);
  assertEq(r.values[1].name, "x");
});

test("properties carry the verbatim rawLine (null-safe click-to-copy)", () => {
  const h = P.parseHeader(fx("weird_props.ply"));
  assertEq(h.elements[0].properties[0].rawLine, "property float");
  assertEq(h.elements[0].properties[1].rawLine, "property float x");
  assertEq(h.elements[0].properties[2].rawLine, "property list");
  assertEq(h.elements[0].properties[3].rawLine, "property list uchar");
  assertEq(h.elements[1].properties[0].rawLine, "property float");
  assertEq(h.elements[1].properties[1].rawLine, "property list");
  const std = P.parseHeader(fx("3dgs_standard.ply"));
  assertEq(std.elements[0].properties[58].rawLine, "property float rot_3");
});

test("header_at_boundary: end_header at first-window edge needs window growth", () => {
  const buf = fx("header_at_boundary.ply");
  // first 64 KB window: end_header not yet visible -> UNTERMINATED
  assertThrows(() => P.parseHeader(buf.subarray(0, 65536)), "UNTERMINATED");
  // whole file: fine, and headerByteLength is byte-exact
  const h = P.parseHeader(buf);
  assertEq(h.headerByteLength, 65536 + 11);
  assert(h.warnings.length === 0);
  const body = buf.subarray(h.headerByteLength);
  assertEq(P.decodeRow(body, h.elements[0], false).values[0].value, 9.5);
});

test("truncated_body: size check flags truncation", () => {
  const buf = fx("truncated_body.ply");
  const h = P.parseHeader(buf);
  const e = P.expectedSize(h.elements, h.headerByteLength, h.format.kind);
  assertEq(e.exact, true);
  const c = P.sizeCheck(e, buf.length);
  assertEq(c.status, "truncated");
  assert(c.expectedTotal > buf.length, "expected larger than actual");
});

// ---------------------------------------------------------------------------
// decodeRow: list properties (LE/BE), truncation, empty input
// ---------------------------------------------------------------------------
function listElement() {
  return {
    name: "edge", count: 2,
    properties: [{
      name: "vertices", isList: true,
      rawType: "list uchar int",
      countTypeRaw: "uchar", itemTypeRaw: "int",
      countType: P.TYPES.uchar, itemType: P.TYPES.int,
      normalized: "list uint8 int32",
      bytes: 0, fixedBytes: 1, unknown: false,
    }],
  };
}

test("decodeRow: list counts decode (LE and BE)", () => {
  const le = new Uint8Array([3, 10, 0, 0, 0, 20, 0, 0, 0, 30, 0, 0, 0]);
  const r = P.decodeRow(le, listElement(), false);
  assertEq(r.complete, true);
  assertDeepEq(r.values[0].value, [10, 20, 30]);
  const be = new Uint8Array([3, 0, 0, 0, 10, 0, 0, 0, 20, 0, 0, 0, 30]);
  const rb = P.decodeRow(be, listElement(), true);
  assertEq(rb.complete, true);
  assertDeepEq(rb.values[0].value, [10, 20, 30]);
  // zero-length list: only the count prefix
  const z = new Uint8Array([0]);
  const rz = P.decodeRow(z, listElement(), false);
  assertEq(rz.complete, true);
  assertDeepEq(rz.values[0].value, []);
});

test("decodeRow: truncation (short list / short row / empty buffer)", () => {
  const short = new Uint8Array([3, 10, 0, 0, 0, 20, 0]); // list cut mid-items
  const rt = P.decodeRow(short, listElement(), false);
  assertEq(rt.complete, false);
  assertEq(rt.values[0].value.length, 1, "partial items kept");
  const noCount = new Uint8Array([1, 2]); // not even a full count prefix? uchar is 1B -> actually fits
  const rnc = P.decodeRow(noCount, listElement(), false);
  assertEq(rnc.complete, false, "count 1 needs 4 more bytes, not available");
  const empty = new Uint8Array(0);
  const re = P.decodeRow(empty, listElement(), false);
  assertEq(re.complete, false);
  assertEq(re.values.length, 0);
});

// ---------------------------------------------------------------------------
// row-N preview & tail check
// ---------------------------------------------------------------------------
test("rowJumpInfo: standard 3DGS vertex is jumpable (236 B/row)", () => {
  const h = P.parseHeader(fx("3dgs_standard.ply"));
  const j = P.rowJumpInfo(h.elements[0]);
  assertEq(j.jumpable, true);
  assertEq(j.rowBytes, 236);
  assertEq(j.reason, null);
});

test("rowJumpInfo: list properties are not jumpable; sibling element unaffected", () => {
  const h = P.parseHeader(fx("ascii_mesh.ply"));
  const face = P.rowJumpInfo(h.elements[1]);
  assertEq(face.jumpable, false);
  assertEq(face.reason, "variable-length rows");
  assertEq(P.rowJumpInfo(h.elements[0]).jumpable, true, "vertex element of same file (no lists) IS jumpable");
});

test("rowJumpInfo: unknown types and bad counts are not jumpable", () => {
  const weird = P.rowJumpInfo(P.parseHeader(fx("weird_props.ply")).elements[0]);
  assertEq(weird.jumpable, false);
  assertEq(weird.reason, "variable-length rows", "list check precedes unknown check");
  const hdr = Buffer.from(
    "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty quantum x\nend_header\n", "utf8");
  const j2 = P.rowJumpInfo(P.parseHeader(hdr).elements[0]);
  assertEq(j2.jumpable, false);
  assertEq(j2.reason, "unknown property types");
  const prop = { name: "x", isList: false, type: P.TYPES.float, normalized: "float32", bytes: 4, fixedBytes: 4, unknown: false };
  assertEq(P.rowJumpInfo({ name: "v", count: 0, properties: [prop] }).reason, "no rows");
  assertEq(P.rowJumpInfo({ name: "v", count: -2, properties: [prop] }).reason, "no rows");
  assertEq(P.rowJumpInfo({ name: "v", count: NaN, properties: [prop] }).reason, "non-finite count");
});

test("rowJumpInfo: big-endian rows jump with the BE row size", () => {
  const h = P.parseHeader(fx("big_endian.ply"));
  const j = P.rowJumpInfo(h.elements[0]);
  assertEq(j.jumpable, true);
  assertEq(j.rowBytes, 13);
});

test("tailCheckInfo: exact file -> ok, with exact last-row offset", () => {
  const buf = fx("3dgs_standard.ply");
  const h = P.parseHeader(buf);
  const el = h.elements[0];
  const j = P.rowJumpInfo(el);
  const t = P.tailCheckInfo(j.rowBytes, el.count, buf.length, h.headerByteLength);
  assertEq(t.status, "ok");
  assertEq(t.offset, h.headerByteLength + 2 * 236, "last of 3 rows");
  assertEq(t.available, 236);
  assertEq(t.need, 236);
});

test("tailCheckInfo: truncated_body (last row entirely absent) -> missing", () => {
  const buf = fx("truncated_body.ply");
  const h = P.parseHeader(buf);
  const el = h.elements[0];
  const j = P.rowJumpInfo(el);
  const t = P.tailCheckInfo(j.rowBytes, el.count, buf.length, h.headerByteLength);
  assertEq(t.status, "missing");
  assertEq(t.available, 0);
  assertEq(t.need, 4);
});

test("tailCheckInfo: tail_midrow (body ends mid-row) -> truncated-row", () => {
  const buf = fx("tail_midrow.ply");
  const h = P.parseHeader(buf);
  const el = h.elements[0];
  const j = P.rowJumpInfo(el);
  const t = P.tailCheckInfo(j.rowBytes, el.count, buf.length, h.headerByteLength);
  assertEq(t.status, "truncated-row");
  assertEq(t.available, 2, "2 stray bytes present");
  assertEq(t.need, 4);
});

test("last-row decode: row 2 of 3dgs_standard decodes exactly (value = r*100 + i)", () => {
  const buf = fx("3dgs_standard.ply");
  const h = P.parseHeader(buf);
  const body = buf.subarray(h.headerByteLength);
  const j = P.rowJumpInfo(h.elements[0]);
  const r = P.decodeRow(body.subarray(2 * j.rowBytes), h.elements[0], false);
  assertEq(r.complete, true);
  assertEq(r.values[0].value, 200, "row2 x");
  assertEq(r.values[58].value, 258, "row2 rot_3");
  assertEq(r.bytesRead, 236);
});

test("last-row decode on tail_midrow: partial row is incomplete, decodes nothing", () => {
  const buf = fx("tail_midrow.ply");
  const h = P.parseHeader(buf);
  const body = buf.subarray(h.headerByteLength);
  const r = P.decodeRow(body.subarray(4), h.elements[0], false);
  assertEq(r.complete, false);
  assertEq(r.values.length, 0, "2 bytes is not even one float32");
});

// ---------------------------------------------------------------------------
// expectedSize / sizeCheck edge cases
// ---------------------------------------------------------------------------
test("expectedSize: variable-length rows -> no exact total, lower bound kept", () => {
  const elements = [{
    name: "face", count: 10,
    properties: [
      { name: "a", isList: false, type: P.TYPES.int, normalized: "int32", bytes: 4, fixedBytes: 4, unknown: false },
      { name: "vi", isList: true, countType: P.TYPES.uchar, itemType: P.TYPES.int, bytes: 0, fixedBytes: 1, unknown: false },
    ],
  }];
  const e = P.expectedSize(elements, 100, "binary_little_endian");
  assertEq(e.variable, true);
  assertEq(e.exact, false);
  assertEq(e.fixedBytes, 10 * 5, "fixed part only (4 + count prefix 1)");
  assertEq(e.expectedTotal, 100 + 50, "lower bound");
  const c = P.sizeCheck(e, 12345);
  assertEq(c.status, "variable");
});

test("sizeCheck: match / truncated / larger / unknown-count", () => {
  const mk = (count) => [{
    name: "vertex", count,
    properties: [{ name: "x", isList: false, type: P.TYPES.float, normalized: "float32", bytes: 4, fixedBytes: 4, unknown: false }],
  }];
  const e = P.expectedSize(mk(2), 10, "binary_little_endian");
  assertEq(e.exact, true);
  assertEq(e.expectedTotal, 18);
  assertEq(P.sizeCheck(e, 18).status, "match");
  assertEq(P.sizeCheck(e, 9).status, "truncated");
  assertEq(P.sizeCheck(e, 30).status, "larger");
  const e2 = P.expectedSize(mk(NaN), 10, "binary_little_endian");
  assertEq(P.sizeCheck(e2, 100).status, "unknown-count");
});

// ---------------------------------------------------------------------------
// header edge cases (synthetic headers)
// ---------------------------------------------------------------------------
test("duplicate element names are kept and indexed (face / face #2)", () => {
  const hdr = Buffer.from(
    "ply\nformat ascii 1.0\nelement face 2\nproperty int a\nelement face 3\nproperty int b\nend_header\n",
    "utf8");
  const h = P.parseHeader(hdr);
  assertEq(h.elements.length, 2);
  assertDeepEq(h.elementDisplay, ["face", "face #2"]);
  const e = P.expectedSize(h.elements, h.headerByteLength, "ascii");
  assertEq(e.bytesPerElement["face"].fixed, 4);
  assertEq(e.bytesPerElement["face #2"].fixed, 4);
  assertEq(e.fixedBytes, 2 * 4 + 3 * 4, "both occurrences count");
});

test("unknown property type: warning + '?' + 0 bytes", () => {
  const hdr = Buffer.from(
    "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty quantum x\nend_header\n",
    "utf8");
  const h = P.parseHeader(hdr);
  const p = h.elements[0].properties[0];
  assertEq(p.normalized, "?");
  assertEq(p.fixedBytes, 0);
  assertEq(p.unknown, true);
  assert(h.warnings.some((w) => w.message.includes("quantum")), "warning names the bad token");
});

test("property before any element: warning + dropped", () => {
  const hdr = Buffer.from(
    "ply\nformat ascii 1.0\nproperty float x\nend_header\n",
    "utf8");
  const h = P.parseHeader(hdr);
  assertEq(h.elements.length, 0);
  assert(h.warnings.some((w) => w.message.includes("dropped")));
});

test("negative element count: warning, parse continues", () => {
  const hdr = Buffer.from(
    "ply\nformat ascii 1.0\nelement vertex -3\nproperty float x\nend_header\n",
    "utf8");
  const h = P.parseHeader(hdr);
  assertEq(h.elements[0].count, -3);
  assert(h.warnings.some((w) => w.message.includes("negative")));
});

test("empty input: hard error", () => {
  assertThrows(() => P.parseHeader(new Uint8Array(0)), "MAGIC", "empty");
});

test("CRLF-only file (no trailing newline after end_header)", () => {
  const hdr = Buffer.from("ply\r\nformat ascii 1.0\r\nelement vertex 1\r\nproperty float x\r\nend_header", "utf8");
  const h = P.parseHeader(hdr);
  assertEq(h.format.kind, "ascii");
  assertEq(h.elements[0].count, 1);
  assertEq(h.headerByteLength, hdr.length, "body starts at EOF when no newline follows");
  assert(h.warnings.length === 0);
});

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(` - ${f.name}: ${f.err.message}`);
  process.exitCode = 1;
}
