/**
 * One Power Automate flow → one BPMN process (semantic XML, no layout yet),
 * the step bindings for resources/mappings.yaml, and report rows.
 *
 * What lives where after conversion:
 *   order, branches, loops, error paths   → BPMN (gateways, sequence flows)
 *   expressions, connector parameters     → contract.params of each step (verbatim)
 *   connectors                            → generic host capabilities (catalog.js)
 * Nothing about the flow is left for the agent to know.
 *
 * Runtime contract for the steps (the "pa-compat" capability set a host implements):
 *   every step receives all variables; the Power Automate state (action outputs,
 *   variables, loop items) travels in the variable `pa`, and steps return the
 *   updated `pa`. Gateways read only plain booleans/strings the evaluate steps
 *   return (cond_*, sw_*, more_*), because engine conditions are `var op literal`.
 */
import { mapAction, WINDOWS_TZ } from "./catalog.js";
import { render, label } from "./expr.js";

const FAIL = new Set(["Failed", "TimedOut", "Skipped"]);
const DATA = new Set(["InitializeVariable", "SetVariable", "IncrementVariable", "DecrementVariable", "AppendToStringVariable",
                      "AppendToArrayVariable", "Compose", "ParseJson", "Query", "Select", "Join", "Table"]);
export const pretty = (s) => String(s ?? "").replace(/_/g, " ").replace(/\s+-\s+/g, " – ").replace(/\s+/g, " ").trim();
const xmlEsc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const san = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "x";

/** Topological order of sibling actions by runAfter (stable by original order). */
function topo(actions) {
  const names = Object.keys(actions ?? {});
  const done = new Set(); const out = [];
  let guard = 0;
  while (out.length < names.length && guard++ < names.length * names.length + 5) {
    for (const n of names) {
      if (done.has(n)) continue;
      const preds = Object.keys(actions[n].runAfter ?? {}).filter((p) => p in actions);
      if (preds.every((p) => done.has(p))) { done.add(n); out.push(n); }
    }
  }
  for (const n of names) if (!done.has(n)) out.push(n);   // cycles cannot happen in valid flows
  return out;
}

export function buildProcess(flow, { processId, capsUsed, report }) {
  const nodes = [];           // {id, tag, name, attrs, inner}
  const flows = [];           // {id, s, t, name, cond}
  const defaults = new Map(); // gateway id -> default flow id
  const exitInfo = new Map(); // node id -> {asDefault} | {cond, name}
  const bindings = [];
  const used = new Set();
  const uid = (prefix, name) => {
    let id = `${prefix}_${san(name)}`; let i = 2;
    while (used.has(id)) id = `${prefix}_${san(name)}_${i++}`;
    used.add(id); return id;
  };
  const node = (tag, prefix, name, attrs = {}, inner = "", doc = "") => { const id = uid(prefix, name); nodes.push({ id, tag, name, attrs, inner, doc }); return id; };
  let fseq = 0;
  const connect = (s, t, name, cond) => {
    if (!s || !t) return;
    const info = exitInfo.get(s);
    const id = `Flow_${++fseq}`;
    const f = { id, s, t, name: name ?? info?.name, cond: cond ?? info?.cond };
    flows.push(f);
    if (info?.asDefault && !defaults.has(s)) defaults.set(s, id);
    return id;
  };
  const gw = (kind, name, doc = "") => node(kind === "parallel" ? "parallelGateway" : "exclusiveGateway", "Gw", name, {}, "", doc);
  const task = (name, capability, params, { user = false, mode = "autonomous", notes = [], actions = [] } = {}) => {
    const id = node(user ? "userTask" : "serviceTask", "Task", name, { "uapf:capability": capability });
    capsUsed.add(capability);
    bindings.push({ source: { type: user ? "bpmn.userTask" : "bpmn.serviceTask", ref: id },
                    targetId: user ? "role.process-participant" : "agent.uapf-ip-host",
                    mode: user ? "manual" : mode, requiredCapabilities: [capability],
                    contract: { params }, ...(notes.length ? { notes: notes.join(" ") } : {}) });
    return id;
  };
  const row = (r) => report.push({ flow: flow.name, ...r });

  /* ── one unit (action or merged data group) → {entry, exit} ───────────── */
  function emitUnit(unit, actions) {
    const n = unit.lead; const a = actions[n];
    if (unit.members.length > 1 || DATA.has(a.type)) {
      const ops = unit.members.map((m) => ({ action: m, type: actions[m].type, inputs: actions[m].inputs ?? null }));
      const nm = unit.members.length === 1 ? pretty(n) : `${pretty(unit.members[0])} (+${unit.members.length - 1} data steps)`;
      const id = task(nm, "data.transform@1", { operations: ops });
      for (const m of unit.members) row({ action: m, type: actions[m].type, step: id, capability: "data.transform@1", fidelity: "exact", notes: unit.members.length > 1 ? `merged into one data step with ${unit.members.length} operations` : "" });
      return { entry: id, exit: id };
    }
    switch (a.type) {
      case "If": {
        const v = `cond_${san(n)}`;
        const text = render(a.expression);
        const ev = task(`Evaluate: ${pretty(n)}`, "expr.evaluate@1", { action: n, condition: a.expression, output: v });
        const g = gw("exclusive", label(`${pretty(n)}?`, 40), `Power Automate condition: ${text}`);
        connect(ev, g);
        const merge = gw("exclusive", `End ${pretty(n)}`);
        const yes = emitScope(a.actions);
        const no = emitScope(a.else?.actions);
        connect(g, yes?.entry ?? merge, "Yes", `${v} == true`); if (yes) connect(yes.exit, merge);
        const df = connect(g, no?.entry ?? merge, "No"); defaults.set(g, df); if (no) connect(no.exit, merge);
        row({ action: n, type: "If", step: g, capability: "expr.evaluate@1", fidelity: "exact", notes: `condition: ${text}` });
        return { entry: ev, exit: merge };
      }
      case "Switch": {
        const v = `sw_${san(n)}`;
        const ev = task(`Evaluate: ${pretty(n)}`, "expr.evaluate@1", { action: n, expression: a.expression, output: v });
        const g = gw("exclusive", label(pretty(n), 40), `Switch on: ${render(a.expression)}`);
        connect(ev, g);
        const merge = gw("exclusive", `End ${pretty(n)}`);
        for (const [cn, c] of Object.entries(a.cases ?? {})) {
          const br = emitScope(c.actions);
          connect(g, br?.entry ?? merge, `${c.case}`, `${v} == ${JSON.stringify(c.case)}`);
          if (br) connect(br.exit, merge);
        }
        const d = emitScope(a.default?.actions);
        defaults.set(g, connect(g, d?.entry ?? merge, "Default"));
        if (d) connect(d.exit, merge);
        row({ action: n, type: "Switch", step: g, capability: "expr.evaluate@1", fidelity: "exact",
              notes: `${Object.keys(a.cases ?? {}).length} cases + default on ${render(a.expression)}` });
        return { entry: ev, exit: merge };
      }
      case "Foreach": {
        const has = `more_${san(n)}`;
        const init = task(`Prepare: ${pretty(n)}`, "expr.evaluate@1", { action: n, foreach: a.foreach, loop: n });
        const next = task(`Next item: ${pretty(n)}`, "list.next@1", { loop: n, has });
        const g = gw("exclusive", `More items in ${pretty(n)}?`);
        connect(init, next); connect(next, g);
        const body = emitScope(a.actions);
        connect(g, body?.entry ?? next, "Yes", `${has} == true`);
        if (body) connect(body.exit, next);
        exitInfo.set(g, { asDefault: true, name: "No" });
        const conc = a.runtimeConfiguration?.concurrency?.repetitions;
        row({ action: n, type: "Foreach", step: g, capability: "list.next@1", fidelity: conc > 1 ? "approximated" : "exact",
              notes: `loop over ${render(a.foreach)}` + (conc > 1 ? `; Power Automate ran ${conc} items in parallel, UAPF runs them one by one` : "") });
        return { entry: init, exit: g };
      }
      case "Until": {
        const v = `done_${san(n)}`;
        const body = emitScope(a.actions);
        const ev = task(`Check: ${pretty(n)}`, "expr.evaluate@1", { action: n, condition: a.expression, output: v, limit: a.limit ?? null });
        const g = gw("exclusive", label(`${pretty(n)} done?`, 40), `Repeat until: ${render(a.expression)}`);
        if (body) connect(body.exit, ev);
        connect(ev, g);
        defaults.set(g, connect(g, body?.entry ?? ev, "Not yet"));
        exitInfo.set(g, { cond: `${v} == true`, name: "Done" });
        row({ action: n, type: "Until", step: g, capability: "expr.evaluate@1", fidelity: "approximated",
              notes: `repeat until ${render(a.expression)}; the loop limit (${JSON.stringify(a.limit ?? {})}) is passed to the host, the engine's own step budget is 10 000` });
        return { entry: body?.entry ?? ev, exit: g };
      }
      case "Scope": {
        const inner = emitScope(a.actions);
        row({ action: n, type: "Scope", step: inner?.entry ?? "", capability: "", fidelity: "exact", notes: "scope flattened; its actions follow in order" });
        return inner ?? { entry: null, exit: null, empty: true };
      }
      default: {
        const m = mapAction(n, a);
        if (m.kind === "end") {
          const st = a.inputs?.runStatus ?? "Succeeded";
          const id = node("endEvent", "End", `Terminate (${st})`);
          row({ action: n, type: a.type, step: id, capability: "", fidelity: "exact", notes: `terminate with status ${st}` });
          return { entry: id, exit: null };
        }
        const params = { action: n, type: a.type, inputs: a.inputs ?? null, ...(a.runtimeConfiguration ? { runtimeConfiguration: a.runtimeConfiguration } : {}) };
        if (m.kind === "child") params.childFlow = a.inputs?.host?.workflowReferenceName ?? null;
        const id = task(pretty(n), m.capability, params, { user: m.kind === "user", mode: m.fidelity === "manual" ? "supervised" : "autonomous", notes: m.notes });
        row({ action: n, type: a.type, connector: m.label ?? m.connector ?? "", step: id, capability: m.capability, fidelity: m.fidelity, notes: m.notes.join(" ") });
        return { entry: id, exit: id };
      }
    }
  }

  /* ── a set of sibling actions (flow body, branch, loop body, scope) ───── */
  function emitScope(actions) {
    if (!actions || !Object.keys(actions).length) return null;
    const order = topo(actions);
    const preds = Object.fromEntries(order.map((n) => [n, Object.entries(actions[n].runAfter ?? {})
      .filter(([p]) => p in actions).map(([p, st]) => ({ p, st: st?.length ? st : ["Succeeded"] }))]));
    const succs = Object.fromEntries(order.map((n) => [n, []]));
    for (const n of order) for (const { p, st } of preds[n]) succs[p].push({ n, st });
    const isFailOnly = (st) => st.length && st.every((s) => FAIL.has(s));

    /* merge straight chains of data actions into one step */
    const unitOf = {}; const units = [];
    for (const n of order) {
      const pr = preds[n];
      const p = pr.length === 1 && !isFailOnly(pr[0].st) && pr[0].st.includes("Succeeded") ? pr[0].p : null;
      if (DATA.has(actions[n].type) && p && DATA.has(actions[p].type) && succs[p].length === 1 && unitOf[p]) {
        unitOf[p].members.push(n); unitOf[n] = unitOf[p];
      } else { const u = { lead: n, members: [n] }; units.push(u); unitOf[n] = u; }
    }
    const emitted = new Map();
    for (const u of units) emitted.set(u, emitUnit(u, actions));
    const tail = (u) => u.members[u.members.length - 1];

    /* failure gateways: after P when some sibling runs only if P failed */
    const failGw = new Map();
    const failGate = (pu) => {
      if (failGw.has(pu)) return failGw.get(pu);
      const e = emitted.get(pu);
      const g = gw("exclusive", `${pretty(tail(pu))} failed?`);
      connect(e.exit, g);
      failGw.set(pu, g);
      return g;
    };

    const incoming = new Map(units.map((u) => [u, { normal: [], alt: [] }]));
    const outgoing = new Map();           // source node -> [{u}]
    const failUnits = new Set();
    for (const u of units) {
      for (const { p, st } of preds[u.lead]) {
        const pu = unitOf[p];
        if (isFailOnly(st)) {
          failUnits.add(u);
          const g = failGate(pu);
          incoming.get(u).alt.push({ from: g, cond: `fail_${san(tail(pu))} == true`, name: "Failed" });
          row({ action: u.lead, type: "runAfter", step: g, capability: "", fidelity: "approximated",
                notes: `runs only if ${p} ${st.join("/")}. Drawn as a branch on fail_${san(tail(pu))}; the engine stops a run on a failed step, so this path needs a host that reports failures instead of raising them.` });
        } else {
          const src = emitted.get(pu).exit;
          if (!src) continue;
          if (!outgoing.has(src)) outgoing.set(src, []);
          outgoing.get(src).push(u);
          if (st.some((s) => FAIL.has(s)) && !failUnits.has(pu))
            row({ action: u.lead, type: "runAfter", step: "", capability: "", fidelity: "approximated",
                  notes: `runs after ${p} when it is ${st.join("/")}. Modelled as running after ${p} succeeds; a failed step stops the engine run unless the host reports failures as values.` });
          if (st.some((s) => FAIL.has(s))) {
            // also runs when P was skipped/failed: if P is itself on a failure branch, it also follows P's "not failed" path
            if (failUnits.has(pu)) {
              const gpu = unitOf[preds[pu.lead].find((x) => isFailOnly(x.st))?.p];
              if (gpu && failGw.has(gpu)) incoming.get(u).alt.push({ from: failGw.get(gpu), asDefault: true, name: "Succeeded" });
            }
          }
        }
      }
    }
    /* failure gateways whose "not failed" path has no explicit target continue to P's normal successors */
    for (const [pu, g] of failGw) {
      const src = emitted.get(pu).exit;
      const normal = outgoing.get(src) ?? [];
      outgoing.delete(src);
      const usedAsDefault = units.some((u) => incoming.get(u).alt.some((x) => x.from === g && x.asDefault));
      if (normal.length) outgoing.set(g, normal);
      else if (!usedAsDefault) exitInfo.set(g, { asDefault: true, name: "Succeeded" });
    }
    /* materialise: forks */
    const target = new Map();             // unit -> entry node to connect into (after joins/merges)
    for (const u of units) {
      const inc = incoming.get(u);
      const normalSrcs = [];
      for (const [src, list] of outgoing) if (list.includes(u)) normalSrcs.push(src);
      inc.normalSrcs = normalSrcs;
    }
    for (const u of units) {
      const e = emitted.get(u);
      if (!e.entry) continue;
      const inc = incoming.get(u);
      let into = e.entry;
      const total = (inc.normalSrcs.length > 1 ? 1 : inc.normalSrcs.length) + inc.alt.length;
      if (total > 1) { const m = gw("exclusive", `Before ${pretty(u.lead)}`); connect(m, into); into = m; }
      if (inc.normalSrcs.length > 1) { const j = gw("parallel", `Join before ${pretty(u.lead)}`); connect(j, into); inc.joinNode = j; }
      target.set(u, { into, join: inc.joinNode });
      for (const a of inc.alt) { const fid = connect(a.from, into, a.name, a.asDefault ? undefined : a.cond); if (a.asDefault) defaults.set(a.from, fid); }
    }
    for (const [src, list] of outgoing) {
      const dests = list.map((u) => { const t = target.get(u); return t?.join ?? t?.into; }).filter(Boolean);
      const isFail = [...failGw.values()].includes(src);
      let fid = null;
      if (dests.length === 1) fid = connect(src, dests[0], isFail ? "Succeeded" : undefined);
      else if (dests.length > 1) { const f = gw("parallel", `Split after ${pretty(nodes.find((x) => x.id === src)?.name ?? "")}`); fid = connect(src, f, isFail ? "Succeeded" : undefined); for (const d of dests) connect(f, d); }
      if (isFail && fid && !defaults.has(src)) defaults.set(src, fid);
    }
    /* roots and leaves */
    const roots = units.filter((u) => !preds[u.lead].length && emitted.get(u).entry);
    let entry;
    if (roots.length === 1) entry = target.get(roots[0])?.join ?? target.get(roots[0])?.into;
    else if (roots.length > 1) { entry = gw("parallel", "Split"); for (const r of roots) connect(entry, target.get(r)?.join ?? target.get(r)?.into); }
    const leaves = [];
    for (const u of units) {
      const e = emitted.get(u);
      if (!e.exit) continue;
      if (failGw.has(u)) { const g = failGw.get(u); if (!outgoing.has(g) && exitInfo.get(g)?.asDefault) leaves.push({ node: g, fail: true }); continue; }
      if (!outgoing.has(e.exit)) leaves.push({ node: e.exit, fail: failUnits.has(u) });
    }
    let exit = null;
    if (leaves.length === 1) exit = leaves[0].node;
    else if (leaves.length > 1) {
      const anyFail = leaves.some((l) => l.fail);
      exit = gw(anyFail ? "exclusive" : "parallel", anyFail ? "Continue" : "Join");
      for (const l of leaves) connect(l.node, exit);
    }
    if (!entry) return null;
    return { entry, exit };
  }

  /* ── triggers → start events ─────────────────────────────────────────── */
  const starts = [];
  for (const [tn, t] of Object.entries(flow.definition.triggers ?? {})) {
    if (t.type === "Recurrence") {
      const { cron, text, tz, exact } = recurrenceToCron(t.recurrence ?? {});
      const id = node("startEvent", "Start", text, {},
        `<bpmn:timerEventDefinition id="${uid("Timer", tn)}"><bpmn:timeCycle xsi:type="bpmn:tFormalExpression">${xmlEsc(cron)}</bpmn:timeCycle></bpmn:timerEventDefinition>`);
      if (tz) nodes.find((x) => x.id === id).attrs["uapf:timezone"] = tz;
      starts.push(id);
      row({ action: tn, type: "Recurrence", step: id, capability: "", fidelity: exact ? "exact" : "approximated",
            notes: `timer ${cron}${tz ? ` (${tz})` : ""}` + (exact ? "" : "; recurrence cannot be expressed exactly as cron, nearest schedule used") });
    } else if (t.type === "Request") {
      const id = node("startEvent", "Start", t.kind === "Button" ? "Manual start" : "HTTP request received");
      starts.push(id);
      row({ action: tn, type: `Request${t.kind ? "/" + t.kind : ""}`, step: id, capability: "", fidelity: "exact",
            notes: "started on demand (another process, the agent's 'run now', or an HTTP call to the host); request schema kept in resources" });
    } else {
      const m = mapAction(tn, t);
      const id = node("startEvent", "Start", `${pretty(tn)}${m.label ? ` (${m.label})` : ""}`);
      starts.push(id);
      row({ action: tn, type: t.type, connector: m.label ?? "", step: id, capability: "", fidelity: "approximated",
            notes: "event trigger: the host must poll the source or receive its webhook and then start this process" });
    }
  }
  if (!starts.length) starts.push(node("startEvent", "Start", "Start"));
  const body = emitScope(flow.definition.actions);
  const end = node("endEvent", "End", "End");
  for (const s of starts) connect(s, body?.entry ?? end);
  if (body?.exit) connect(body.exit, end);

  /* ── simplify: a pure merge that flows straight into another pure merge is redundant ── */
  const pureMerge = (id) => {
    const n = nodes.find((x) => x.id === id);
    if (!n || n.tag !== "exclusiveGateway" || defaults.has(id)) return false;
    const o = flows.filter((f) => f.s === id);
    return o.length === 1 && !o[0].cond;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const g of nodes.filter((n) => n.tag === "exclusiveGateway").map((n) => n.id)) {
      if (!pureMerge(g)) continue;
      const out = flows.find((f) => f.s === g);
      if (!pureMerge(out.t)) continue;
      for (const f of flows) if (f.t === g) f.t = out.t;
      flows.splice(flows.indexOf(out), 1);
      nodes.splice(nodes.findIndex((n) => n.id === g), 1);
      changed = true;
    }
  }

  /* ── XML (semantic only; layout is added afterwards) ─────────────────── */
  const inc = new Map(nodes.map((n) => [n.id, []])); const out = new Map(nodes.map((n) => [n.id, []]));
  for (const f of flows) { out.get(f.s)?.push(f.id); inc.get(f.t)?.push(f.id); }
  const x = [];
  x.push(`  <bpmn:process id="${processId}" name="${xmlEsc(flow.name)}" isExecutable="true">`);
  x.push(`    <bpmn:documentation>${xmlEsc(`Converted from the Power Automate flow "${flow.name}" by Power-Automate-UAPF-Converter. Expressions and connector parameters are kept verbatim in resources/mappings.yaml (contract.params).`)}</bpmn:documentation>`);
  for (const n of nodes) {
    const attrs = { ...n.attrs };
    if (defaults.has(n.id)) attrs.default = defaults.get(n.id);
    const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${xmlEsc(v)}"`).join("");
    x.push(`    <bpmn:${n.tag} id="${n.id}" name="${xmlEsc(n.name)}"${a}>`);
    for (const f of inc.get(n.id)) x.push(`      <bpmn:incoming>${f}</bpmn:incoming>`);
    for (const f of out.get(n.id)) x.push(`      <bpmn:outgoing>${f}</bpmn:outgoing>`);
    if (n.doc) x.push(`      <bpmn:documentation>${xmlEsc(n.doc)}</bpmn:documentation>`);
    if (n.inner) x.push(`      ${n.inner}`);
    x.push(`    </bpmn:${n.tag}>`);
  }
  for (const f of flows) {
    const nm = f.name ? ` name="${xmlEsc(f.name)}"` : "";
    if (f.cond) x.push(`    <bpmn:sequenceFlow id="${f.id}"${nm} sourceRef="${f.s}" targetRef="${f.t}"><bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">${xmlEsc(f.cond)}</bpmn:conditionExpression></bpmn:sequenceFlow>`);
    else x.push(`    <bpmn:sequenceFlow id="${f.id}"${nm} sourceRef="${f.s}" targetRef="${f.t}" />`);
  }
  x.push("  </bpmn:process>");
  return { processXml: x.join("\n"), bindings, stats: { nodes: nodes.length, flows: flows.length } };
}

/* Recurrence → cron (sec min hour dom mon dow). Exact for daily/weekly/hourly/minute schedules. */
export function recurrenceToCron(r) {
  const tz = r.timeZone ? (WINDOWS_TZ[r.timeZone] ?? r.timeZone) : null;
  const iv = Number(r.interval ?? 1);
  const s = r.schedule ?? {};
  const st = r.startTime ? new Date(r.startTime) : null;
  const hours = (s.hours ?? (st ? [st.getUTCHours()] : [0])).map(Number);
  const mins = (s.minutes ?? (st ? [st.getUTCMinutes()] : [0])).map(Number);
  const DOW = { Monday: "MON", Tuesday: "TUE", Wednesday: "WED", Thursday: "THU", Friday: "FRI", Saturday: "SAT", Sunday: "SUN" };
  const days = (s.weekDays ?? []).map((d) => DOW[d] ?? d);
  const hm = (h, m) => h.map((x) => String(x).padStart(2, "0")).join(",") + ":" + m.map((x) => String(x).padStart(2, "0")).join(",");
  switch (r.frequency) {
    case "Minute": return { cron: `0 */${iv} * * * *`, text: `Every ${iv} min`, tz, exact: 60 % iv === 0 };
    case "Hour": return { cron: `0 ${mins[0] ?? 0} */${iv} * * *`, text: iv === 1 ? "Every hour" : `Every ${iv} hours`, tz, exact: 24 % iv === 0 };
    case "Day": return { cron: `0 ${mins.join(",")} ${hours.join(",")} */${iv} * *`, text: `${iv === 1 ? "Daily" : `Every ${iv} days`} ${hm(hours, mins)}`, tz, exact: iv === 1 };
    case "Week": {
      const d = days.length ? days.join(",") : "MON";
      return { cron: `0 ${mins.join(",")} ${hours.join(",")} * * ${d}`, text: `${d === "MON,TUE,WED,THU,FRI" ? "Working days" : d} ${hm(hours, mins)}${iv > 1 ? ` (every ${iv} weeks)` : ""}`, tz, exact: iv === 1 };
    }
    case "Month": return { cron: `0 ${mins[0] ?? 0} ${hours[0] ?? 0} ${st ? st.getUTCDate() : 1} */${iv} *`, text: `Monthly ${hm(hours, mins)}`, tz, exact: iv === 1 };
    default: return { cron: "0 0 0 * * *", text: "Schedule", tz, exact: false };
  }
}
