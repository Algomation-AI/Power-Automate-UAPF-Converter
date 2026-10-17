#!/usr/bin/env node
/**
 * pa2uapf <export.zip|flow.json> [-o out.uapf | -d outdir] [--id package.id] [--owner-name "..."] [--owner-contact x@y]
 */
import fs from "node:fs";
import path from "node:path";
import { readExport } from "./read.js";
import { convert, zipPackage, VERSION } from "./package.js";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
if (!args.length || args.includes("-h") || args.includes("--help")) {
  console.log(`pa2uapf ${VERSION} — Power Automate → UAPF package
usage: pa2uapf <solution.zip | package.zip | flow.json> [-o out.uapf] [-d outdir] [--id package.id]
                [--owner-name "Team"] [--owner-contact team@example.org]`);
  process.exit(args.length ? 0 : 1);
}
const out = opt("-o"); const dir = opt("-d"); const id = opt("--id");
const ownerName = opt("--owner-name"); const ownerContact = opt("--owner-contact");
const input = args[0];
const exp = await readExport(fs.readFileSync(input), path.basename(input));
const owner = ownerName || ownerContact ? { type: "team", id: (ownerName ?? "process-owners").toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                                             name: ownerName ?? "Process owners", contact: ownerContact ?? "process-owners@example.invalid" } : undefined;
const res = await convert(exp, { packageId: id, owner });
if (dir) {
  for (const [p, c] of res.files) { const f = path.join(dir, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c); }
}
const target = out ?? (!dir ? `${res.packageId}.uapf` : null);
if (target) fs.writeFileSync(target, await zipPackage(res.files));
const s = res.summary;
console.log(`${s.packageId}: ${s.processes.length} process(es), ${s.actions} actions — exact ${s.fidelity.exact ?? 0}, approximated ${s.fidelity.approximated ?? 0}, manual ${s.fidelity.manual ?? 0}`);
for (const p of s.processes) console.log(`  ${p.id}: ${p.nodes} elements, ${p.flows} flows`);
console.log(`  capabilities: ${s.capabilities.join(" ")}`);
if (target) console.log(`  written: ${target}`);
if (dir) console.log(`  written: ${dir}/`);
