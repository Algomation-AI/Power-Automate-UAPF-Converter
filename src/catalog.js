/**
 * Power Automate → UAPF capability catalogue.
 *
 * Every action becomes a step that asks a UAPF-IP host for a generic capability
 * (namespace.operation@1). The catalogue decides the capability name and how
 * faithful the mapping is:
 *   exact        same semantics, host capability is a thin wrapper
 *   approximated runs, but behaviour differs in a way the report spells out
 *   manual       no mapping; a person must decide (step is still drawn)
 *
 * Unknown connectors are not guessed: they get <connector>.<operation>@1 and
 * fidelity "manual", so the report lists exactly which host capabilities a
 * deployment still needs.
 */

export const kebab = (s) => String(s ?? "")
  .replace(/^shared_/, "")
  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .replace(/[^A-Za-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .toLowerCase()
  .replace(/^([^a-z])/, "x$1") || "unknown";

/* Connectors seen in most business flows. op: operationId -> capability operation. */
export const CONNECTORS = {
  shared_sharepointonline: { ns: "sharepoint", label: "SharePoint", ops: {
    GetItems: "get-items", GetItem: "get-item", PostItem: "create-item", PatchItem: "update-item", DeleteItem: "delete-item",
    GetFileContent: "get-file-content", GetFileContentByPath: "get-file-content", CreateFile: "create-file",
    GetFileItems: "get-files", CopyFileAsync: "copy-file", HttpRequest: "http-request" } },
  shared_office365: { ns: "mail", label: "Office 365 Outlook", ops: {
    SendEmailV2: "send", SendEmail: "send", SendEmailV3: "send", SendMailWithOptions: "send-with-options",
    GetEmailsV3: "get-messages", ReplyToV3: "reply", Flag: "flag", MarkAsRead: "mark-read",
    V4CalendarPostItem: "create-event" } },
  shared_office365users: { ns: "directory", label: "Office 365 Users", ops: { UserProfile_V2: "get-user", Manager_V2: "get-manager", MyProfile_V2: "get-me" } },
  shared_teams: { ns: "teams", label: "Microsoft Teams", ops: {
    PostMessageToConversation: "post-message", PostMessageToChannelV3: "post-message", PostMessageToSelf: "post-message",
    PostCardToConversation: "post-card", PostCardAndWaitForResponse: "post-card-and-wait" } },
  shared_rss: { ns: "feed", label: "RSS", ops: { ListFeedItems: "read" } },
  shared_excelonlinebusiness: { ns: "excel", label: "Excel Online (Business)", ops: {
    GetItems: "list-rows", AddRowV2: "add-row", PatchItem: "update-row", DeleteItem: "delete-row", GetItem: "get-row" } },
  shared_onedriveforbusiness: { ns: "onedrive", label: "OneDrive for Business", ops: {
    GetFileContent: "get-file-content", GetFileContentByPath: "get-file-content", CreateFile: "create-file", ListFolder: "list-folder" } },
  shared_commondataserviceforapps: { ns: "dataverse", label: "Microsoft Dataverse", ops: {
    ListRecords: "list-rows", GetItem: "get-row", CreateRecord: "create-row", UpdateRecord: "update-row", DeleteRecord: "delete-row" } },
  shared_approvals: { ns: "task", label: "Approvals", human: true, ops: {
    StartAndWaitForAnApproval: "request", CreateAnApproval: "create", WaitForAnApproval: "wait" } },
  shared_planner: { ns: "planner", label: "Planner", ops: { CreateTask_V3: "create-task", UpdateTask_V2: "update-task" } },
  shared_flowpush: { ns: "notify", label: "Notifications", ops: { SendEmailNotification: "email", SendNotification: "push" } },
  shared_sql: { ns: "sql", label: "SQL Server", ops: { GetItems_V2: "get-rows", PostItem_V2: "insert-row", PatchItem_V2: "update-row", ExecutePassThroughNativeQuery_V2: "query" } },
};

/** AI Builder actions travel through the Dataverse connector. */
const AI_OPS = /^aibuilderpredict|^AIBuilder|predictionOutput|textgeneration/i;

/**
 * Decide the step for one action. Returns
 *   { kind: "service"|"user"|"data"|"respond"|"child"|"end"|"unknown",
 *     capability, connector, fidelity, notes[] }
 */
export function mapAction(name, a) {
  const t = a.type;
  const notes = [];
  const svc = (capability, fidelity = "exact", extra = {}) => ({ kind: "service", capability, fidelity, notes, ...extra });

  if (t === "OpenApiConnection" || t === "ApiConnection") {
    const host = a.inputs?.host ?? {};
    const apiName = (host.apiId ?? host.connectionName ?? host.connection?.name ?? host.api?.runtimeUrl ?? "")
      .split("/").pop() || host.connectionName || "unknown";
    const op = host.operationId ?? a.inputs?.path ?? "operation";
    if (/commondataservice/i.test(apiName) && AI_OPS.test(op)) {
      notes.push("AI Builder prompt: the prompt text is a Dataverse record, not part of the flow definition. Add it as an Algorithm Card (llm_prompt) with at least two tests; the host runs it on the organisation's own LLM.");
      return svc("llm.prompt@1", "approximated", { connector: "AI Builder", label: "AI Builder" });
    }
    const c = CONNECTORS[apiName];
    if (!c) {
      notes.push(`Connector ${apiName} is not in the catalogue: the host needs a ${kebab(apiName)}.${kebab(op)} capability.`);
      return svc(`${kebab(apiName)}.${kebab(op)}@1`, "manual", { connector: apiName, label: apiName });
    }
    const opName = c.ops[op] ?? kebab(op);
    if (!c.ops[op]) notes.push(`Operation ${op} of ${c.label} is not in the catalogue; mapped by name.`);
    if (c.human) {
      notes.push("Waits for a person. The engine waits at most 30 s for a step, so long human waits need the engine's asynchronous user tasks (not in uapf-engine 1.1.0).");
      return { kind: "user", capability: `${c.ns}.${opName}@1`, fidelity: "approximated", connector: apiName, label: c.label, notes };
    }
    if (op === "PostCardAndWaitForResponse") notes.push("Waits for a reply in Teams: same 30 s limit as approvals.");
    return svc(`${c.ns}.${opName}@1`, c.ops[op] && op !== "PostCardAndWaitForResponse" ? "exact" : "approximated", { connector: apiName, label: c.label });
  }
  if (t === "OpenApiConnectionWebhook" || t === "ApiConnectionWebhook") {
    notes.push("Webhook action (waits for an external callback). Needs asynchronous support in the engine.");
    return { kind: "user", capability: "task.request@1", fidelity: "approximated", notes };
  }
  switch (t) {
    case "Http": {
      const uri = String(a.inputs?.uri ?? "");
      if (/\/workflows\/|triggers\/manual\/paths\/invoke|REDACTED.*(flow|trigger)/i.test(uri)) {
        notes.push("HTTP call to another flow's trigger URL: probably a child flow. Consider replacing it with flow.run@1 to the converted process.");
        return svc("http.request@1", "approximated");
      }
      return svc("http.request@1");
    }
    case "HttpWebhook": notes.push("HTTP webhook waits for a callback."); return { kind: "user", capability: "task.request@1", fidelity: "approximated", notes };
    case "Workflow": return { kind: "child", capability: "flow.run@1", fidelity: "exact", notes };
    case "Response": return { kind: "respond", capability: "flow.respond@1", fidelity: "exact", notes };
    case "Terminate": return { kind: "end", fidelity: "exact", notes };
    case "Wait": case "Delay": case "DelayUntil":
      notes.push("Delay: the engine has no timer events and waits at most 30 s per step.");
      return svc("timer.wait@1", "approximated");
    case "InitializeVariable": case "SetVariable": case "IncrementVariable": case "DecrementVariable":
    case "AppendToStringVariable": case "AppendToArrayVariable": case "Compose": case "ParseJson":
    case "Query": case "Select": case "Join": case "Table":
      return { kind: "data", capability: "data.transform@1", fidelity: "exact", notes };
    case "Expression": return { kind: "data", capability: "data.transform@1", fidelity: "exact", notes };
    default:
      notes.push(`Action type ${t} has no mapping yet.`);
      return { kind: "unknown", capability: `pa.${kebab(t)}@1`, fidelity: "manual", notes };
  }
}

/* Windows time zones used in flow recurrences → IANA (CLDR windowsZones, territory 001). */
export const WINDOWS_TZ = {
  "FLE Standard Time": "Europe/Kiev", "GTB Standard Time": "Europe/Bucharest", "E. Europe Standard Time": "Europe/Chisinau",
  "W. Europe Standard Time": "Europe/Berlin", "Central Europe Standard Time": "Europe/Budapest", "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris", "GMT Standard Time": "Europe/London", "UTC": "Etc/UTC", "Coordinated Universal Time": "Etc/UTC",
  "Russian Standard Time": "Europe/Moscow", "Eastern Standard Time": "America/New_York", "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver", "Pacific Standard Time": "America/Los_Angeles", "Tokyo Standard Time": "Asia/Tokyo",
  "China Standard Time": "Asia/Shanghai", "India Standard Time": "Asia/Calcutta", "AUS Eastern Standard Time": "Australia/Sydney",
};
