/**
 * mcp-client.mts — Phase 3 acceptance: a real MCP client connects to the server over stdio,
 * lists tools, and calls them against the same tracker DB. This is what Claude Code / Claude
 * Desktop do; if one MCP client works, both do (identical stdio protocol).
 * Usage: npx tsx test/mcp-client.mts   (run AFTER `cli source` has populated data_acc/acc.db)
 */
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const AGENT = path.resolve(HERE, "..");
const DB = path.join(AGENT, "data_acc", "acc.db");
if (!fs.existsSync(DB)) {
  console.error("Run `JOBS_DB=data_acc/acc.db tsx src/cli.ts source` first to populate the DB.");
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
};

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcp/server.ts"],
  cwd: AGENT,
  env: { ...process.env, JOBS_DB: DB, APPLY_MODE: "dryrun" } as Record<string, string>,
});
const client = new Client({ name: "acceptance-client", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
const expected = ["fill_form", "halt", "report", "resume", "score_fit", "search_jobs", "tailor_application", "track"];
check("server exposes all 8 tools", expected.every((e) => names.includes(e)), names.join(", "));

const status = await client.callTool({ name: "track", arguments: { action: "status" } });
const statusText = (status.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
const statusObj = JSON.parse(statusText);
check("track status returns DB jobs over MCP", typeof statusObj.jobs === "number" && statusObj.jobs > 0, `jobs=${statusObj.jobs}, mode=${statusObj.mode}`);

const jobsRes = await client.callTool({ name: "track", arguments: { action: "list_jobs", limit: 1 } });
const firstJob = JSON.parse((jobsRes.content as Array<{ text: string }>)[0]?.text ?? "[]")[0];
check("track list_jobs returns a job", Boolean(firstJob?.id), firstJob ? `#${firstJob.id} ${firstJob.company}` : "none");

if (firstJob?.id) {
  const scoreRes = await client.callTool({ name: "score_fit", arguments: { jobId: firstJob.id } });
  const scoreObj = JSON.parse((scoreRes.content as Array<{ text: string }>)[0]?.text ?? "{}");
  check("score_fit computes a score over MCP", typeof scoreObj.score?.overall === "number", `overall=${scoreObj.score?.overall}, verdict=${scoreObj.score?.verdict}`);
}

const reportRes = await client.callTool({ name: "report", arguments: {} });
const reportMd = (reportRes.content as Array<{ text: string }>)[0]?.text ?? "";
check("report tool returns markdown", reportMd.includes("# Job-Apply Daily Report"));

await client.close();
console.log(`\n=== MCP (Phase 3): ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
