// npm test: convert the samples, check the package structure; with UAPF_ENGINE_DIR also execute every process.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readExport } from "../src/read.js";
import { convert } from "../src/package.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fail++; };

for (const f of ["ContosoSamples_1_0_0_1.zip", "InvoiceApproval.json", "DailyNewsDigest.json", "CustomerRequestTriage.json"]) {
  const exp = await readExport(fs.readFileSync(path.join(root, "samples", f)), f);
  const { files, summary } = await convert(exp, { date: "2026-01-01" });
  check(files.has("uapf.yaml") && files.has("resources/mappings.yaml") && files.has("metadata/lifecycle.yaml"), `${f}: package files present`);
  const bpmn = [...files.keys()].filter((k) => k.startsWith("bpmn/"));
  check(bpmn.length === exp.flows.length, `${f}: one BPMN per flow (${bpmn.length})`);
  for (const b of bpmn) check(files.get(b).includes("<bpmndi:BPMNDiagram"), `${b}: has diagram layout`);
  check(!/sig=(?!\[REDACTED\])/.test([...files.values()].join("")), `${f}: no trigger signatures copied`);
  check(summary.actions > 0, `${f}: ${summary.actions} actions, exact ${summary.fidelity.exact ?? 0}, approximated ${summary.fidelity.approximated ?? 0}, manual ${summary.fidelity.manual ?? 0}`);
  if (process.env.UAPF_ENGINE_DIR) {
    const tmp = fs.mkdtempSync(path.join(root, ".walk-"));
    for (const [p, c] of files) { fs.mkdirSync(path.dirname(path.join(tmp, p)), { recursive: true }); fs.writeFileSync(path.join(tmp, p), c); }
    try { console.log(execFileSync("node", [path.join(root, "test/walk.cjs"), process.env.UAPF_ENGINE_DIR, tmp, "60"]).toString().trim()); check(true, `${f}: every run reached an end event`); }
    catch (e) { console.log(String(e.stdout ?? e.message)); check(false, `${f}: engine walk`); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
process.exit(fail ? 1 : 0);
