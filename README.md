# Power-Automate-UAPF-Converter

Convert Power Automate flows into [UAPF](https://github.com/UAPFormat/UAPF-specification) process packages:
BPMN diagrams plus everything the flow knew, in an open, versioned format that any UAPF-IP host can run.

```
pa2uapf MySolution_1_0_0_1.zip            # → pa.my-solution.uapf
pa2uapf flow-definition.json -d out/      # → out/ as files
```

Input: a solution export (`.zip`, recommended), a legacy package export (`.zip`) or a single flow definition (`.json`).
Output: a UAPF 2.5.0 Level-4 package — `bpmn/`, `resources/`, `metadata/`, `docs/` — and a conversion report.

## What happens to a flow

| Power Automate | UAPF package |
|---|---|
| Recurrence trigger | Timer start event (cron, IANA time zone) |
| HTTP request / manual trigger | Start event; request schema in `resources/triggers.yaml` |
| Event triggers (e.g. "When an item is created") | Start event; the host polls or receives the webhook |
| Condition, Switch | Evaluate step + exclusive gateway (condition kept verbatim) |
| Apply to each, Do until | Loops built from gateways |
| Parallel branches (`runAfter`) | Parallel split / join |
| Scope with "run after has failed" (try/catch) | Failure branch after the scope, rejoining where the flow did |
| Variables, Compose, Filter array, Select, Parse JSON… | One data step per straight chain; operations kept verbatim |
| Connector actions | Generic capabilities, e.g. `sharepoint.get-items@1`, `mail.send@1`, `teams.post-message@1` |
| AI Builder prompt | `llm.prompt@1` — runs on the organisation's own model |
| Approvals | User task |
| Terminate | End event |

Order, branches and loops go into BPMN. Expressions and connector parameters go verbatim into
`resources/mappings.yaml` (`contract.params` of each step). Nothing about the flow is left for the agent to know,
so the package runs on any UAPF-IP host that offers the listed capabilities.

## Fidelity, stated per action

Every action is reported as **exact**, **approximated** (runs, but differs as noted) or **manual**
(no mapping; a person decides) in `docs/conversion-report.md`. Today the known approximations are:

- long human waits (approvals, "wait for response"): the reference engine waits at most 30 s per step;
- "run after has failed" paths: drawn, but reachable only if the host reports failures as values;
- parallel "Apply to each": runs item by item;
- AI Builder prompts: the prompt text is a Dataverse record, not part of the flow — add it as an Algorithm Card;
- connectors outside the catalogue (`src/catalog.js`): named, but need a host capability.

## Checks

```
npm test                                   # convert the samples, check structure
UAPF_ENGINE_DIR=../uapf-engine npm test    # + execute every process with the engine's own BPMN walker
```

`test/walk.cjs` runs each converted process through [uapf-engine](https://github.com/UAPFormat/uapf-engine)'s
BpmnWalker with random decisions and bounded loops, and reports which elements were reached.

## Samples

`samples/` holds invented flows (Contoso): an invoice approval, a daily news digest and an AI request triage,
also packed as a solution export. `node samples/make-samples.mjs` rebuilds them.

## Licence

Apache-2.0. See `LICENSE`.
