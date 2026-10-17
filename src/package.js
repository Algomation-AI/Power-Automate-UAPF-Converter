/**
 * Assemble a UAPF 2.5.0 Level-4 package from converted flows, in memory.
 * Returns { files: Map<path, string>, report, packageId, summary } and can zip it.
 */
import YAML from "yaml";
import JSZip from "jszip";
import { layoutProcess } from "bpmn-auto-layout";
import { buildProcess, pretty } from "./build.js";
import { kebab } from "./catalog.js";

export const VERSION = "0.1.0";
const NS = "https://uapf.dev/bpmn/v2.4";
const yaml = (o) => YAML.stringify(o, { lineWidth: 120 });
const procId = (name, used) => {
  let id = "Process_" + (String(name).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "Flow");
  let i = 2; while (used.has(id)) id = id.replace(/_\d+$/, "") + `_${i++}`;
  used.add(id); return id;
};
/* trigger URLs of HTTP-triggered flows carry a signature: never copy it into a package */
const redact = (s) => s.replace(/([?&](sig|code|sv|sp)=)[^&"\s]+/gi, "$1[REDACTED]");

export async function convert(exp, opts = {}) {
  const today = (opts.date ?? new Date().toISOString()).slice(0, 10);
  const owner = opts.owner ?? { type: "team", id: "process-owners", name: "Process owners", contact: "process-owners@example.invalid" };
  const base = exp.solution?.uniqueName ?? exp.flows[0]?.name ?? "flows";
  const packageId = opts.packageId ?? `pa.${kebab(base).replace(/-+/g, "-")}`;
  const files = new Map();
  const report = [];
  const capsUsed = new Set();
  const bindings = [];
  const processes = [];
  const used = new Set();

  for (const flow of exp.flows) {
    const pid = procId(flow.name, used);
    const { processXml, bindings: b, stats } = buildProcess(flow, { processId: pid, capsUsed, report });
    bindings.push(...b);
    const semantic = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:uapf="${NS}" id="Definitions_${pid}" targetNamespace="https://uapf.dev/converted/${packageId}">
${processXml}
</bpmn:definitions>
`;
    let xml;
    try { xml = await layoutProcess(semantic); }
    catch (e) { throw new Error(`layout failed for ${flow.name}: ${e.message}`); }
    files.set(`bpmn/${pid}.bpmn`, xml);
    files.set(`docs/source/${pid}.json`, redact(JSON.stringify({ name: flow.name, source: flow.source, definition: flow.definition }, null, 2)));
    processes.push({ id: pid, name: flow.name, stats, connections: flow.connectionReferences ?? {},
                     triggers: Object.entries(flow.definition.triggers ?? {}).map(([k, t]) => ({ name: k, type: t.type, kind: t.kind ?? null, schema: t.inputs?.schema ?? null })) });
  }

  const caps = [...capsUsed].sort();
  const anyUser = bindings.some((b) => b.source.type === "bpmn.userTask");
  files.set("resources/mappings.yaml", yaml({
    kind: "uapf.resources.mapping",
    targets: [
      { id: "agent.uapf-ip-host", type: "ai_agent", name: "Any UAPF-IP host offering the listed capabilities",
        description: "A requirement, not a specific agent: any host that implements the pa-compat capabilities can execute these processes.",
        capabilities: caps },
      ...(anyUser ? [{ id: "role.process-participant", type: "human_role", name: "Process participant",
                       description: "Person who answers approvals and other human steps." }] : []),
    ],
    bindings,
  }));
  files.set("resources/connections.yaml", "# Connection references from the export. Credentials are never exported;\n# a deployment maps each reference to a host connector configured with its own credentials.\n" + yaml({
    kind: "uapf.resources.connections",
    connections: processes.flatMap((p) => Object.entries(p.connections).map(([ref, c]) => ({
      process: p.id, reference: ref, api: c?.api?.name ?? c?.apiName ?? null,
      logicalName: c?.connection?.connectionReferenceLogicalName ?? c?.connectionName ?? null }))),
  }));
  files.set("resources/triggers.yaml", yaml({ kind: "uapf.resources.triggers", processes: processes.map((p) => ({ process: p.id, triggers: p.triggers })) }));
  files.set("resources/guardrails.yaml", yaml({ kind: "uapf.resources.guardrails", guardrails: [
    { id: "GR-1", rule: "Steps call only the connectors listed in resources/connections.yaml, with credentials configured on the host." },
    { id: "GR-2", rule: "Expressions and connector parameters are evaluated exactly as stored in contract.params; a host must not substitute its own logic." },
    { id: "GR-3", rule: "Steps marked fidelity 'manual' or 'approximated' in docs/conversion-report.md are reviewed by a person before production use." },
  ] }));
  files.set("metadata/ownership.yaml", yaml({ kind: "uapf.metadata.ownership",
    owners: [{ ...owner, role: "owner" }], approvers: [owner.id] }));
  files.set("metadata/lifecycle.yaml", YAML.stringify({ kind: "uapf.metadata.lifecycle", status: "draft",
    created: `${today}T00:00:00Z`, lastModified: `${today}T00:00:00Z`,
    changeHistory: [{ version: "0.1.0", date: today, author: "pa2uapf",
      summary: `Converted from Power Automate (${exp.flows.length} flow${exp.flows.length > 1 ? "s" : ""}${exp.solution ? `, solution ${exp.solution.uniqueName} ${exp.solution.version ?? ""}` : ""}) by Power-Automate-UAPF-Converter ${VERSION}.` }] },
    { defaultStringType: "QUOTE_DOUBLE", defaultKeyType: "PLAIN", lineWidth: 120 }));

  const counts = { exact: 0, approximated: 0, manual: 0 };
  for (const r of report) counts[r.fidelity] = (counts[r.fidelity] ?? 0) + 1;
  const name = exp.solution?.displayName ?? (exp.flows.length === 1 ? exp.flows[0].name : base);
  const man = {
    kind: "uapf.package", id: packageId, name: pretty(name),
    description: `Level-4 UAPF package converted from Power Automate: ${processes.length} BPMN process${processes.length > 1 ? "es" : ""}. Executable by any UAPF-IP host offering the pa-compat capabilities listed in resources/mappings.yaml.`,
    level: 4, version: "0.1.0",
    requires_capabilities: caps.map((c) => `${c}+`), profiles_supported: ["uapf-ip-orchestrated"],
    guardrails: "resources/guardrails.yaml", includes: [], dependencies: {},
    cornerstones: { bpmn: true, dmn: false, cmmn: false, resources: true },
    paths: { bpmn: "bpmn", resources: "resources", metadata: "metadata", algorithms: "algorithms" },
    algorithm_cards: false,
    exposure: { mcp: { enabled: true, runnable: true, exposedEntrypoints: processes.map((p) => p.id) } },
    owners: [{ type: owner.type, id: owner.id, contact: owner.contact }], lifecycle: "draft",
  };
  files.set("uapf.yaml", yaml(man));
  files.set("manifest.json", JSON.stringify(man, null, 2) + "\n");

  const summary = { packageId, name: man.name, processes: processes.map((p) => ({ id: p.id, name: p.name, ...p.stats })),
                    actions: report.length, fidelity: counts, capabilities: caps,
                    manualCapabilities: [...new Set(report.filter((r) => r.fidelity === "manual").map((r) => r.capability).filter(Boolean))] };
  files.set("docs/conversion-report.json", JSON.stringify({ converter: `pa2uapf ${VERSION}`, date: today, summary, rows: report }, null, 2) + "\n");
  files.set("docs/conversion-report.md", reportMd(summary, report));
  files.set("README.md", readme(man, summary, processes));
  return { files, report, summary, packageId };
}

export async function zipPackage(files) {
  const z = new JSZip();
  for (const [p, c] of files) z.file(p, c);
  return z.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function reportMd(s, rows) {
  const pct = (n) => (s.actions ? Math.round((100 * n) / s.actions) : 0);
  const L = [];
  L.push(`# Conversion report — ${s.name}`, "");
  L.push(`| | |`, `|---|---|`);
  L.push(`| Package | \`${s.packageId}\` |`);
  L.push(`| Processes | ${s.processes.map((p) => `\`${p.id}\``).join(", ")} |`);
  L.push(`| Actions and triggers | ${s.actions} |`);
  L.push(`| Exact | ${s.fidelity.exact ?? 0} (${pct(s.fidelity.exact ?? 0)} %) |`);
  L.push(`| Approximated | ${s.fidelity.approximated ?? 0} (${pct(s.fidelity.approximated ?? 0)} %) |`);
  L.push(`| Manual | ${s.fidelity.manual ?? 0} (${pct(s.fidelity.manual ?? 0)} %) |`, "");
  L.push("**Exact**: same behaviour, the host capability is a thin wrapper. **Approximated**: runs, but differs as noted — review before production. **Manual**: no mapping; a person decides.", "");
  L.push("## Capabilities a host must offer", "", s.capabilities.map((c) => `- \`${c}\`${s.manualCapabilities.includes(c) ? " — not in the converter's catalogue" : ""}`).join("\n"), "");
  const review = rows.filter((r) => r.fidelity !== "exact");
  if (review.length) {
    L.push("## To review", "", "| Flow | Action | Type | Fidelity | Note |", "|---|---|---|---|---|");
    for (const r of review) L.push(`| ${r.flow} | ${r.action} | ${r.type} | ${r.fidelity} | ${String(r.notes ?? "").replace(/\|/g, "\\|")} |`);
    L.push("");
  }
  L.push("## All actions", "", "| Flow | Action | Type | BPMN element | Capability | Fidelity |", "|---|---|---|---|---|---|");
  for (const r of rows) L.push(`| ${r.flow} | ${r.action} | ${r.type}${r.connector ? ` (${r.connector})` : ""} | \`${r.step ?? ""}\` | ${r.capability ? `\`${r.capability}\`` : ""} | ${r.fidelity} |`);
  return L.join("\n") + "\n";
}

function readme(man, s, processes) {
  return `# ${man.name}

UAPF Level-4 package \`${man.id}\`, converted from Power Automate by
[Power-Automate-UAPF-Converter](https://github.com/algomation/Power-Automate-UAPF-Converter).

| Process | File |
|---|---|
${processes.map((p) => `| ${p.name} | bpmn/${p.id}.bpmn |`).join("\n")}

Conversion: ${s.actions} actions and triggers — ${s.fidelity.exact ?? 0} exact, ${s.fidelity.approximated ?? 0} approximated, ${s.fidelity.manual ?? 0} manual.
See \`docs/conversion-report.md\` before running this in production.

## Where things are

- **Order, branches, loops, error paths** — the BPMN diagrams.
- **Expressions and connector parameters** — verbatim in \`resources/mappings.yaml\`, \`contract.params\` of each step.
- **Connection references** — \`resources/connections.yaml\` (no credentials; each host configures its own).
- **Original flow definitions** — \`docs/source/\` (signatures in trigger URLs redacted).

## Runtime contract (pa-compat)

Any UAPF-IP host that offers the capabilities in \`resources/mappings.yaml\` can run these processes.
Steps receive all process variables. Power Automate state — action outputs, variables, loop items —
travels in the variable \`pa\`; each step returns the updated \`pa\`. Gateways only read plain values that
evaluate steps return (\`cond_*\`, \`sw_*\`, \`more_*\`, \`done_*\`), because engine conditions are \`variable op literal\`.
`;
}
