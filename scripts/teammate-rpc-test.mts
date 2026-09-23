import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveTeammateCli, sessionResumeArgs, TeammateRpc } from "../extensions/teams/teammate-rpc.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-teams-rpc-"));
const fixturePath = path.join(tempDir, "rpc-child.mjs");

fs.writeFileSync(
	fixturePath,
	`import * as readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const command = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    data: command.type === "get_state" ? { sessionId: "fixture" } : undefined,
  }) + "\\n");
});
`,
	"utf8",
);

try {
	const ompCli = resolveTeammateCli({});
	assert.deepEqual(ompCli, { command: "omp", dialect: "omp" });
	assert.deepEqual(sessionResumeArgs(ompCli, "/tmp/session.jsonl"), ["--resume", "/tmp/session.jsonl"]);

	const piCli = resolveTeammateCli({ PI_TEAMS_CLI: "/opt/bin/pi" });
	assert.deepEqual(piCli, { command: "/opt/bin/pi", dialect: "pi" });
	assert.deepEqual(sessionResumeArgs(piCli, "/tmp/session.jsonl"), ["--session", "/tmp/session.jsonl"]);

	const overriddenDialect = resolveTeammateCli({ PI_TEAMS_CLI: "wrapper", PI_TEAMS_CLI_DIALECT: "omp" });
	assert.deepEqual(overriddenDialect, { command: "wrapper", dialect: "omp" });

	const worker = new TeammateRpc("fixture");
	await worker.start({
		command: process.execPath,
		commandArgs: [fixturePath],
		cwd: tempDir,
		env: {},
		args: [],
		startupTimeoutMs: 2_000,
	});
	assert.equal(worker.status, "idle");
	await worker.setSessionName("fixture session");
	await worker.stop();

	const missingWorker = new TeammateRpc("missing");
	await assert.rejects(
		missingWorker.start({
			command: path.join(tempDir, "missing-omp"),
			cwd: tempDir,
			env: {},
			args: [],
			startupTimeoutMs: 500,
		}),
		/ENOENT/,
	);
	assert.equal(missingWorker.status, "error");
	assert.match(missingWorker.lastError ?? "", /ENOENT/);

	console.log("OK: teammate RPC compatibility test passed");
} finally {
	fs.rmSync(tempDir, { recursive: true, force: true });
}
