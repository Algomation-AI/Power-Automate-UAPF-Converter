/**
 * Power Automate conditions come in two shapes: the designer's object form
 * ({"and":[{"equals":["@x", 1]}]}) and a plain expression string ("@equals(x, 1)").
 * The converter keeps the original verbatim in the package (contract.params) so a
 * host evaluates exactly what Power Automate evaluated; this module only renders a
 * readable text for diagram labels and the report.
 */
const OPS = { equals: "=", not_equals: "≠", greater: ">", greaterOrEquals: "≥", less: "<", lessOrEquals: "≤" };

export function operand(v) {
  if (typeof v === "string") {
    if (v.startsWith("@{")) return JSON.stringify(v);          // string template, shown as written
    if (v.startsWith("@")) return v.slice(1).replace(/\s+/g, " ").trim();
    return `'${v}'`;
  }
  return JSON.stringify(v);
}

export function render(cond) {
  if (cond == null) return "true";
  if (typeof cond === "string") return operand(cond);
  if (typeof cond !== "object") return JSON.stringify(cond);
  const [k, v] = Object.entries(cond)[0] ?? [];
  if (k === "and" || k === "or") return (v ?? []).map((x) => {
    const r = render(x); return /\b(and|or)\b/.test(r) && Object.keys(x)[0] !== k ? `(${r})` : r; }).join(` ${k} `);
  if (k === "not") {
    const inner = v ?? {};
    const [ik, iv] = Object.entries(inner)[0] ?? [];
    if (ik === "equals") return `${operand(iv[0])} ≠ ${operand(iv[1])}`;
    return `not (${render(inner)})`;
  }
  if (OPS[k]) return `${operand(v[0])} ${OPS[k]} ${operand(v[1])}`;
  if (Array.isArray(v)) return `${k}(${v.map(operand).join(", ")})`;
  return `${k}(${operand(v)})`;
}

/** Short label for a gateway: the rendered condition, trimmed for a diagram. */
export const label = (s, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
