// Builds the public sample flows (invented, no customer material) and a solution .zip containing them.
// usage: node samples/make-samples.mjs   → samples/*.json + samples/ContosoSamples_1_0_0_1.zip
import fs from "node:fs";
import JSZip from "jszip";

const conn = (api) => ({ host: { apiId: `/providers/Microsoft.PowerApps/apis/${api}`, connectionName: api, operationId: "" } });
const op = (api, operationId, parameters, runAfter = {}) => ({ type: "OpenApiConnection", runAfter,
  inputs: { host: { ...conn(api).host, operationId }, parameters, authentication: "@parameters('$authentication')" } });
const ok = (n) => ({ [n]: ["Succeeded"] });
const wrap = (displayName, triggers, actions, refs) => ({ properties: { displayName, definition: {
  $schema: "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
  contentVersion: "1.0.0.0", parameters: { $authentication: { defaultValue: {}, type: "SecureObject" } }, triggers, actions },
  connectionReferences: Object.fromEntries(refs.map((r) => [r, { api: { name: r }, connection: { connectionReferenceLogicalName: `contoso_${r}` }, runtimeSource: "embedded" }])) },
  schemaVersion: "1.0.0.0" });

/* 1 ─ Invoice approval: SharePoint event trigger, condition, approval, switch on outcome, mail, update, terminate */
const invoice = wrap("Invoice approval", {
  When_an_invoice_is_created: { type: "OpenApiConnection", recurrence: { interval: 5, frequency: "Minute" },
    inputs: { host: { ...conn("shared_sharepointonline").host, operationId: "GetOnNewItems" }, parameters: { dataset: "https://contoso.sharepoint.com/sites/finance", table: "Invoices" } } },
}, {
  Initialize_threshold: { type: "InitializeVariable", runAfter: {}, inputs: { variables: [{ name: "Threshold", type: "integer", value: 5000 }] } },
  Check_amount: { type: "If", runAfter: ok("Initialize_threshold"),
    expression: { and: [{ greater: ["@triggerOutputs()?['body/Amount']", "@variables('Threshold')"] }] },
    actions: {
      Start_and_wait_for_an_approval: op("shared_approvals", "StartAndWaitForAnApproval", {
        approvalType: "Basic", "WebhookApprovalCreationInput/title": "Approve invoice @{triggerOutputs()?['body/Title']}",
        "WebhookApprovalCreationInput/assignedTo": "finance-approvers@contoso.example" }),
      Outcome: { type: "Switch", runAfter: ok("Start_and_wait_for_an_approval"), expression: "@outputs('Start_and_wait_for_an_approval')?['body/outcome']",
        cases: {
          Approved: { case: "Approve", actions: { Mark_approved: op("shared_sharepointonline", "PatchItem", { dataset: "https://contoso.sharepoint.com/sites/finance", table: "Invoices", id: "@triggerOutputs()?['body/ID']", "item/Status": "Approved" }) } },
          Rejected: { case: "Reject", actions: {
            Mark_rejected: op("shared_sharepointonline", "PatchItem", { dataset: "https://contoso.sharepoint.com/sites/finance", table: "Invoices", id: "@triggerOutputs()?['body/ID']", "item/Status": "Rejected" }),
            Tell_the_submitter: op("shared_office365", "SendEmailV2", { "emailMessage/To": "@triggerOutputs()?['body/Author/Email']", "emailMessage/Subject": "Invoice rejected", "emailMessage/Body": "<p>@{outputs('Start_and_wait_for_an_approval')?['body/responses'][0]['comments']}</p>" }, ok("Mark_rejected")) } },
        },
        default: { actions: { Stop_unknown_outcome: { type: "Terminate", runAfter: {}, inputs: { runStatus: "Failed", runError: { message: "Unknown approval outcome" } } } } } },
    },
    else: { actions: { Auto_approve: op("shared_sharepointonline", "PatchItem", { dataset: "https://contoso.sharepoint.com/sites/finance", table: "Invoices", id: "@triggerOutputs()?['body/ID']", "item/Status": "Approved (under threshold)" }) } } },
  Post_to_accounting_system: op("shared_contosoerp", "CreateLedgerEntry", { amount: "@triggerOutputs()?['body/Amount']", reference: "@triggerOutputs()?['body/Title']" }, ok("Check_amount")),
}, ["shared_sharepointonline", "shared_approvals", "shared_office365", "shared_contosoerp"]);

/* 2 ─ Daily news digest: weekday schedule, RSS, parallel foreach, filter, append to string, do-until retry, Teams */
const digest = wrap("Daily news digest", {
  Weekdays_at_8: { type: "Recurrence", recurrence: { frequency: "Week", interval: 1, timeZone: "W. Europe Standard Time",
    schedule: { weekDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], hours: ["8"], minutes: [0] } } },
}, {
  Digest_text: { type: "InitializeVariable", runAfter: {}, inputs: { variables: [{ name: "Digest", type: "string", value: "" }] } },
  Attempts: { type: "InitializeVariable", runAfter: ok("Digest_text"), inputs: { variables: [{ name: "Attempts", type: "integer", value: 0 }] } },
  List_feed_items: op("shared_rss", "ListFeedItems", { feedUrl: "https://news.example.org/rss", since: "@{addDays(utcNow(), -1)}" }, ok("Attempts")),
  Only_regulation_news: { type: "Query", runAfter: ok("List_feed_items"),
    inputs: { from: "@outputs('List_feed_items')?['body']", where: "@contains(toLower(item()?['title']), 'regulation')" } },
  For_each_article: { type: "Foreach", runAfter: ok("Only_regulation_news"), foreach: "@body('Only_regulation_news')",
    runtimeConfiguration: { concurrency: { repetitions: 5 } },
    actions: { Add_line: { type: "AppendToStringVariable", runAfter: {}, inputs: { name: "Digest", value: "- @{items('For_each_article')?['title']} @{items('For_each_article')?['primaryLink']}\n" } } } },
  Retry_until_posted: { type: "Until", runAfter: ok("For_each_article"), expression: "@or(equals(variables('Attempts'), 3), not(empty(outputs('Post_digest')?['body/id'])))",
    limit: { count: 3, timeout: "PT1H" },
    actions: {
      Post_digest: op("shared_teams", "PostMessageToConversation", { poster: "Flow bot", location: "Channel", "body/recipient/groupId": "00000000-0000-0000-0000-000000000000", "body/recipient/channelId": "19:example@thread.tacv2", "body/messageBody": "@variables('Digest')" }),
      Count_attempt: { type: "IncrementVariable", runAfter: { Post_digest: ["Succeeded", "Failed"] }, inputs: { name: "Attempts", value: 1 } },
    } },
}, ["shared_rss", "shared_teams"]);

/* 3 ─ Request triage with AI: HTTP trigger, parse, AI Builder, switch, parallel notify, try/catch, response */
const triage = wrap("Customer request triage", {
  manual: { type: "Request", kind: "Http", inputs: { schema: { type: "object", properties: { email: { type: "string" }, subject: { type: "string" }, text: { type: "string" } } } } },
}, {
  Try: { type: "Scope", runAfter: {}, actions: {
    Classify_request: op("shared_commondataserviceforapps", "aibuilderpredict_customprompt", { recordId: "11111111-2222-3333-4444-555555555555", "item/requestv2/Text": "@triggerBody()?['text']" }),
    Category: { type: "Compose", runAfter: ok("Classify_request"), inputs: "@toLower(trim(outputs('Classify_request')?['body/responsev2/predictionOutput/text']))" },
    Route: { type: "Switch", runAfter: ok("Category"), expression: "@outputs('Category')", cases: {
      Complaint: { case: "complaint", actions: {
        Create_case: op("shared_commondataserviceforapps", "CreateRecord", { entityName: "incidents", "item/title": "@triggerBody()?['subject']", "item/description": "@triggerBody()?['text']" }),
        Notify_support_lead: op("shared_teams", "PostMessageToConversation", { poster: "Flow bot", location: "Chat with Flow bot", "body/recipient": "lead@contoso.example", "body/messageBody": "New complaint: @{triggerBody()?['subject']}" }, ok("Create_case")),
        Acknowledge_customer: op("shared_office365", "SendEmailV2", { "emailMessage/To": "@triggerBody()?['email']", "emailMessage/Subject": "We received your complaint", "emailMessage/Body": "<p>Case @{outputs('Create_case')?['body/ticketnumber']}</p>" }, ok("Create_case")) } },
      Order: { case: "order", actions: { Forward_to_sales: { type: "Http", runAfter: {}, inputs: { method: "POST", uri: "https://sales.contoso.example/api/leads", body: "@triggerBody()" } } } },
    }, default: { actions: { Log_other: { type: "Compose", runAfter: {}, inputs: "Unclassified: @{outputs('Category')}" } } } },
  } },
  Catch: { type: "Scope", runAfter: { Try: ["Failed", "TimedOut"] }, actions: {
    Alert_operator: op("shared_flowpush", "SendEmailNotification", { NotificationEmailDefinition: { notificationSubject: "Triage failed", notificationBody: "@{result('Try')}" } }) } },
  Respond: { type: "Response", runAfter: { Catch: ["Succeeded", "Skipped"] }, kind: "Http", inputs: { statusCode: 202, body: { category: "@outputs('Category')" } } },
}, ["shared_commondataserviceforapps", "shared_teams", "shared_office365", "shared_flowpush"]);

const flows = { "InvoiceApproval": invoice, "DailyNewsDigest": digest, "CustomerRequestTriage": triage };
const guids = ["6f1c2a4e-1b2d-4c3e-9f10-1a2b3c4d5e01", "6f1c2a4e-1b2d-4c3e-9f10-1a2b3c4d5e02", "6f1c2a4e-1b2d-4c3e-9f10-1a2b3c4d5e03"];
const dir = new URL(".", import.meta.url).pathname;
const zip = new JSZip();
let cust = `<?xml version="1.0" encoding="utf-8"?>\n<ImportExportXml><Workflows>\n`;
Object.entries(flows).forEach(([n, f], i) => {
  fs.writeFileSync(`${dir}${n}.json`, JSON.stringify(f, null, 2) + "\n");
  const g = guids[i].toUpperCase();
  zip.file(`Workflows/${n}-${g}.json`, JSON.stringify(f));
  cust += `  <Workflow WorkflowId="{${guids[i]}}" Name="${f.properties.displayName}"><JsonFileName>/Workflows/${n}-${g}.json</JsonFileName><Category>5</Category></Workflow>\n`;
});
cust += `</Workflows></ImportExportXml>\n`;
zip.file("customizations.xml", cust);
zip.file("solution.xml", `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.0.0" SolutionPackageVersion="9.2" languagecode="1033"><SolutionManifest>
<UniqueName>ContosoSamples</UniqueName><LocalizedNames><LocalizedName description="Contoso sample flows" languagecode="1033" /></LocalizedNames>
<Version>1.0.0.1</Version><Managed>0</Managed><Publisher><UniqueName>contoso</UniqueName></Publisher></SolutionManifest></ImportExportXml>
`);
zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/octet-stream" /><Default Extension="json" ContentType="application/octet-stream" /></Types>`);
fs.writeFileSync(`${dir}ContosoSamples_1_0_0_1.zip`, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log("samples written:", Object.keys(flows).join(", "), "+ ContosoSamples_1_0_0_1.zip");
