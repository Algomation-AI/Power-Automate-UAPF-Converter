/**
 * UAPF 2.5.0 package check, in memory: JSON Schemas (schemas/uapf-2.5.0, from the specification)
 * plus the semantic rules that apply to converted packages:
 *   SEM-001 bindings reference existing BPMN elements   SEM-003 binding targets are defined
 *   SEM-004 user tasks are bound                          SEM-009 one binding per element
 *   SEM-011 every BPMN file has diagram interchange       SEM-012 algorithm card references resolve
 *   LAYOUT  Level-4 files present                          ENGINE  BPMN file stem = process id
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SCHEMA_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../schemas/uapf-2.5.0");
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schemas = {};
const schema = (n) => (schemas[n] ??= ajv.compile(JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, n), "utf8"))));

export function validatePackage(files) {
  const errors = []; const warnings = [];
  const get = (p) => files.get(p);
  const y = (p) => { const t = get(p); if (t == null) return null; try { return YAML.parse(t); } catch (e) { errors.push(`YAML ${p}: ${e.message}`); return null; } };
  const check = (inst, name, label) => {
    if (inst == null) return;
    const v = schema(name);
    if (!v(inst)) for (const e of v.errors) errors.push(`SCHEMA ${label}: ${e.instancePath || "(root)"} ${e.message}`);
  };
  const man = y("uapf.yaml");
  if (!man) errors.push("LAYOUT uapf.yaml missing");
  check(man, "uapf-manifest.schema.json", "uapf.yaml");
  const paths = { bpmn: "bpmn", resources: "resources", metadata: "metadata", algorithms: "algorithms", ...(man?.paths ?? {}) };
  for (const [f, s] of [["ownership.yaml", "ownership.schema.json"], ["lifecycle.yaml", "lifecycle.schema.json"]]) {
    const d = y(`${paths.metadata}/${f}`);
    if (!d) errors.push(`LAYOUT ${paths.metadata}/${f} missing`); else check(d, s, `${paths.metadata}/${f}`);
  }
  const mapping = y(`${paths.resources}/mappings.yaml`);
  if (man?.level === 4 && !mapping) errors.push("LAYOUT Level 4 requires resources/mappings.yaml");
  check(mapping, "resource-mapping.schema.json", "resources/mappings.yaml");

  const ids = new Set(); const userTasks = []; const cardRefs = [];
  const bpmnFiles = [...files.keys()].filter((p) => p.startsWith(`${paths.bpmn}/`) && p.endsWith(".bpmn"));
  if (man?.level === 4 && !bpmnFiles.length) errors.push("LAYOUT Level 4 requires a .bpmn file");
  for (const f of bpmnFiles) {
    const x = get(f);
    if (!/<bpmndi:BPMNDiagram/.test(x)) errors.push(`SEM-011 ${f}: no BPMNDiagram`);
    const stem = f.split("/").pop().replace(/\.bpmn$/, "");
    const pid = (x.match(/<(?:bpmn:)?process\b[^>]*\bid="([^"]+)"/) ?? [])[1];
    if (pid && pid !== stem) warnings.push(`ENGINE ${f}: file name differs from process id ${pid}`);
    for (const m of x.matchAll(/<(?:bpmn:)?(\w+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      ids.add(m[2]);
      if (m[1] === "userTask") userTasks.push(m[2]);
      const card = (m[0].match(/uapf:algorithmCardRef="([^"]+)"/) ?? [])[1];
      if (card) cardRefs.push([m[2], card]);
    }
  }
  for (const [el, card] of cardRefs)
    if (!files.has(`${paths.algorithms}/${card}.card.yaml`)) errors.push(`SEM-012 ${el}: algorithm card ${card} not found`);
  for (const p of [...files.keys()].filter((p) => p.startsWith(`${paths.algorithms}/`) && p.endsWith(".card.yaml")))
    check(y(p), "algorithm-card.schema.json", p);
  if (mapping) {
    const targets = new Set((mapping.targets ?? []).map((t) => t.id));
    const seen = new Set(); const used = new Set();
    for (const b of mapping.bindings ?? []) {
      const r = b.source?.ref;
      if (String(b.source?.type).startsWith("bpmn") && !ids.has(r)) errors.push(`SEM-001 binding ${r}: not in BPMN`);
      if (!targets.has(b.targetId)) errors.push(`SEM-003 binding ${r}: target ${b.targetId} undefined`);
      if (seen.has(r)) errors.push(`SEM-009 duplicate binding for ${r}`);
      seen.add(r); used.add(b.targetId);
    }
    for (const t of targets) if (!used.has(t)) warnings.push(`SEM-005 target ${t} never used`);
    for (const u of userTasks) if (!seen.has(u)) warnings.push(`SEM-004 user task ${u} unbound`);
  }
  return { ok: !errors.length, errors, warnings, spec: "UAPF 2.5.0" };
}
