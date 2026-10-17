/**
 * Read Power Automate exports into a list of flows:
 *   - solution .zip   (Workflows/*.json, solution.xml)          ← recommended export
 *   - legacy package  (Microsoft.Flow/flows/<id>/definition.json, manifest.json)
 *   - a single flow   .json ({properties:{definition}}, {definition} or the definition itself)
 * Everything happens in memory; nothing is written to disk.
 */
import JSZip from "jszip";

const tag = (xml, name) => (xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`)) ?? [])[1]?.trim();

function definitionOf(j) {
  if (j?.properties?.definition) return { definition: j.properties.definition, connectionReferences: j.properties.connectionReferences ?? {}, displayName: j.properties.displayName };
  if (j?.definition?.triggers || j?.definition?.actions) return { definition: j.definition, connectionReferences: j.connectionReferences ?? {}, displayName: j.displayName ?? j.name };
  if (j?.triggers || j?.actions) return { definition: j, connectionReferences: {}, displayName: undefined };
  return null;
}

/* Workflows/InvoiceApproval-6F1C....json -> "InvoiceApproval" */
const nameFromFile = (f) => f.split("/").pop().replace(/\.json$/i, "").replace(/-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i, "");
const idFromFile = (f) => (f.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i) ?? [])[1]?.toLowerCase();

export async function readExport(buf, filename = "flow.json") {
  const flows = [];
  let solution = null;
  if (/\.zip$/i.test(filename) || (buf[0] === 0x50 && buf[1] === 0x4b)) {
    const zip = await JSZip.loadAsync(buf);
    const files = Object.keys(zip.files);
    const solXml = files.find((f) => /(^|\/)solution\.xml$/i.test(f));
    if (solXml) {
      const x = await zip.file(solXml).async("string");
      solution = { uniqueName: tag(x, "UniqueName"), version: tag(x, "Version"),
                   displayName: (x.match(/<LocalizedName[^>]*description="([^"]+)"/) ?? [])[1] ?? tag(x, "UniqueName"),
                   publisher: (x.match(/<Publisher>[\s\S]*?<UniqueName>([^<]+)</) ?? [])[1] };
      const cust = files.find((f) => /customizations\.xml$/i.test(f));
      const names = {};
      if (cust) {
        const cx = await zip.file(cust).async("string");
        for (const m of cx.matchAll(/<Workflow WorkflowId="\{?([0-9a-f-]+)\}?" Name="([^"]+)"/gi)) names[m[1].toLowerCase()] = m[2];
      }
      for (const f of files.filter((f) => /^Workflows\/.+\.json$/i.test(f))) {
        const d = definitionOf(JSON.parse(await zip.file(f).async("string")));
        if (d) flows.push({ ...d, id: idFromFile(f), name: names[idFromFile(f)] ?? d.displayName ?? nameFromFile(f), source: f });
      }
    } else {
      for (const f of files.filter((f) => /definition\.json$/i.test(f))) {
        const j = JSON.parse(await zip.file(f).async("string"));
        const d = definitionOf(j);
        const dir = f.replace(/definition\.json$/i, "");
        let name = d?.displayName;
        const man = files.find((m) => m === dir + "manifest.json") ?? files.find((m) => /(^|\/)manifest\.json$/i.test(m));
        if (!name && man) { try { const mj = JSON.parse(await zip.file(man).async("string")); name = mj?.details?.displayName ?? (mj?.resources ? Object.values(mj.resources).find((r) => r.type === "Microsoft.Flow/flows")?.details?.displayName : undefined); } catch { /* optional */ } }
        if (d) flows.push({ ...d, id: idFromFile(f), name: name ?? nameFromFile(dir.replace(/\/$/, "")), source: f });
      }
    }
  } else {
    const j = JSON.parse(Buffer.from(buf).toString("utf8").replace(/^﻿/, ""));
    const list = Array.isArray(j) ? j : [j];
    for (const [i, x] of list.entries()) {
      const d = definitionOf(x);
      if (d) flows.push({ ...d, id: x.name ?? x.id ?? null, name: d.displayName ?? filename.replace(/\.json$/i, "").replace(/^.*[\\/]/, "") + (list.length > 1 ? `-${i + 1}` : ""), source: filename });
    }
  }
  if (!flows.length) throw new Error("No Power Automate flow definition found (expected a solution .zip, a legacy package .zip, or a flow definition .json).");
  return { solution, flows };
}
