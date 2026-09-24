/**
 * Integration test: named OMP agent profiles run through the teams leader.
 *
 * Usage:
 *   bun scripts/integration-profiled-spawn-test.mts
 *   bun scripts/integration-profiled-spawn-test.mts --provider-smoke
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { writeToMailbox } from "../extensions/teams/mailbox.js";
import { taskAssignmentPayload } from "../extensions/teams/protocol.js";
import { getTask, createTask } from "../extensions/teams/task-store.js";
import { TeammateRpc, resolveTeammateCli } from "../extensions/teams/teammate-rpc.js";
import { sleep, terminateAll } from "./lib/pi-workers.js";

const JsonObject = Type.Record(Type.String(), Type.Unknown());
type JsonObject = Static<typeof JsonObject>;

type RpcCommand = { id?: string; type: "get_state" } | { id?: string; type: "prompt"; message: string };
type RpcResponse = { id?: string; type: "response"; command: string; success: boolean; data?: unknown; error?: string };
type PendingRequest = { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };
type MemberSnapshot = { name: string; status?: string; sessionFile?: string; meta?: JsonObject };

function parseJsonObject(value: unknown): JsonObject | null {
	return Value.Check(JsonObject, value) ? value : null;
}

function parseArgs(argv: readonly string[]): { timeoutSec: number; providerSmoke: boolean } {
	let timeoutSec = 120;
	let providerSmoke = false;
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === "--provider-smoke") providerSmoke = true;
		if (argv[index] === "--timeoutSec") {
			const value = argv[index + 1];
			if (value) timeoutSec = Number.parseInt(value, 10);
			index += 1;
		}
	}
	if (!Number.isFinite(timeoutSec) || timeoutSec < 30) timeoutSec = 120;
	return { timeoutSec, providerSmoke };
}

function safeJsonParse(line: string): unknown | null {
	try {
		return JSON.parse(line) as unknown;
	} catch {
		return null;
	}
}

function isRpcResponse(value: unknown): value is RpcResponse {
	const object = parseJsonObject(value);
	return (
		object !== null &&
		object.type === "response" &&
		typeof object.command === "string" &&
		typeof object.success === "boolean" &&
		(object.id === undefined || typeof object.id === "string")
	);
}

function isNotification(value: unknown): value is { notifyType: string; message: string } {
	const object = parseJsonObject(value);
	return (
		object !== null &&
		object.type === "extension_ui_request" &&
		object.method === "notify" &&
		typeof object.notifyType === "string" &&
		typeof object.message === "string"
	);
}

function getString(record: JsonObject | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

function readMember(teamDir: string, name: string): MemberSnapshot | null {
	try {
		const config = parseJsonObject(JSON.parse(fs.readFileSync(path.join(teamDir, "config.json"), "utf8")) as unknown);
		if (!config || !Array.isArray(config.members)) return null;
		for (const rawMember of config.members) {
			const member = parseJsonObject(rawMember);
			if (!member || member.name !== name) continue;
			return {
				name,
				status: typeof member.status === "string" ? member.status : undefined,
				sessionFile: typeof member.sessionFile === "string" ? member.sessionFile : undefined,
				meta: parseJsonObject(member.meta) ?? undefined,
			};
		}
		return null;
	} catch {
		return null;
	}
}

async function waitFor<T>(
	probe: () => T | null | undefined | Promise<T | null | undefined>,
	opts: { timeoutMs: number; label: string },
): Promise<T> {
	const deadline = Date.now() + opts.timeoutMs;
	while (Date.now() < deadline) {
		const result = await probe();
		if (result !== null && result !== undefined) return result;
		await sleep(250);
	}
	throw new Error(`Timeout waiting for ${opts.label}`);
}

function writeProfile(agentDir: string, name: string, skill?: string): void {
	const autoloadSkills = skill ? `autoloadSkills: [${JSON.stringify(skill)}]\n` : "";
	fs.writeFileSync(
		path.join(agentDir, `${name}.md`),
		`---\nname: ${name}\ndescription: Integration-only named profile\nmodel: openai-codex/gpt-5.6-terra\nthinkingLevel: high\ntools: [read, grep]\nspawns: []\n${autoloadSkills}---\nProfile system prompt marker: ${name}.\n`,
		"utf8",
	);
}

function toolNamesFromState(state: unknown): string[] {
	const object = parseJsonObject(state);
	if (!object || !Array.isArray(object.dumpTools)) return [];
	return object.dumpTools.flatMap((tool) => {
		const entry = parseJsonObject(tool);
		return entry && typeof entry.name === "string" ? [entry.name] : [];
	});
}

const { timeoutSec, providerSmoke } = parseArgs(process.argv.slice(2));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-profiled-spawn-"));
const projectDir = path.join(tempRoot, "project");
const agentDir = path.join(projectDir, ".omp", "agents");
const skillDir = path.join(projectDir, ".omp", "skills", "profile-test-skill");
const teamsRootDir = path.join(tempRoot, "teams");
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const entryPath = path.join(repoRoot, "extensions", "teams", "index.ts");
const profiledWorkerPath = path.join(repoRoot, "extensions", "teams", "profiled-worker.ts");
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(teamsRootDir, { recursive: true });
const leader = spawn(resolveTeammateCli().command, ["--mode", "rpc", "--no-session", "--no-extensions", "-e", entryPath], {
	cwd: projectDir,
	env: {
		...process.env,
		PI_TEAMS_ROOT_DIR: teamsRootDir,
		PI_TEAMS_WORKER: "0",
		PI_TEAMS_TEAM_ID: "",
		PI_TEAMS_AGENT_NAME: "",
		PI_TEAMS_TASK_LIST_ID: "",
		PI_TEAMS_LEAD_NAME: "",
		PI_TEAMS_AUTO_CLAIM: "",
	},
	stdio: ["pipe", "pipe", "pipe"],
});
const children: ChildProcess[] = [leader];
const pending = new Map<string, PendingRequest>();
const notifications: Array<{ notifyType: string; message: string }> = [];
let nextRequestId = 1;
let leaderStderr = "";
let teamDir = "";

leader.stderr.on("data", (chunk: Buffer | string) => {
	leaderStderr += chunk.toString();
});
leader.on("close", () => {
	for (const [id, request] of pending) {
		clearTimeout(request.timeout);
		request.reject(new Error(`Leader exited before response ${id}: ${leaderStderr}`));
	}
	pending.clear();
});
const lines = readline.createInterface({ input: leader.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
	const value = safeJsonParse(line);
	if (value === null) return;
	if (isRpcResponse(value) && value.id) {
		const request = pending.get(value.id);
		if (!request) return;
		pending.delete(value.id);
		clearTimeout(request.timeout);
		request.resolve(value);
		return;
	}
	if (isNotification(value)) notifications.push(value);
});

async function request(command: RpcCommand): Promise<RpcResponse> {
	const id = command.id ?? `request-${nextRequestId++}`;
	leader.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
	return await new Promise<RpcResponse>((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Timeout waiting for ${command.type}: ${leaderStderr}`));
		}, timeoutSec * 1000);
		pending.set(id, { resolve, reject, timeout });
	});
}

async function prompt(message: string): Promise<void> {
	const response = await request({ type: "prompt", message });
	assert(response.success, `Leader rejected '${message}': ${response.error ?? "unknown error"}`);
}

try {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "profile-fixture.txt"), "profile task evidence\n", "utf8");
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: profile-test-skill\ndescription: Integration-only skill\n---\nSkill injection marker: profile-test-skill.\n", "utf8");
	writeProfile(agentDir, "repo-reader", "profile-test-skill");
	fs.writeFileSync(
		path.join(agentDir, "exec-reader.md"),
		"---\nname: exec-reader\ndescription: Integration-only exec profile\nmodel: openai-codex/gpt-5.6-terra\nthinkingLevel: low\ntools: [exec]\nspawns: [repo-reader]\n---\nExec profile.\n",
		"utf8",
	);
	writeProfile(agentDir, "disabled-reader");
	writeProfile(agentDir, "missing-skill-reader", "does-not-exist");
	fs.writeFileSync(path.join(projectDir, ".omp", "config.yml"), "task:\n  disabledAgents:\n    - disabled-reader\n", "utf8");

	const leaderState = await request({ type: "get_state" });
	const leaderStateData = parseJsonObject(leaderState.data);
	assert(leaderState.success && leaderStateData, `Leader get_state failed: ${leaderState.error ?? "unknown error"}`);
	const teamId = getString(leaderStateData, "sessionId");
	assert(teamId, `Leader get_state did not return a session id: ${JSON.stringify(leaderState.data)}`);
	teamDir = path.join(teamsRootDir, teamId);

	const beforeReaderSpawn = notifications.length;
	await prompt("/team spawn reader --agent repo-reader");
	const reader = await waitFor(
		() => {
			const startupError = notifications.slice(beforeReaderSpawn).find((event) => event.notifyType === "error");
			if (startupError) throw new Error(`Profiled reader startup failed: ${startupError.message}`);
			const member = readMember(teamDir, "reader");
			return member?.status === "online" && getString(member.meta, "agent") === "repo-reader" ? member : null;
		},
		{ timeoutMs: timeoutSec * 1000, label: "profiled reader online" },
	);
	assert.equal(getString(reader.meta, "model"), "openai-codex/gpt-5.6-terra", "profile model was not selected");
	assert.equal(getString(reader.meta, "thinkingLevel"), "high", "profile thinking level was not selected");
	assert(reader.sessionFile, "profiled reader must have a source session file");

	const probeSessionDir = path.join(tempRoot, "probe-sessions");
	const probeSource = path.join(tempRoot, "probe-source.jsonl");
	fs.copyFileSync(reader.sessionFile, probeSource);
	const probe = new TeammateRpc("profile-probe", probeSource);
	try {
		await probe.start({
			command: process.execPath,
			commandArgs: [profiledWorkerPath],
			cwd: projectDir,
			env: {
				PI_TEAMS_ROOT_DIR: teamsRootDir,
				PI_TEAMS_WORKER: "1",
				PI_TEAMS_TEAM_ID: "profile-probe-team",
				PI_TEAMS_TASK_LIST_ID: "profile-probe-team",
				PI_TEAMS_AGENT_NAME: "profile-probe",
				PI_TEAMS_LEAD_NAME: "team-lead",
				PI_TEAMS_STYLE: "normal",
				PI_TEAMS_AUTO_CLAIM: "0",
			},
			args: [
				"--agent",
				"repo-reader",
				"--session-file",
				probeSource,
				"--session-dir",
				probeSessionDir,
				"--model",
				"openai-codex/gpt-6-sol",
				"--thinking",
				"medium",
				"--append-system-prompt",
				"You are teammate 'profile-probe'.",
			],
		});
		const profileState = parseJsonObject(await probe.getState());
		assert(profileState, "profile worker did not return get_state data");
		assert.equal(getString(profileState, "thinkingLevel"), "medium", "explicit profile worker thinking override was not applied");
		assert(String(profileState.systemPrompt ?? "").includes("Profile system prompt marker: repo-reader."), "profile system prompt was not applied");
		const profileModel = parseJsonObject(profileState.model);
		assert(profileModel, "profile worker did not return a resolved model");
		assert.equal(getString(profileModel, "provider"), "openai-codex", "profile worker provider mismatch");
		assert.equal(getString(profileModel, "id"), "gpt-6-sol", "explicit profile worker model override was not applied");
		const tools = toolNamesFromState(profileState);
		assert(tools.includes("read") && tools.includes("grep"), `profile tool allowlist missing read/grep: ${tools.join(", ")}`);
		for (const forbidden of ["edit", "write", "task", "yield"]) {
			assert(!tools.includes(forbidden), `forbidden profile tool '${forbidden}' appeared in child get_state`);
		}
		const probeSessionFile = getString(profileState, "sessionFile");
		assert(probeSessionFile && fs.readFileSync(probeSessionFile, "utf8").includes("Skill injection marker: profile-test-skill."), "autoloaded skill was not injected into the profile session");
	} finally {
		await probe.stop();
	}

	const execSource = path.join(tempRoot, "exec-source.jsonl");
	fs.copyFileSync(reader.sessionFile, execSource);
	const execProbe = new TeammateRpc("exec-probe", execSource);
	try {
		await execProbe.start({
			command: process.execPath,
			commandArgs: [profiledWorkerPath],
			cwd: projectDir,
			env: {
				PI_TEAMS_ROOT_DIR: teamsRootDir,
				PI_TEAMS_WORKER: "1",
				PI_TEAMS_TEAM_ID: "exec-probe-team",
				PI_TEAMS_TASK_LIST_ID: "exec-probe-team",
				PI_TEAMS_AGENT_NAME: "exec-probe",
				PI_TEAMS_LEAD_NAME: "team-lead",
				PI_TEAMS_AUTO_CLAIM: "0",
			},
			args: ["--agent", "exec-reader", "--session-file", execSource, "--session-dir", path.join(tempRoot, "exec-sessions"), "--append-system-prompt", "You are teammate 'exec-probe'."],
		});
		const execTools = toolNamesFromState(await execProbe.getState());
		assert(execTools.includes("bash") && execTools.includes("eval") && execTools.includes("task"), `exec alias/spawn policy lost tools: ${execTools.join(", ")}`);
		assert(!execTools.includes("edit") && !execTools.includes("write") && !execTools.includes("yield"), `exec profile unexpectedly exposes forbidden tools: ${execTools.join(", ")}`);
	} finally {
		await execProbe.stop();
	}

	const badModelSource = path.join(tempRoot, "bad-model-source.jsonl");
	fs.copyFileSync(reader.sessionFile, badModelSource);
	const badModelProbe = new TeammateRpc("bad-model-probe", badModelSource);
	try {
		await assert.rejects(
			badModelProbe.start({
				command: process.execPath,
				commandArgs: [profiledWorkerPath],
				cwd: projectDir,
				env: {
					PI_TEAMS_ROOT_DIR: teamsRootDir,
					PI_TEAMS_WORKER: "1",
					PI_TEAMS_TEAM_ID: "bad-model-probe-team",
					PI_TEAMS_TASK_LIST_ID: "bad-model-probe-team",
					PI_TEAMS_AGENT_NAME: "bad-model-probe",
					PI_TEAMS_LEAD_NAME: "team-lead",
					PI_TEAMS_AUTO_CLAIM: "0",
				},
				args: ["--agent", "repo-reader", "--session-file", badModelSource, "--session-dir", path.join(tempRoot, "bad-model-sessions"), "--model", "openai-codex/nonexistent-model", "--append-system-prompt", "You are teammate 'bad-model-probe'."],
			}),
			/Could not resolve model|Model .* not found|No matching model/,
		);
	} finally {
		await badModelProbe.stop();
	}

	for (const [name, agent, expectedError] of [
		["unknown", "unknown-profile", "Unknown OMP agent definition"],
		["disabled", "disabled-reader", "OMP agent definition is disabled"],
		["missing-skill", "missing-skill-reader", "Autoload skill is missing or disabled"],
	] as const) {
		const notificationCount = notifications.length;
		await prompt(`/team spawn ${name} --agent ${agent}`);
		await waitFor(
			() => notifications.slice(notificationCount).some((event) => event.notifyType === "error" && event.message.includes(expectedError)) || null,
			{ timeoutMs: timeoutSec * 1000, label: `${agent} startup error (leader stderr: ${leaderStderr})` },
		);
		assert.equal(readMember(teamDir, name), null, `${agent} must not fall back to a generic member`);
	}

	await prompt("/team spawn generic fresh");
	const generic = await waitFor(
		() => {
			const member = readMember(teamDir, "generic");
			return member?.status === "online" ? member : null;
		},
		{ timeoutMs: timeoutSec * 1000, label: "generic teammate online" },
	);
	assert.equal(getString(generic.meta, "agent"), undefined, "generic teammate must not inherit a named profile");

	await prompt("/team spawn branch-reader branch --agent repo-reader");
	const branchReader = await waitFor(
		() => {
			const member = readMember(teamDir, "branch-reader");
			return member?.status === "online" && getString(member.meta, "agent") === "repo-reader" ? member : null;
		},
		{ timeoutMs: timeoutSec * 1000, label: "branched profiled teammate online" },
	);
	assert(branchReader.sessionFile && branchReader.sessionFile !== reader.sessionFile, "branched teammate must retain its own session");

	if (providerSmoke) {
		const task = await createTask(teamDir, teamId, {
			subject: "Profile provider smoke",
			description: "Read profile-fixture.txt and report its exact contents. Do not edit any files.",
			owner: "reader",
		});
		await writeToMailbox(teamDir, teamId, "reader", {
			from: "team-lead",
			text: JSON.stringify(taskAssignmentPayload(task, "team-lead")),
			timestamp: new Date().toISOString(),
		});
		await waitFor(
			async () => {
				const current = await getTask(teamDir, teamId, task.id);
				const result = current?.metadata?.result;
				return current?.status === "completed" && typeof result === "string" && result.includes("profile task evidence") ? current : null;
			},
			{ timeoutMs: timeoutSec * 1000, label: "provider-backed profiled task completion" },
		);
		console.log("OK: provider-backed assigned task completed by the profiled worker");
	}

	console.log("PASS: profiled spawn integration test passed");
} finally {
	try {
		lines.close();
	} catch {
		// ignore
	}
	await terminateAll(children);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
