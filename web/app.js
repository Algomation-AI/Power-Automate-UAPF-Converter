/* pa2uapf web demo. The server converts in memory and returns the package; nothing is stored. */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const FID = { exact: "Exact", approximated: "Approximated", manual: "Manual" };
  const KIND = { serviceTask: "Step run by the agent", userTask: "Step for a person", exclusiveGateway: "Decision",
                 parallelGateway: "Parallel split or join", startEvent: "Start", endEvent: "End" };
  let R = null, P = 0, viewer = null, filter = "review", fileSel = null;

  /* ── input ─────────────────────────────────────────────────────────── */
  const drop = $("drop"), file = $("file");
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files?.[0]; if (f) upload(f); });
  file.addEventListener("change", () => { if (file.files[0]) upload(file.files[0]); file.value = ""; });

  fetch("api/samples").then((r) => r.json()).then(({ samples }) => {
    $("samples").innerHTML = samples.map((s) => `<button class="sample" data-f="${esc(s.file)}">${esc(s.title)}</button>`).join("");
    $("samples").querySelectorAll("button").forEach((b) => b.onclick = () => run(`api/convert?sample=${encodeURIComponent(b.dataset.f)}`, { method: "POST" }, b.textContent));
  }).catch(() => {});

  function status(text, err = false) { const s = $("status"); s.hidden = !text; s.textContent = text ?? ""; s.classList.toggle("err", err); }
  function upload(f) {
    if (f.size > 10 * 1024 * 1024) return status("That file is larger than 10 MB. Export only the flows you need, or run the converter on your own server.", true);
    run("api/convert", { method: "POST", headers: { "X-Filename": f.name, "Content-Type": "application/octet-stream" }, body: f }, f.name);
  }
  async function run(url, opt, label) {
    status(`Converting ${label}…`);
    try {
      const r = await fetch(url, opt);
      const j = await r.json().catch(() => ({ error: `The server answered ${r.status}.` }));
      if (!r.ok) throw new Error(j.error || `The server answered ${r.status}.`);
      R = j; P = 0; filter = "review"; status("");
      show();
      $("result").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    } catch (e) {
      status(`${label} could not be converted: ${e.message}`, true);
    }
  }

  /* ── result ────────────────────────────────────────────────────────── */
  function show() {
    const s = R.summary;
    $("result").hidden = false;
    $("resName").textContent = s.name;
    $("resMeta").innerHTML = `Package <code>${esc(s.packageId)}</code>, ${s.processes.length} process${s.processes.length > 1 ? "es" : ""} from ${esc(R.input.filename)}`;
    const f = s.fidelity, total = s.actions || 1;
    $("bar").innerHTML = ["exact", "approximated", "manual"].filter((k) => f[k]).map((k) => `<span class="${k}" style="width:${(100 * f[k]) / total}%"></span>`).join("");
    $("bar").setAttribute("aria-label", `${f.exact ?? 0} exact, ${f.approximated ?? 0} approximated, ${f.manual ?? 0} manual of ${s.actions} actions`);
    $("barLegend").innerHTML = ["exact", "approximated", "manual"].map((k) =>
      `<span><i style="background:var(--${k === "approximated" ? "approx" : k})"></i><b>${f[k] ?? 0}</b> ${FID[k].toLowerCase()}</span>`).join("") +
      `<span>of ${s.actions} actions and triggers</span>`;
    const v = R.validation;
    $("valid").innerHTML = v.ok
      ? `<span class="ok">Valid ${esc(v.spec)} package</span>: schemas and semantic rules pass${v.warnings.length ? `, ${v.warnings.length} warning${v.warnings.length > 1 ? "s" : ""}` : ""}.`
      : `<span class="bad">${v.errors.length} ${esc(v.spec)} error${v.errors.length > 1 ? "s" : ""}</span>: ${esc(v.errors.slice(0, 3).join("; "))}`;
    $("tabs").innerHTML = R.processes.map((p, i) => `<button class="tab" role="tab" aria-selected="${i === P}" data-i="${i}">${esc(p.name)}</button>`).join("");
    $("tabs").hidden = R.processes.length < 2;
    $("tabs").querySelectorAll(".tab").forEach((b) => b.onclick = () => { P = +b.dataset.i; show(); });
    drawProcess();
    drawReport();
    drawFiles();
  }

  const rowsOf = (p) => R.rows.filter((r) => r.flow === p.name);
  async function drawProcess() {
    const p = R.processes[P];
    $("trigger").textContent = p.trigger ? `Trigger: ${p.trigger}` : "";
    const rows = rowsOf(p);
    const byAction = new Map(rows.filter((r) => r.type !== "runAfter").map((r) => [r.action, r]));
    $("outline").innerHTML = p.outline.map((o) => {
      const r = byAction.get(o.name);
      const fid = r?.fidelity ?? "none";
      return `<li class="${o.type === "branch" ? "branch" : ""}" style="padding-left:${8 + o.depth * 16}px" ${r?.step ? `data-step="${esc(r.step)}"` : ""} title="${esc(r?.notes ?? "")}">
        ${o.type === "branch" ? "" : `<span class="dot ${fid}"></span>`}<span class="n">${esc(o.name.replace(/_/g, " "))}</span>
        ${o.type === "branch" ? "" : `<span class="t">${esc(o.connector || o.type)}</span>`}</li>`;
    }).join("");
    if (!viewer) {
      viewer = new BpmnJS({ container: "#canvas" });
      viewer.get("eventBus").on("element.click", (e) => { if (e.element.type !== "bpmn:Process" && e.element.type !== "label") openStep(e.element); });
      $("zin").onclick = () => viewer.get("zoomScroll").stepZoom(1);
      $("zout").onclick = () => viewer.get("zoomScroll").stepZoom(-1);
      $("zfit").onclick = () => viewer.get("canvas").zoom("fit-viewport", "auto");
      $("zfit").textContent = "Fit";
    }
    $("step").hidden = true;
    await viewer.importXML(p.xml);
    const canvas = viewer.get("canvas");
    readable(canvas);
    for (const r of rows) if (r.step && r.fidelity !== "exact" && viewer.get("elementRegistry").get(r.step)) canvas.addMarker(r.step, `fid-${r.fidelity}`);
    $("outline").querySelectorAll("li[data-step]").forEach((li) => {
      li.onmouseenter = () => mark(li.dataset.step, true);
      li.onmouseleave = () => mark(li.dataset.step, false);
      li.onclick = () => { const el = viewer.get("elementRegistry").get(li.dataset.step); if (el) { canvas.scrollToElement(el, { top: 120, bottom: 120, left: 80, right: 470 }); openStep(el); } };
    });
  }
  /* Wide flows would be unreadable when fitted: open at a readable scale, starting at the left. */
  function readable(canvas) {
    canvas.zoom("fit-viewport", "auto");
    const vb = canvas.viewbox();
    const MIN = 0.72;
    if (vb.scale >= MIN) return;
    const w = vb.outer.width / MIN, h = vb.outer.height / MIN;
    canvas.viewbox({ x: vb.inner.x - 30, y: vb.inner.y + vb.inner.height / 2 - h / 2, width: w, height: h });
  }
  function mark(id, on) {
    const reg = viewer.get("elementRegistry"); if (!reg.get(id)) return;
    viewer.get("canvas")[on ? "addMarker" : "removeMarker"](id, "hl");
  }

  let selEl = null;
  function openStep(el) {
    const canvas = viewer.get("canvas");
    if (selEl) canvas.removeMarker(selEl, "sel");
    selEl = el.id; canvas.addMarker(el.id, "sel");
    const bo = el.businessObject;
    const t = el.type.replace("bpmn:", ""); const kind = KIND[t.charAt(0).toLowerCase() + t.slice(1)] ?? t;
    const st = R.steps[el.id];
    const from = rowsOf(R.processes[P]).filter((r) => r.step === el.id);
    const doc = bo.documentation?.[0]?.text;
    const timer = bo.eventDefinitions?.find((d) => d.$type === "bpmn:TimerEventDefinition");
    const cond = bo.conditionExpression?.body;
    let h = `<h4>${esc(bo.name || el.id)}</h4><p class="kind">${esc(kind)}</p>`;
    const notes = [st?.notes, ...from.filter((r) => r.fidelity !== "exact").map((r) => r.notes)].filter(Boolean);
    if (notes.length) h += `<p class="note">${esc([...new Set(notes)].join(" "))}</p>`;
    h += "<dl>";
    if (st?.capability) h += `<dt>Capability</dt><dd><code>${esc(st.capability)}</code></dd>`;
    if (st?.mode) h += `<dt>Mode</dt><dd>${esc(st.mode)}</dd>`;
    if (timer) h += `<dt>Schedule</dt><dd><code>${esc(timer.timeCycle?.body ?? "")}</code>${bo.$attrs?.["uapf:timezone"] ? ` in ${esc(bo.$attrs["uapf:timezone"])}` : ""}</dd>`;
    if (cond) h += `<dt>Condition</dt><dd><code>${esc(cond)}</code></dd>`;
    if (doc && !/^Converted from/.test(doc)) h += `<dt>Rule</dt><dd>${esc(doc)}</dd>`;
    h += "</dl>";
    if (from.length) h += `<h5>From Power Automate</h5><ul class="from">${from.map((r) => `<li>${esc(r.action.replace(/_/g, " "))} <span class="pill ${r.fidelity}">${FID[r.fidelity]}</span></li>`).join("")}</ul>`;
    if (st?.params && Object.keys(st.params).length) h += `<h5>Settings kept in the package</h5><pre>${esc(JSON.stringify(st.params, null, 2).slice(0, 6000))}</pre>`;
    $("stepBody").innerHTML = h;
    $("step").hidden = false;
  }
  $("stepX").onclick = () => { $("step").hidden = true; if (selEl) viewer.get("canvas").removeMarker(selEl, "sel"); selEl = null; };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("step").hidden) $("stepX").click(); });

  function drawReport() {
    const all = R.rows;
    const n = (k) => all.filter((r) => r.fidelity === k).length;
    const review = all.filter((r) => r.fidelity !== "exact");
    if (filter === "review" && !review.length) filter = "all";
    const opts = [["review", `To review ${review.length}`], ["exact", `Exact ${n("exact")}`], ["all", `All ${all.length}`]];
    $("chips").innerHTML = opts.map(([k, t]) => `<button class="chip" aria-pressed="${filter === k}" data-k="${k}">${esc(t)}</button>`).join("");
    $("chips").querySelectorAll("button").forEach((b) => b.onclick = () => { filter = b.dataset.k; drawReport(); });
    const list = filter === "review" ? review : filter === "exact" ? all.filter((r) => r.fidelity === "exact") : all;
    $("rows").innerHTML = `<thead><tr><th>Action</th>${R.processes.length > 1 ? "<th>Flow</th>" : ""}<th>Type</th><th>Becomes</th><th>Fidelity</th><th>Note</th></tr></thead><tbody>` +
      list.map((r) => `<tr ${r.step ? `data-step="${esc(r.step)}" data-flow="${esc(r.flow)}"` : ""}><td>${esc(r.action.replace(/_/g, " "))}</td>${R.processes.length > 1 ? `<td>${esc(r.flow)}</td>` : ""}
        <td>${esc(r.type)}${r.connector ? `<br><small>${esc(r.connector)}</small>` : ""}</td><td>${r.capability ? `<code>${esc(r.capability)}</code>` : ""}</td>
        <td><span class="pill ${r.fidelity}">${FID[r.fidelity]}</span></td><td class="note">${esc(r.notes ?? "")}</td></tr>`).join("") + "</tbody>";
    $("rows").querySelectorAll("tr[data-step]").forEach((tr) => tr.onclick = async () => {
      const i = R.processes.findIndex((p) => p.name === tr.dataset.flow);
      if (i !== P) { P = i; $("tabs").querySelectorAll(".tab").forEach((b) => b.setAttribute("aria-selected", +b.dataset.i === P)); await drawProcess(); }
      const el = viewer.get("elementRegistry").get(tr.dataset.step);
      if (el) { document.querySelector(".split").scrollIntoView({ block: "start" }); viewer.get("canvas").scrollToElement(el, { top: 120, bottom: 120, left: 80, right: 470 }); openStep(el); }
    });
  }

  function drawFiles() {
    const fs = R.files;
    $("fileList").innerHTML = fs.map((f, i) => `<li><button data-i="${i}" ${f.text == null ? "" : ""}><span>${esc(f.path)}</span><small>${f.size < 1024 ? f.size + " B" : (f.size / 1024).toFixed(1) + " KB"}</small></button></li>`).join("");
    const pick = (i) => {
      fileSel = i;
      $("fileList").querySelectorAll("button").forEach((b) => b.setAttribute("aria-current", +b.dataset.i === i));
      const f = fs[i];
      $("filePreview").textContent = f.text == null ? "The original flow definition is included in the download (trigger signatures redacted)." : f.text.slice(0, 60000);
    };
    $("fileList").querySelectorAll("button").forEach((b) => b.onclick = () => pick(+b.dataset.i));
    pick(Math.max(0, fs.findIndex((f) => f.path === "docs/conversion-report.md")));
  }

  $("download").onclick = () => {
    const bin = atob(R.uapf.base64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([u8], { type: "application/zip" }));
    a.download = R.uapf.name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };
})();
