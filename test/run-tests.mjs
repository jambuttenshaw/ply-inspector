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
const queued = [];
// Test bodies may be async (the M8 stream tests await chunk reads); the queue
// is drained with top-level await right before the summary below, in
// registration order — output order is unchanged.
function test(name, fn) {
  queued.push({ name, fn });
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
  for (const k of ["TYPES", "SIGNATURES", "FEATURES", "parseHeader", "expectedSize", "sizeCheck", "detect3DGS", "detectRelighting", "decodeRow", "rowJumpInfo", "tailCheckInfo", "decodeRowAt",
    "propertyGroups", "projectRow", "rowBounds", "subsetHeader", "subsetPlan", "streamSubset", "coalesceParts"])
    assert(P[k], `missing export: ${k}`);
  assertDeepEq(P.FEATURES.relighting.requires, ["normal", "material"], "M7 capability table");
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
// Relighting (M7) — detectRelighting
// ---------------------------------------------------------------------------
test("3dgs_relightable: 64 props, 256 B/vertex, standard badge + relighting 5/5", () => {
  const buf = fx("3dgs_relightable.ply");
  const h = P.parseHeader(buf);
  const v = h.elements[0];
  assertEq(v.properties.length, 64);
  assertEq(v.properties[62].name, "metallicFactor", "material factors at the end");
  assertEq(v.properties[63].name, "roughnessFactor");
  const e = P.expectedSize(h.elements, h.headerByteLength, h.format.kind);
  assertEq(e.exact, true);
  assertEq(e.bytesPerElement["vertex"].fixed, 256, "236 + 12 normals + 8 material");
  assertEq(P.sizeCheck(e, buf.length).status, "match");
  const s = P.detect3DGS(h.elements);
  assertEq(s.badge, "standard", "material props do not affect the standard badge");
  assertEq(s.matched, 59, "required matched/total untouched");
  assertEq(s.optionalMatched, 5, "all optionals present");
  const r = P.detectRelighting(h.elements);
  assertEq(r.label, "Relighting required");
  assertEq(r.supported, true);
  assertEq(r.verdict, "supported");
  assertEq(r.matched, 5);
  assertEq(r.total, 5);
  assertDeepEq(r.missing, []);
  assertEq(r.groups.length, 2);
  assertEq(r.groups[0].key, "normal");
  assertEq(r.groups[1].key, "material", "group order follows FEATURES.relighting.requires");
  for (const g of r.groups) assertEq(g.complete, true, `group ${g.key} complete`);
});

test("3dgs_relightable: first-row decode (value = r*100 + i, 256 B/row)", () => {
  const buf = fx("3dgs_relightable.ply");
  const h = P.parseHeader(buf);
  const body = buf.subarray(h.headerByteLength);
  const r0 = P.decodeRow(body, h.elements[0], false);
  assertEq(r0.complete, true);
  assertEq(r0.values.length, 64);
  assertEq(r0.values[3].value, 3, "row0 nx");
  assertEq(r0.values[62].value, 62, "row0 metallicFactor");
  assertEq(r0.values[63].value, 63, "row0 roughnessFactor");
  assertEq(r0.bytesRead, 256);
  const r1 = P.decodeRow(body.subarray(256), h.elements[0], false);
  assertEq(r1.values[63].value, 163, "row1 roughnessFactor");
});

test("3dgs_standard: relighting not supported (0/5), all five props listed missing", () => {
  const h = P.parseHeader(fx("3dgs_standard.ply"));
  const r = P.detectRelighting(h.elements);
  assertEq(r.supported, false);
  assertEq(r.verdict, "not supported");
  assertEq(r.matched, 0);
  assertEq(r.total, 5);
  assertDeepEq(r.missing, ["nx", "ny", "nz", "metallicFactor", "roughnessFactor"]);
  for (const g of r.groups) assertEq(g.complete, false);
});

test("3dgs_with_normals: relighting partial (3/5), material group is the gap", () => {
  const h = P.parseHeader(fx("3dgs_with_normals.ply"));
  const r = P.detectRelighting(h.elements);
  assertEq(r.verdict, "partial");
  assertEq(r.matched, 3);
  assertDeepEq(r.groups[0].found, ["nx", "ny", "nz"]);
  assertEq(r.groups[0].complete, true);
  assertDeepEq(r.groups[1].missing, ["metallicFactor", "roughnessFactor"]);
  assertDeepEq(r.missing, ["metallicFactor", "roughnessFactor"]);
});

test("ascii_mesh: badge none, but core reports partial (3/5) — core-vs-UI split", () => {
  const h = P.parseHeader(fx("ascii_mesh.ply"));
  assertEq(P.detect3DGS(h.elements).badge, "none", "render layer: no verdict for non-candidates");
  const r = P.detectRelighting(h.elements);
  assertEq(r.verdict, "partial", "core has no candidacy gate");
  assertEq(r.matched, 3);
  assertDeepEq(r.missing, ["metallicFactor", "roughnessFactor"]);
});

test("ascii_relightable_mesh: badge none + core relighting supported (5/5)", () => {
  const h = P.parseHeader(fx("ascii_relightable_mesh.ply"));
  assertEq(h.format.kind, "ascii");
  assertEq(P.detect3DGS(h.elements).badge, "none", "no SH props -> not a 3DGS candidate");
  const r = P.detectRelighting(h.elements);
  assertEq(r.supported, true);
  assertEq(r.verdict, "supported");
  assertEq(r.matched, 5);
});

test("detectRelighting: no vertex element -> null; first of multiple vertex elements wins", () => {
  assertEq(P.detectRelighting([{ name: "face", count: 1, properties: [{ name: "nx" }] }]), null, "no vertex element -> no verdict");
  const mk = (names) => ({ name: "vertex", count: 1, properties: names.map((n) => ({ name: n })) });
  const two = [
    mk(["nx", "ny", "nz", "metallicFactor", "roughnessFactor"]),
    { name: "face", count: 1, properties: [] },
    mk(["x", "y", "z"]), // second vertex has nothing — must be ignored
  ];
  const r = P.detectRelighting(two);
  assertEq(r.verdict, "supported", "first vertex element is used, same convention as the signature");
  assertEq(r.matched, 5);
});

test("detectRelighting: name-based only — int-typed factors still count in v1", () => {
  const v = { name: "vertex", count: 1, properties: [
    { name: "nx", type: P.TYPES.int }, { name: "ny", type: P.TYPES.int }, { name: "nz", type: P.TYPES.int },
    { name: "metallicFactor", type: P.TYPES.int }, { name: "roughnessFactor", type: P.TYPES.int },
  ]};
  const r = P.detectRelighting([v]);
  assertEq(r.verdict, "supported", "property types are not checked in v1");
});

// ---------------------------------------------------------------------------
// Property aliases (M7.3) — metallic / roughness
// ---------------------------------------------------------------------------
test("SIGNATURES: material family declares aliases; no other family does (M7.3)", () => {
  const sig = P.SIGNATURES["3dgs-standard"];
  const material = sig.families.find((f) => f.key === "material");
  assertDeepEq(material.aliases, { metallicFactor: ["metallic"], roughnessFactor: ["roughness"] });
  for (const f of sig.families)
    if (f.key !== "material") assert(!f.aliases, `family ${f.key} has no aliases`);
});

test("3dgs_relightable_alias: standard badge + relighting 5/5 via aliases (M7.3)", () => {
  const buf = fx("3dgs_relightable_alias.ply");
  const h = P.parseHeader(buf);
  const v = h.elements[0];
  assertEq(v.properties.length, 64);
  assertEq(v.properties[62].name, "metallic", "alias names at the end");
  assertEq(v.properties[63].name, "roughness");
  assertEq(P.sizeCheck(P.expectedSize(h.elements, h.headerByteLength, h.format.kind), buf.length).status, "match");
  const s = P.detect3DGS(h.elements);
  assertEq(s.badge, "standard", "aliases do not affect the standard badge");
  assertEq(s.matched, 59, "required matched/total untouched");
  assertEq(s.optionalMatched, 5, "aliases satisfy the optional material props");
  assertEq(s.extras.length, 0, "alias names are signature props, not extras");
  assertEq(s.familyOf["metallic"], "material", "Group column resolves the alias");
  assertEq(s.familyOf["roughness"], "material");
  assert(!s.familyOf["metallicFactor"], "canonical name not in the file -> not grouped");
  assertEq(Object.keys(s.familyOf).length, 64);
  const r = P.detectRelighting(h.elements);
  assertEq(r.verdict, "supported");
  assertEq(r.matched, 5);
  assertEq(r.total, 5);
  assertDeepEq(r.missing, []);
  assertDeepEq(r.groups[1].found, ["metallic", "roughness"], "found records the file's actual names");
  assertDeepEq(r.groups[1].via, { metallic: "metallicFactor", roughness: "roughnessFactor" });
  assertDeepEq(r.groups[0].via, {}, "no aliases on the normal group");
  assertEq(r.groups[1].complete, true);
});

test("aliases: partial — only the metallic alias satisfies one of two material props (M7.3)", () => {
  const mk = (names) => ({ name: "vertex", count: 1, properties: names.map((n) => ({ name: n })) });
  const r = P.detectRelighting([mk(["nx", "ny", "nz", "metallic"])]);
  assertEq(r.verdict, "partial");
  assertEq(r.matched, 4);
  assertDeepEq(r.groups[1].found, ["metallic"]);
  assertDeepEq(r.groups[1].missing, ["roughnessFactor"], "missing keeps the canonical name");
  assertDeepEq(r.groups[1].via, { metallic: "metallicFactor" });
});

test("aliases: canonical wins when both present; alias name is not an extra (M7.3)", () => {
  const mk = (names) => ({ name: "vertex", count: 1, properties: names.map((n) => ({ name: n })) });
  const el = mk(["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2",
    "nx", "ny", "nz",
    "metallicFactor", "metallic", "roughnessFactor", "roughness"]);
  const s = P.detect3DGS([el]);
  assertEq(s.badge, "near");
  assertEq(s.extras.length, 0, "both spellings are signature props, not extras");
  assertEq(s.familyOf["metallicFactor"], "material", "canonical row grouped");
  assertEq(s.familyOf["metallic"], "material", "redundant alias row also grouped");
  const r = P.detectRelighting([el]);
  assertEq(r.verdict, "supported");
  assertDeepEq(r.groups[1].found, ["metallicFactor", "roughnessFactor"], "canonical preferred in found");
  assertDeepEq(r.groups[1].via, {}, "no via entry when the canonical name is present");
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
// M8: subset download core (PLAN §12)
// ---------------------------------------------------------------------------
// streamSubset glue: the browser uses file.slice(); tests feed Buffer views.
const readChunks = (buf) => async (start, end) => buf.subarray(start, Math.min(end, buf.length));
const allKeep = (h) => h.elements.map((el) => el.properties.map(() => true));
function coalesce(chunks) {
  if (chunks.length === 0) return "";
  if (typeof chunks[0] === "string") return chunks.join(""); // ASCII
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

test("M8 groups: 3dgs_standard vertex -> 6 chips in declaration order, 236 B/row", () => {
  const h = P.parseHeader(fx("3dgs_standard.ply"));
  const g = P.propertyGroups(h.elements[0]);
  assertEq(g.length, 6, "chip count");
  assertDeepEq(g.map((x) => x.label), ["x, y, z", "f_dc", "f_rest", "opacity", "scale", "rot"], "labels");
  assertDeepEq(g.map((x) => x.kind), ["axis", "indexed", "indexed", "single", "indexed", "indexed"], "kinds");
  assertEq(g[2].members.length, 45, "f_rest has 45 members");
  assertEq(g[2].sublabel, "f_rest_0 … f_rest_44", "sublabel spans actual members");
  assertEq(g[4].members.length, 3, "scale has 3 members");
  assertEq(g[5].members.length, 4, "rot has 4 members");
  assertEq(g.reduce((s, x) => s + x.bytesPerRow, 0), 236, "group bytes sum to the row size");
  assertDeepEq(g.flatMap((x) => x.members).sort((a, b) => a - b),
    Array.from({ length: 59 }, (_, i) => i), "members are a disjoint cover of all 59 properties");
});

test("M8 groups: with_normals 7 chips, relightable 9, missing_rest f_rest has 11", () => {
  const n = P.propertyGroups(P.parseHeader(fx("3dgs_with_normals.ply")).elements[0]);
  assertEq(n.length, 7, "with_normals chip count");
  const ax = n.find((x) => x.kind === "axis" && x.label === "nx, ny, nz");
  assert(ax, "n axis group present");
  assertEq(ax.bytesPerRow, 12, "normal = 3 floats");
  assertEq(n.reduce((s, x) => s + x.bytesPerRow, 0), 248, "row bytes");
  const r = P.propertyGroups(P.parseHeader(fx("3dgs_relightable.ply")).elements[0]);
  assertEq(r.length, 9, "relightable chip count");
  assertDeepEq(r.map((x) => x.label).slice(-2), ["metallicFactor", "roughnessFactor"], "material singles at the end");
  const m = P.propertyGroups(P.parseHeader(fx("3dgs_missing_rest.ply")).elements[0]);
  const fr = m.find((x) => x.label === "f_rest");
  assert(fr, "f_rest group present");
  assertEq(fr.members.length, 11, "hole-tolerant member count");
  assertEq(fr.sublabel, "f_rest_0 … f_rest_10", "sublabel reflects actual span");
  assertEq(m.reduce((s, x) => s + x.bytesPerRow, 0), 100, "25 floats");
});

test("M8 groups: ascii_mesh vertex -> 5 chips; face -> 1 list single (1 B fixed part)", () => {
  const h = P.parseHeader(fx("ascii_mesh.ply"));
  const v = P.propertyGroups(h.elements[0]);
  assertEq(v.length, 5, "vertex chip count");
  assertDeepEq(v.map((x) => x.label), ["x, y, z", "nx, ny, nz", "red", "green", "blue"], "labels");
  assertDeepEq(v.map((x) => x.kind), ["axis", "axis", "single", "single", "single"], "kinds");
  const f = P.propertyGroups(h.elements[1]);
  assertEq(f.length, 1, "face chip count");
  assertEq(f[0].kind, "single", "list props are always singles");
  assertEq(f[0].type, "list uint8 int32", "list type shown");
  assertEq(f[0].bytesPerRow, 1, "fixed part = count byte");
});

test("M8 groups: synthetic edge cases — mixed type, 1-member, lists, unnamed", () => {
  const mk = (name, t) => ({ name, isList: false, type: t, normalized: t.normalized, bytes: t.bytes, rawLine: "" });
  const mkList = (name) => ({ name, isList: true, type: null, normalized: "list uint8 int32", countType: P.TYPES.uchar, itemType: P.TYPES.int, fixedBytes: 1, bytes: 0, rawLine: "" });
  const el = { name: "vertex", count: 1, properties: [
    mk("f_a_0", P.TYPES.float), mk("f_a_1", P.TYPES.uchar), // mixed-type indexed family -> two singles
    mk("solo_0", P.TYPES.float),                            // 1-member indexed candidate -> single
    mk("ax", P.TYPES.float),                                // 1-member axis candidate -> single
    mk("px", P.TYPES.int), mk("py", P.TYPES.int),           // 2-member axis -> group
    mkList("idx_0"), mkList("idx_1"),                       // pattern-matching LISTS never grouped
    { name: null, isList: false, type: P.TYPES.float, normalized: "float32", bytes: 4, rawLine: "" },
  ]};
  const g = P.propertyGroups(el);
  assertDeepEq(g.map((x) => x.label),
    ["f_a_0", "f_a_1", "solo_0", "ax", "px, py", "idx_0", "idx_1", "#8 (unnamed)"], "labels");
  assertEq(g[4].kind, "axis", "px/py grouped");
  assertEq(g[0].kind, "single", "mixed family fell back to singles");
  assertEq(g[5].kind, "single", "lists never grouped");
});

test("M8 projectRow: kept raw ranges are bit-exact, including mid-row picks and offsets", () => {
  const h = P.parseHeader(fx("3dgs_standard.ply"));
  const el = h.elements[0];
  const row = new Uint8Array(236);
  for (let p = 0; p < 236; p++) row[p] = (p * 7) % 256; // distinct value per byte position
  const keep = new Array(59).fill(false);
  keep[0] = keep[1] = keep[2] = keep[3] = true; // x, y, z, f_dc_0
  const r = P.projectRow(row, 0, el, keep, false);
  assert(r.complete, "complete");
  assertEq(r.out.length, 16, "4 floats = 16 B");
  for (let i = 0; i < 16; i++) assertEq(r.out[i], (i * 7) % 256, `byte ${i}`);
  // mid-row selection: f_rest_0..2 = slots 6..8 = row bytes 24..35
  const keep2 = new Array(59).fill(false);
  keep2[6] = keep2[7] = keep2[8] = true;
  const r2 = P.projectRow(row, 0, el, keep2, false);
  assert(r2.complete);
  assertEq(r2.out.length, 12, "3 floats = 12 B");
  for (let i = 0; i < 12; i++) assertEq(r2.out[i], ((24 + i) * 7) % 256, `mid-row byte ${i}`);
  // same row embedded with a 5-byte prefix (offset must be honored)
  const withOff = new Uint8Array(241);
  for (let p = 0; p < 241; p++) withOff[p] = (p * 7) % 256;
  const r3 = P.projectRow(withOff, 5, el, keep2, false);
  assert(r3.complete);
  for (let i = 0; i < 12; i++) assertEq(r3.out[i], ((29 + i) * 7) % 256, `offset row byte ${i}`);
  // cut-off row
  const r4 = P.projectRow(new Uint8Array(200), 0, el, keep, false);
  assertEq(r4.complete, false, "incomplete row flagged");
  assertEq(r4.out, null);
});

test("M8 projectRow: list row — kept list copies count + items verbatim", () => {
  const el = { name: "face", count: 1, properties: [
    { name: "vertex_indices", isList: true, type: null, normalized: "list uint8 int32", countType: P.TYPES.uchar, itemType: P.TYPES.int, fixedBytes: 1, bytes: 0, rawLine: "" },
  ]};
  const row = new Uint8Array([3, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 99, 98, 97]); // 13 B row + junk
  const r = P.projectRow(row, 0, el, [true], false);
  assert(r.complete, "complete");
  assertEq(r.out.length, 13, "count byte + 3 int32");
  assertDeepEq(Array.from(r.out), [3, 0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], "verbatim bytes");
  const rDrop = P.projectRow(row, 0, el, [false], false);
  assert(rDrop.complete);
  assertEq(rDrop.out.length, 0, "dropped list emits nothing");
  // cut-off list (count says 3, only 2 item ints present)
  const rCut = P.projectRow(new Uint8Array([3, 0, 0, 0, 0, 1, 0, 0, 0]), 0, el, [true], false);
  assertEq(rCut.complete, false, "incomplete list row flagged");
});

test("M8 rowBounds: fixed row, offset list row, cut-off rows", () => {
  const h = P.parseHeader(fx("3dgs_standard.ply"));
  const el = h.elements[0];
  assertDeepEq(P.rowBounds(new Uint8Array(236), 0, el, false), { bytes: 236, complete: true }, "full row");
  assertDeepEq(P.rowBounds(new Uint8Array(235), 0, el, false), { bytes: -1, complete: false }, "one byte short");
  const elF = { name: "face", count: 1, properties: [
    { name: "vertex_indices", isList: true, type: null, normalized: "list uint8 int32", countType: P.TYPES.uchar, itemType: P.TYPES.int, fixedBytes: 1, bytes: 0, rawLine: "" },
  ]};
  // 2 junk bytes, then count=2 + 2 int32 (9 B), then 1 junk byte
  const buf = new Uint8Array([7, 7, 2, 0, 0, 0, 0, 5, 0, 0, 0, 9]);
  assertDeepEq(P.rowBounds(buf, 2, elF, false), { bytes: 9, complete: true }, "list row with offset");
  assertDeepEq(P.rowBounds(new Uint8Array([2, 0, 0, 0, 0]), 0, elF, false),
    { bytes: -1, complete: false }, "list row cut off mid-item (count=2 needs 9 B)");
});

test("M8 subsetHeader: keep-all adds exactly one inspector comment line; round-trips", () => {
  const src = fx("3dgs_standard.ply");
  const h = P.parseHeader(src);
  const sh = P.subsetHeader(h, allKeep(h));
  const line = "comment PLY Inspector: kept vertex 59/59\n";
  assertEq(sh.byteLength, h.headerByteLength + line.length, "original header + one comment line");
  assert(sh.text.startsWith("ply\nformat binary_little_endian 1.0\n"), "magic + format");
  assert(sh.text.includes("comment PLY Inspector: kept vertex 59/59"), "inspector comment");
  assertEq(sh.text.includes("\r"), false, "LF endings only");
  assert(sh.text.endsWith("\n"), "trailing newline");
  assertEq(sh.keptPerElement[0], 59, "kept count");
  assertEq(sh.expectedBodyBytes, 3 * 236, "body bytes");
  assertEq(sh.variable, false, "fixed rows");
  const h2 = P.parseHeader(Buffer.from(sh.text, "utf8"));
  assertEq(h2.warnings.length, 0, "no new warnings");
  assertEq(h2.elements[0].properties.length, 59, "all property lines verbatim");
  const exp = P.expectedSize(h2.elements, h2.headerByteLength, h2.format.kind);
  assertEq(exp.fixedBytes, sh.expectedBodyBytes, "expectedSize matches expectedBodyBytes");
});

test("M8 subsetHeader: 2-element header — kept element verbatim, dropped element omitted", () => {
  const h = P.parseHeader(fx("ascii_mesh.ply"));
  const keepVOnly = [h.elements[0].properties.map(() => true), h.elements[1].properties.map(() => false)];
  const sh = P.subsetHeader(h, keepVOnly);
  assert(sh.text.includes("element vertex 4"), "vertex kept");
  assert(sh.text.includes("comment tiny ASCII quad mesh"), "original comment preserved");
  assert(sh.text.includes("kept vertex 9/9"), "comment lists only kept elements");
  assert(!sh.text.includes("element face"), "face omitted entirely");
  assert(!sh.text.includes("vertex_indices"), "no face property lines");
  assertEq(sh.variable, false);
  const keepFOnly = [h.elements[0].properties.map(() => false), h.elements[1].properties.map(() => true)];
  const sh2 = P.subsetHeader(h, keepFOnly);
  assert(sh2.text.includes("element face 2"), "face kept");
  assert(sh2.text.includes("property list uchar int vertex_indices"), "face property verbatim");
  assert(!sh2.text.includes("element vertex"), "vertex omitted");
  assertEq(sh2.variable, true, "list element -> variable");
  assertEq(sh2.expectedBodyBytes, 0, "no fixed contribution from a list element");
});

test("M8 subsetHeader: zero-property element kept as declaration (no silent drop)", () => {
  const h = P.parseHeader(Buffer.from(
    "ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nelement edge 3\nend_header\n", "utf8"));
  assertEq(h.elements.length, 2, "two elements parsed");
  assertEq(h.elements[1].properties.length, 0, "second element has no properties");
  const sh = P.subsetHeader(h, allKeep(h));
  assert(sh.text.includes("element edge 3"), "declaration line kept");
  assert(!/element edge 3\nproperty/.test(sh.text), "no property lines for it");
  assert(sh.text.includes("kept vertex 2/2; edge 0/0"), "inspector comment lists 0/0 for it");
  assertEq(sh.keptPerElement[1], 0, "nothing kept there");
  const h2 = P.parseHeader(Buffer.from(sh.text, "utf8"));
  assertEq(h2.elements.length, 2, "round-trips with both elements");
  assertEq(h2.elements[1].count, 3, "count preserved");
});

test("M8 subsetPlan: copy/rewrite/drop modes, offsets, estimate, infeasibility", () => {
  // keep-all binary: copy mode, offsets known, exact estimate
  const src = fx("3dgs_standard.ply");
  const h = P.parseHeader(src);
  const p0 = P.subsetPlan(h, allKeep(h), src.length);
  assert(p0.ok, "keep-all feasible");
  assertEq(p0.elements[0].mode, "copy", "all kept -> copy");
  assertEq(p0.elements[0].offset, h.headerByteLength, "region offset");
  assertEq(p0.elements[0].rowBytes, 236);
  assertEq(p0.estimatedOutSize, p0.headerBytes + 3 * 236, "header + full body");
  assert(p0.exact, "fixed rows -> exact");
  // rewrite: keep x,y,z + f_dc (6 props) -> 24 B/row
  const keepB = h.elements[0].properties.map((p) => ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"].includes(p.name));
  const pB = P.subsetPlan(h, [keepB], src.length);
  assert(pB.ok, pB.reasons.join("|"));
  assertEq(pB.elements[0].mode, "rewrite");
  assertEq(pB.elements[0].newRowBytes, 24, "kept fixed contribution");
  assertEq(pB.estimatedOutSize, pB.headerBytes + 3 * 24, "estimate uses newRowBytes");
  // drop: 2-element synthetic header, drop the second element
  const hdr2 = Buffer.from("ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nelement face 3\nproperty float a\nend_header\n");
  const h2 = P.parseHeader(hdr2);
  const pD = P.subsetPlan(h2, [h2.elements[0].properties.map(() => true), h2.elements[1].properties.map(() => false)], 0);
  assert(pD.ok, pD.reasons.join("|"));
  assertDeepEq(pD.elements.map((e) => e.mode), ["copy", "drop"], "per-element modes");
  assertEq(pD.elements[1].offset, h2.headerByteLength + 2 * 8, "drop region still offsets the (absent) next");
  assertEq(pD.estimatedOutSize, pD.headerBytes + 2 * 8, "dropped element contributes nothing");
  // all-unchecked -> infeasible with the selection reason
  const pU = P.subsetPlan(h, [new Array(59).fill(false)], src.length);
  assertEq(pU.ok, false, "all-unchecked infeasible");
  assert(pU.reasons.some((r) => r.includes("no properties selected")), pU.reasons.join("|"));
  // unknown types: keep-all is copy-feasible; ANY changed selection is not
  const hw = P.parseHeader(fx("weird_props.ply"));
  const allW = allKeep(hw);
  assert(P.subsetPlan(hw, allW, fx("weird_props.ply").length).ok, "keep-all with unknown types is copy-feasible");
  const keepW = allW.map((k) => k.map((b, i) => !(hw.elements[0].properties[i].name === "x")));
  const pW = P.subsetPlan(hw, keepW, fx("weird_props.ply").length);
  assertEq(pW.ok, false, "changed selection with unknown types infeasible");
  assert(pW.reasons.some((r) => r.includes("unknown type") && r.includes("vertex")), pW.reasons.join("|"));
  // ASCII: always feasible, offsets unknown, estimate conservative
  const ha = P.parseHeader(fx("ascii_mesh.ply"));
  const pa = P.subsetPlan(ha, allKeep(ha), fx("ascii_mesh.ply").length);
  assert(pa.ok, "ascii always feasible");
  assertEq(pa.elements[0].offset, null, "ascii offsets unknown");
  assertEq(pa.elements[1].mode, "copy", "ascii all-kept");
  assertEq(pa.exact, false, "ascii estimate is a lower bound");
});

test("M8 subsetPlan: negative / non-integer element count -> 'count' reason", () => {
  // parseHeader keeps a negative count as-is (it warns but does not coerce).
  const hNeg = P.parseHeader(Buffer.from(
    "ply\nformat binary_little_endian 1.0\nelement vertex -3\nproperty float x\nend_header\n"));
  assertEq(hNeg.elements[0].count, -3, "negative count survives parsing");
  const pNeg = P.subsetPlan(hNeg, [hNeg.elements[0].properties.map(() => true)], 64);
  assertEq(pNeg.ok, false, "negative count infeasible");
  assert(pNeg.reasons.some((r) => r.includes("count")), `reason names the count: ${pNeg.reasons.join("|")}`);
  // parseHeader coerces a fractional count to 0 (warning); the guard still
  // catches a genuinely non-integer count on a hand-built header object.
  const hFrac = P.parseHeader(Buffer.from(
    "ply\nformat binary_little_endian 1.0\nelement vertex 2.5\nproperty float x\nend_header\n"));
  assertEq(hFrac.elements[0].count, 0, "fractional count coerced to 0 by the parser");
  const raw = { format: { kind: "binary_little_endian", version: "1.0" }, headerByteLength: 60,
    comments: [], objInfo: [], warnings: [], elementDisplay: ["vertex"],
    elements: [{ name: "vertex", count: 2.5, properties: [{ name: "x", isList: false, type: P.TYPES.float, normalized: "float32", bytes: 4, rawLine: "property float x" }] }] };
  const pFrac = P.subsetPlan(raw, [raw.elements[0].properties.map(() => true)], 64);
  assertEq(pFrac.ok, false, "non-integer count infeasible");
  assert(pFrac.reasons.some((r) => r.includes("count")), `reason names the count: ${pFrac.reasons.join("|")}`);
});

test("M8 stream: binary keep-all emits the body bit-exactly", async () => {
  const src = fx("3dgs_standard.ply");
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, allKeep(h), src.length);
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.rowsWritten, 3, "all rows");
  assertDeepEq(res.perElementRows, [3], "per-element rows");
  assertEq(res.truncated, false);
  assertEq(res.trailingBytes, 0);
  assertEq(res.aborted, false);
  assertDeepEq(Array.from(coalesce(res.chunks)), Array.from(src.subarray(h.headerByteLength)), "body identical");
});

test("M8 stream: keep 14 props rewrites rows; output decodes to the original values", async () => {
  const src = fx("3dgs_standard.ply");
  const h = P.parseHeader(src);
  const keepNames = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const keep = h.elements[0].properties.map((p) => keepNames.includes(p.name));
  assertEq(keep.filter(Boolean).length, 14, "14 kept");
  const plan = P.subsetPlan(h, [keep], src.length);
  assert(plan.ok, plan.reasons.join("|"));
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.rowsWritten, 3);
  const out = Buffer.concat([Buffer.from(P.subsetHeader(h, [keep]).text, "utf8"), Buffer.from(coalesce(res.chunks))]);
  const h2 = P.parseHeader(out);
  assertEq(h2.elements[0].properties.length, 14, "output property count");
  assertDeepEq(h2.elements[0].properties.map((p) => p.name), keepNames, "kept order preserved");
  const exp = P.expectedSize(h2.elements, h2.headerByteLength, h2.format.kind);
  assertEq(exp.exact, true, "output is fixed-size");
  assertEq(exp.fixedBytes, 3 * 56, "3 rows x 56 B");
  assertEq(out.length, h2.headerByteLength + 3 * 56, "output size = header + body");
  for (const r of [0, 2]) {
    const rowOut = P.decodeRow(coalesce(res.chunks).subarray(r * 56, (r + 1) * 56), h2.elements[0], false);
    const rowOrig = P.decodeRow(src.subarray(h.headerByteLength + r * 236, h.headerByteLength + (r + 1) * 236), h.elements[0], false);
    for (let i = 0; i < 14; i++) {
      const nm = h2.elements[0].properties[i].name;
      const oi = h.elements[0].properties.findIndex((p) => p.name === nm);
      assertDeepEq(rowOut.values[i].value, rowOrig.values[oi].value, `row ${r} ${nm}`);
    }
  }
});

test("M8 stream: big-endian rewrite honors endianness in the copy", async () => {
  const src = fx("big_endian.ply");
  const h = P.parseHeader(src);
  assertEq(h.format.kind, "binary_big_endian");
  const keep = [true, false, true]; // x (double), count (int, dropped), flag (uchar)
  const plan = P.subsetPlan(h, [keep], src.length);
  assert(plan.ok, plan.reasons.join("|"));
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.rowsWritten, 2, "both rows");
  const out = Buffer.concat([Buffer.from(P.subsetHeader(h, [keep]).text, "utf8"), Buffer.from(coalesce(res.chunks))]);
  const h2 = P.parseHeader(out);
  assertEq(h2.elements[0].properties.map((p) => p.name).join(","), "x,flag", "kept props");
  const body = coalesce(res.chunks);
  for (let r = 0; r < 2; r++) {
    const rowOut = P.decodeRow(body.subarray(r * 9, (r + 1) * 9), h2.elements[0], true);
    const rowOrig = P.decodeRow(src.subarray(h.headerByteLength + r * 13, h.headerByteLength + (r + 1) * 13), h.elements[0], true);
    assertDeepEq(rowOut.values[0].value, rowOrig.values[0].value, `row ${r} x (double, BE)`);
    assertDeepEq(rowOut.values[1].value, rowOrig.values[2].value, `row ${r} flag (uchar)`);
  }
  // raw ranges: each 9 B output row = original x (8 B) + original flag (1 B),
  // the dropped int in between absent
  assertEq(body.length, 18, "2 rows x 9 B");
  for (let r = 0; r < 2; r++) {
    const origRow = src.subarray(h.headerByteLength + r * 13, h.headerByteLength + (r + 1) * 13);
    assertDeepEq(Array.from(body.subarray(r * 9, r * 9 + 8)), Array.from(origRow.subarray(0, 8)), `row ${r} x bytes`);
    assertEq(body[r * 9 + 8], origRow[12], `row ${r} flag byte`);
  }
});

test("M8 stream: window seam — rows spanning the 8 MB boundary stay intact", async () => {
  const rows = 2500000; // 10 MB of 4-byte rows: two 8 MB windows with a mid-row seam
  const hdr = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${rows}\nproperty float x\nend_header\n`);
  const body = Buffer.alloc(rows * 4);
  for (let r = 0; r < rows; r++) body[r * 4] = r % 251;
  const src = Buffer.concat([hdr, body]);
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, [[true]], src.length);
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.rowsWritten, rows, "every row");
  assertEq(res.truncated, false);
  assertEq(res.trailingBytes, 0);
  assertDeepEq(Array.from(coalesce(res.chunks)), Array.from(body), "seamless copy across the window seam");
});

test("M8 stream: truncated body writes only complete rows; caller patches the count", async () => {
  const src = fx("tail_midrow.ply"); // 2 rows claimed, 1 full 4-B row + 2 stray bytes
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, allKeep(h), src.length);
  assert(plan.ok, plan.reasons.join("|"));
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.rowsWritten, 1, "one complete row");
  assertDeepEq(res.perElementRows, [1], "per-element rows");
  assertEq(res.truncated, true, "truncation flagged");
  assertEq(res.trailingBytes, 0, "no trailing-byte math when truncated");
  const out = Buffer.concat([
    Buffer.from(P.subsetHeader({ ...h, elements: h.elements.map((e, i) => ({ ...e, count: res.perElementRows[i] })) }, allKeep(h)).text, "utf8"),
    Buffer.from(coalesce(res.chunks)),
  ]);
  const h2 = P.parseHeader(out);
  assertEq(h2.elements[0].count, 1, "patched count");
  assertEq(out.length, h2.headerByteLength + 4, "header + one row");
  assertDeepEq(Array.from(coalesce(res.chunks)), Array.from(src.subarray(h.headerByteLength, h.headerByteLength + 4)), "complete row verbatim");
});

test("M8 stream: larger body reports the dropped trailing bytes", async () => {
  const src = Buffer.concat([fx("3dgs_standard.ply"), Buffer.from([9, 9, 9, 9, 9])]);
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, allKeep(h), src.length);
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.rowsWritten, 3, "all claimed rows");
  assertEq(res.truncated, false, "not truncation — the body is LARGER");
  assertEq(res.trailingBytes, 5, "5 dropped trailing bytes");
});

test("M8 stream: cooperative abort discards partial output", async () => {
  const src = fx("3dgs_standard.ply");
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, allKeep(h), src.length);
  let calls = 0;
  const flag = { v: false };
  const res = await P.streamSubset(readChunks(src), h, plan, {
    fileSize: src.length,
    isAborted: () => flag.v,
    onProgress: (p) => { calls++; if (p.rowsDone >= 1) flag.v = true; },
  });
  assertEq(res.aborted, true, "abort honored");
  assertEq(res.truncated, false, "not truncation");
  assertEq(res.chunks.length, 0, "partial output discarded");
  assert(calls >= 1, "progress was reported before the abort");
});

test("M8 stream: ASCII token projection — dropped singles, list counts preserved", async () => {
  const src = fx("ascii_mesh.ply");
  const h = P.parseHeader(src);
  const keepV = h.elements[0].properties.map((p) => !["red", "green", "blue"].includes(p.name));
  const keepF = h.elements[1].properties.map(() => true);
  const plan = P.subsetPlan(h, [keepV, keepF], src.length);
  assert(plan.ok, plan.reasons.join("|"));
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.rowsWritten, 6, "4 vertices + 2 faces");
  assertEq(res.truncated, false);
  assertEq(res.trailingBytes, 0);
  assertEq(res.shortLines, 0, "no short lines");
  const lines = coalesce(res.chunks).split("\n").filter((l) => l.length > 0);
  assertDeepEq(lines, [
    "0 0 0 0 0 1",
    "1 0 0 0 0 1",
    "1 1 0 0 0 1",
    "0 1 0 0 0 1",
    "3 0 1 2",
    "3 2 3 0",
  ], "kept tokens, single-space joined; list count travels with its items");
  const out = Buffer.concat([Buffer.from(P.subsetHeader(h, [keepV, keepF]).text, "utf8"), Buffer.from(coalesce(res.chunks), "utf8")]);
  const h2 = P.parseHeader(out);
  assertEq(h2.elements[0].properties.length, 6, "vertex minus colors");
  assertEq(h2.elements[1].properties[0].isList, true, "face list intact");
});

test("M8 stream: zero-property element — rows counted, zero bytes emitted (binary)", async () => {
  const body = Buffer.alloc(2 * 8);
  body.writeFloatLE(1, 0); body.writeFloatLE(2, 4);
  body.writeFloatLE(3, 8); body.writeFloatLE(4, 12);
  const src = Buffer.concat([Buffer.from(
    "ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nelement edge 3\nend_header\n", "utf8"), body]);
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, allKeep(h), src.length);
  assert(plan.ok, plan.reasons.join("|"));
  assertDeepEq(plan.elements.map((e) => e.mode), ["copy", "copy"], "zero-property element is copy");
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.truncated, false, "not truncated");
  assertEq(res.rowsWritten, 5, "2 vertex rows + 3 zero-byte edge rows");
  assertDeepEq(res.perElementRows, [2, 3], "per-element counts");
  const bodyOut = Buffer.concat(res.chunks);
  assertEq(bodyOut.length, 16, "body bytes come only from the vertex element");
  assert(bodyOut.equals(body), "vertex rows bit-exact");
  const out = Buffer.concat([Buffer.from(P.subsetHeader(h, allKeep(h)).text, "utf8"), bodyOut]);
  const h2 = P.parseHeader(out);
  assertEq(h2.elements.length, 2, "output keeps both elements");
  assertEq(out.length, h2.headerByteLength + 16, "output size consistent with the header");
});

test("M8 stream: huge-count zero-property element — counted in one step, no spin (freeze regression)", async () => {
  const src = fx("big_zero.ply"); // 2 vertex rows + `element edge 100000000000` (zero properties)
  const h = P.parseHeader(src);
  assertEq(h.elements[1].count, 100000000000, "fixture claims 1e11 zero-byte rows");
  const plan = P.subsetPlan(h, allKeep(h), src.length);
  assert(plan.ok, plan.reasons.join("|"));
  const t0 = Date.now();
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  const ms = Date.now() - t0;
  assert(ms < 2000, `streamed in ${ms} ms — a per-row spin over 1e11 rows would never return in time`);
  assertEq(res.truncated, false, "not truncated");
  assertEq(res.rowsWritten, 100000000002, "2 vertex rows + 1e11 zero-byte edge rows");
  assertDeepEq(res.perElementRows, [2, 100000000000], "per-element counts");
  const bodyOut = Buffer.concat(res.chunks);
  assertEq(bodyOut.length, 32, "body bytes come only from the vertex element");
  const out = Buffer.concat([Buffer.from(P.subsetHeader(h, allKeep(h)).text, "utf8"), bodyOut]);
  const h2 = P.parseHeader(out);
  assertEq(h2.elements.length, 2, "output keeps both elements");
  assertEq(h2.elements[1].count, 100000000000, "declaration kept verbatim");
  assertEq(h2.elements[1].properties.length, 0, "still zero properties");
  assertEq(out.length, h2.headerByteLength + 32, "output size consistent with the header");
});

test("M8 stream: ASCII zero-property element — its blank lines are rows", async () => {
  const src = Buffer.from(
    "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nelement edge 3\nend_header\n" +
    "1 2\n3 4\n\n\n\n", "utf8");
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, allKeep(h), src.length);
  assert(plan.ok, plan.reasons.join("|"));
  const res = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(res.truncated, false, "blank lines are the element's rows, not EOF");
  assertEq(res.rowsWritten, 5, "2 vertices + 3 edge rows");
  assertDeepEq(res.perElementRows, [2, 3], "per-element counts");
  assertDeepEq(res.chunks, ["1 2\n", "3 4\n", "\n", "\n", "\n"], "edge rows re-emitted as blank lines");
});

// ---------------------------------------------------------------------------
// M8 freeze guard (PLAN §12.4): cooperative yields + linear coalescing
// ---------------------------------------------------------------------------
// The pre-fix UI merge re-allocated and re-copied the WHOLE accumulator for
// every per-row part — O(output²/row) — which froze the page for minutes on
// a few-hundred-MB download (user-reported: "the page freezes when I click
// download"). The core coalesceParts copies every byte exactly once, reports
// byte progress, yields to the event loop per segment, and honors Abort.
const rowParts = (rows, rowBytes) => {
  const src = Buffer.alloc(rows * rowBytes);
  for (let i = 0; i < src.length; i++) src[i] = (i * 31 + 7) % 256;
  const parts = new Array(rows);
  for (let r = 0; r < rows; r++) parts[r] = src.subarray(r * rowBytes, (r + 1) * rowBytes);
  return { src, parts };
};

test("M8 coalesceParts: binary parts reassemble bit-exactly in 16 MB segments", async () => {
  const { src, parts } = rowParts(150000, 232); // 34.8 MB -> 3 segments
  const res = await P.coalesceParts(parts, false, {});
  assertEq(res.aborted, false);
  assertEq(res.parts.length, 3, "16 MB segment split");
  assert(Buffer.concat(res.parts).equals(src), "bit-exact reassembly");
});

test("M8 coalesceParts: ASCII parts join exactly", async () => {
  const parts = new Array(200000);
  for (let i = 0; i < parts.length; i++) parts[i] = String(i % 1000) + " ";
  const res = await P.coalesceParts(parts, true, {});
  assertEq(res.aborted, false);
  assertEq(res.parts.length, 4, "the 65 536 string-part cap splits 200 000 parts (tiny total)");
  const joined = res.parts.join("");
  assertEq(joined.length, parts.reduce((s, p) => s + p.length, 0), "all characters present");
  assertEq(joined.slice(0, 8), "0 1 2 3 ", "head");
  assertEq(joined.slice(-4), "999 ", "tail");
});

test("M8 coalesceParts: progress starts with the total, is monotone, ends exactly at it", async () => {
  const { parts } = rowParts(150000, 232);
  const total = 150000 * 232;
  const ev = [];
  let yields = 0;
  const res = await P.coalesceParts(parts, false, {
    onProgress: (done, tot) => ev.push([done, tot]),
    yielder: async () => { yields++; },
  });
  assertEq(res.aborted, false);
  assertEq(ev.length, 4, "initial (0,total) + one event per flushed segment");
  assertDeepEq(ev[0], [0, total], "first event carries the total up front");
  for (let i = 1; i < ev.length; i++) assert(ev[i][0] > ev[i - 1][0], "monotone");
  assertDeepEq(ev[ev.length - 1], [total, total], "ends exactly at the total");
  assertEq(yields, 2, "one yield per in-loop segment (the final tail flush has no follow-up work)");
});

test("M8 coalesceParts: abort mid-assembly discards everything", async () => {
  const { parts } = rowParts(150000, 232);
  let aborted = false;
  const res = await P.coalesceParts(parts, false, {
    isAborted: () => aborted,
    yielder: async () => { aborted = true; },
  });
  assertEq(res.aborted, true, "abort raised mid-assembly is honored");
  assertEq(res.parts.length, 0, "all output discarded");
  const pre = await P.coalesceParts(parts, false, { isAborted: () => true });
  assertEq(pre.aborted, true, "pre-set abort is honored before any copy");
});

test("M8 coalesceParts: scale — 46 MB of 232 B parts coalesces in well under a minute (linear, not quadratic)", async () => {
  const { parts } = rowParts(200000, 232);
  const t0 = Date.now();
  const res = await P.coalesceParts(parts, false, {});
  const ms = Date.now() - t0;
  assertEq(res.aborted, false);
  assertEq(Buffer.concat(res.parts).length, 200000 * 232, "full output");
  assert(ms < 30000,
    `coalesced in ${ms} ms — the quadratic pre-fix merge would take tens of minutes at this scale`);
});

test("M8 stream: cooperative yields — yielder awaited on the wall-time budget, output unchanged", async () => {
  const rows = 100000;
  const hdr = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${rows}\nproperty float x\nend_header\n`);
  const body = Buffer.alloc(rows * 4);
  for (let r = 0; r < rows; r++) body[r * 4] = r % 251;
  const src = Buffer.concat([hdr, body]);
  const h = P.parseHeader(src);
  const plan = P.subsetPlan(h, [[true]], src.length);
  let t = 0, yields = 0; // deterministic fake clock: +1 "ms" per now() call
  const res = await P.streamSubset(readChunks(src), h, plan, {
    fileSize: src.length,
    yielder: async () => { yields++; },
    now: () => ++t,
    yieldBudgetMs: 1000,
  });
  assertEq(res.rowsWritten, rows, "all rows written");
  assertEq(res.truncated, false);
  assertDeepEq(Array.from(coalesce(res.chunks)), Array.from(body), "output unchanged");
  assert(yields >= 90 && yields <= 110,
    `yielded ~once per budget (${yields} yields) — the event loop was handed back periodically`);
  const resNoYield = await P.streamSubset(readChunks(src), h, plan, { fileSize: src.length });
  assertEq(resNoYield.rowsWritten, rows, "no yielder -> unchanged behavior");
});

// ---------------------------------------------------------------------------
// summary (drains the queue — async tests included — then reports)
// ---------------------------------------------------------------------------
for (const t of queued) {
  try {
    await Promise.resolve(t.fn());
    passed++;
    console.log(`  ok   ${t.name}`);
  } catch (err) {
    failed++;
    failures.push({ name: t.name, err });
    console.error(`  FAIL ${t.name}\n       ${err.message}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error(` - ${f.name}: ${f.err.message}`);
  process.exitCode = 1;
}
