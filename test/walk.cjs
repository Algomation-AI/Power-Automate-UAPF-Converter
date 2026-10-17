// Execute converted BPMN with the uapf-engine's own BpmnWalker, random decisions, bounded loops.
// usage: node test/walk.cjs <built uapf-engine dir> <package dir> [runs]
const fs = require("fs"), path = require("path");
const [E, P, N = "40"] = process.argv.slice(2);
const { BpmnWalker } = require(path.resolve(E, "dist/engine/BpmnWalker.js"));
const YAML = require(path.resolve(__dirname, "../node_modules/yaml/dist/index.js"));
const maps = YAML.parse(fs.readFileSync(path.join(P, "resources/mappings.yaml"), "utf8"));
const params = new Map(maps.bindings.map((b) => [b.source.ref, b.contract?.params ?? {}]));
let failed = 0;
(async () => {
for (const f of fs.readdirSync(path.join(P, "bpmn"))) {
  const proc = new BpmnWalker().parseBpmnXml(fs.readFileSync(path.join(P, "bpmn", f), "utf8"))[0];
  const all = new Set(proc.nodes.keys()); const seen = new Set(); const ends = {};
  let rng = 7;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < Number(N); i++) {
    const loops = {};
    const h = {
      onStep: async (n) => { seen.add(n.id); },
      onServiceTask: async (n) => {
        const p = params.get(n.id) ?? {};
        const failVars = Object.fromEntries(proc.flows.filter((fl) => /^fail_/.test(fl.condition ?? "")).map((fl) => [fl.condition.split(" ")[0], rand() < 0.15]));
        if (Object.keys(failVars).length && !p.output && !p.has && p.foreach === undefined) return failVars;
        if (p.output?.startsWith("cond_") || p.output?.startsWith("done_")) return { [p.output]: rand() < 0.5 };
        if (p.output?.startsWith("sw_")) {
          const opts = proc.flows.filter((fl) => fl.condition?.startsWith(p.output)).map((fl) => JSON.parse(fl.condition.split("==")[1].trim()));
          const k = Math.floor(rand() * (opts.length + 1)); return { [p.output]: opts[k] ?? "__none__" };
        }
        if (p.has) { loops[p.loop] = (loops[p.loop] ?? Math.floor(rand() * 3)) ; const more = loops[p.loop]-- > 0; return { [p.has]: more }; }
        if (p.foreach !== undefined) { delete loops[p.loop]; return {}; }
        return {};
      },
      onUserTask: async () => ({}),
      onBusinessRuleTask: async () => ({}),
    };
    try {
      const r = await new BpmnWalker().execute(proc, {}, h);
      const last = r.trace[r.trace.length - 1];
      ends[last.nodeId] = (ends[last.nodeId] ?? 0) + 1;
    } catch (e) { failed++; console.log(`  ${f}: run ${i} FAILED: ${e.message}`); break; }
  }
  const unreached = [...all].filter((x) => !seen.has(x));
  console.log(`${f}: ${N} runs, ends ${JSON.stringify(ends)}, reached ${seen.size}/${all.size}${unreached.length ? " — not reached: " + unreached.join(", ") : ""}`);
}
process.exit(failed ? 1 : 0);
})();
