#!/usr/bin/env node
/**
 * Web demo / on-prem service for the converter. Conversion happens in memory;
 * uploads and results are never written to disk or logged (only size and time).
 *
 *   GET  /                      the page
 *   GET  /api/samples           built-in sample exports
 *   POST /api/convert           body = export file (raw bytes), header X-Filename; or ?sample=<file>
 *   GET  /healthz
 *
 * env: PORT (8080), MAX_UPLOAD_MB (10), RATE_PER_MIN (30), PUBLIC_BASE_URL (for links)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { readExport } from "./read.js";
import { convert, zipPackage, VERSION } from "./package.js";
import { validatePackage } from "./validate.js";
import { mapAction } from "./catalog.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PORT ?? 8080);
const MAX = Number(process.env.MAX_UPLOAD_MB ?? 10) * 1024 * 1024;
const RATE = Number(process.env.RATE_PER_MIN ?? 30);
const SAMPLES = { "ContosoSamples_1_0_0_1.zip": "Contoso sample solution (3 flows)", "InvoiceApproval.json": "Invoice approval",
                  "DailyNewsDigest.json": "Daily news digest", "CustomerRequestTriage.json": "Customer request triage (AI)" };
const STATIC = {
  "/": ["web/index.html", "text/html; charset=utf-8"], "/app.js": ["web/app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["web/app.css", "text/css; charset=utf-8"], "/favicon.svg": ["web/favicon.svg", "image/svg+xml"],
};
const VENDOR = path.join(ROOT, "node_modules/bpmn-js/dist");
const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff",
                ".ttf": "font/ttf", ".eot": "application/vnd.ms-fontobject", ".svg": "image/svg+xml" };
const SECURITY = {
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const hits = new Map();
function limited(ip) {
  const now = Date.now(); const w = (hits.get(ip) ?? []).filter((t) => now - t < 60000);
  w.push(now); hits.set(ip, w);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60000)) hits.delete(k);
  return w.length > RATE;
}

/* Flow outline for the side-by-side view: what Power Automate showed, as a tree. */
function outline(actions, depth = 0, out = []) {
  for (const [n, a] of Object.entries(actions ?? {})) {
    const m = ["If", "Switch", "Foreach", "Until", "Scope"].includes(a.type) ? null : mapAction(n, a);
    out.push({ depth, name: n, type: a.type, connector: m?.label ?? "" });
    if (a.type === "If") { outline(a.actions, depth + 1, out); if (Object.keys(a.else?.actions ?? {}).length) { out.push({ depth: depth + 1, name: "Else", type: "branch" }); outline(a.else.actions, depth + 2, out); } }
    else if (a.type === "Switch") {
      for (const c of Object.values(a.cases ?? {})) { out.push({ depth: depth + 1, name: `Case "${c.case}"`, type: "branch" }); outline(c.actions, depth + 2, out); }
      if (a.default) { out.push({ depth: depth + 1, name: "Default", type: "branch" }); outline(a.default.actions, depth + 2, out); }
    } else if (a.actions) outline(a.actions, depth + 1, out);
  }
  return out;
}

async function doConvert(buf, filename) {
  const exp = await readExport(buf, filename);
  const res = await convert(exp);
  const validation = validatePackage(res.files);
  const mapping = YAML.parse(res.files.get("resources/mappings.yaml"));
  const steps = Object.fromEntries((mapping.bindings ?? []).map((b) => [b.source.ref, { capability: b.requiredCapabilities?.[0], mode: b.mode, params: b.contract?.params ?? {}, notes: b.notes ?? "" }]));
  const zip = await zipPackage(res.files);
  return {
    converter: VERSION, input: { filename, solution: exp.solution },
    summary: res.summary, rows: res.report, validation, steps,
    processes: res.summary.processes.map((p, i) => ({ ...p, xml: res.files.get(`bpmn/${p.id}.bpmn`),
      trigger: Object.entries(exp.flows[i].definition.triggers ?? {}).map(([k, t]) => `${k} (${t.type})`).join(", "),
      outline: outline(exp.flows[i].definition.actions) })),
    files: [...res.files].map(([p, c]) => ({ path: p, size: Buffer.byteLength(c), text: p.startsWith("docs/source/") ? null : c })),
    uapf: { name: `${res.packageId}.uapf`, base64: zip.toString("base64"), size: zip.length },
  };
}

const send = (res, code, body, type = "application/json; charset=utf-8", extra = {}) => {
  res.writeHead(code, { "Content-Type": type, ...SECURITY, ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const ip = req.headers["cf-connecting-ip"] ?? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ?? req.socket.remoteAddress;
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, version: VERSION });
    if (req.method === "GET" && STATIC[url.pathname]) {
      const [f, t] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(ROOT, f)), t, { "Cache-Control": "no-cache" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/fonts/")) {
      const m = url.pathname.match(/^\/fonts\/(sans|mono)-(latin|latin-ext)-(400|500|600)\.woff2$/);
      if (!m) return send(res, 404, { error: "not found" });
      const f = path.join(ROOT, "node_modules/@fontsource", m[1] === "sans" ? "ibm-plex-sans" : "ibm-plex-mono", "files",
                          `ibm-plex-${m[1]}-${m[2]}-${m[3]}-normal.woff2`);
      if (!fs.existsSync(f)) return send(res, 404, { error: "not found" });
      return send(res, 200, fs.readFileSync(f), "font/woff2", { "Cache-Control": "public, max-age=2592000, immutable" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/vendor/bpmn/")) {
      const f = path.normalize(path.join(VENDOR, url.pathname.slice("/vendor/bpmn/".length)));
      if (!f.startsWith(VENDOR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: "not found" });
      return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)] ?? "application/octet-stream", { "Cache-Control": "public, max-age=604800" });
    }
    if (req.method === "GET" && url.pathname === "/api/samples")
      return send(res, 200, { samples: Object.entries(SAMPLES).map(([file, title]) => ({ file, title })) });
    if (req.method === "GET" && url.pathname.startsWith("/samples/")) {
      const f = decodeURIComponent(url.pathname.slice(9));
      if (!SAMPLES[f]) return send(res, 404, { error: "not found" });
      return send(res, 200, fs.readFileSync(path.join(ROOT, "samples", f)), f.endsWith(".zip") ? "application/zip" : "application/json",
                  { "Content-Disposition": `attachment; filename="${f}"` });
    }
    if (req.method === "POST" && url.pathname === "/api/convert") {
      if (limited(ip)) return send(res, 429, { error: "Too many conversions from this address; try again in a minute." });
      const t0 = Date.now();
      let buf, filename;
      const sample = url.searchParams.get("sample");
      if (sample) {
        if (!SAMPLES[sample]) return send(res, 404, { error: "unknown sample" });
        buf = fs.readFileSync(path.join(ROOT, "samples", sample)); filename = sample;
        req.resume();
      } else {
        filename = String(req.headers["x-filename"] ?? "upload.json").replace(/[^\w.\- ]+/g, "_").slice(0, 120);
        const chunks = []; let size = 0;
        for await (const c of req) { size += c.length; if (size > MAX) return send(res, 413, { error: `File too large (max ${MAX / 1048576} MB).` }); chunks.push(c); }
        buf = Buffer.concat(chunks);
        if (!buf.length) return send(res, 400, { error: "Empty upload." });
      }
      try {
        const out = await doConvert(buf, filename);
        console.log(`convert ok ${buf.length} B ${Date.now() - t0} ms ${sample ? "sample" : "upload"}`);
        return send(res, 200, out, undefined, { "Cache-Control": "no-store" });
      } catch (e) {
        console.log(`convert failed ${buf.length} B ${Date.now() - t0} ms`);
        return send(res, 422, { error: String(e.message || e).slice(0, 400) });
      }
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: "internal error" });
  }
}).listen(PORT, () => console.log(`pa2uapf ${VERSION} web on :${PORT}`));
