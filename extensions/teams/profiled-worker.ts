import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	resolveAgentAdvisorSelection,
	resolveAgentModelSelection,
	resolveAgentPrewalkPattern,
	resolveModelOverride,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSkillPromptMessage } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SKILL_PROMPT_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/messages";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { resolveAgentPrewalkDefault } from "@oh-my-pi/pi-coding-agent/task/prewalk";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { resolveEvalBackends } from "@oh-my-pi/pi-coding-agent/tools/eval-backends";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const SUPPORTED_OPTIONS = {
	"--mode": true,
	"--agent": true,
	"--session-file": true,
	"--session-dir": true,
	"--model": true,
	"--thinking": true,
	"--append-system-prompt": true,
} as const;

type ExplicitThinkingLevel = (typeof THINKING_LEVELS)[number];
type SupportedOption = keyof typeof SUPPORTED_OPTIONS;

type LaunchOptions = {
	agent: string;
	sessionFile: string;
	sessionDir: string;
	model?: string;
	thinking?: ExplicitThinkingLevel;
	appendSystemPrompt: string;
};

function isSupportedOption(value: string): value is SupportedOption {
	return value in SUPPORTED_OPTIONS;
}

function optionValue(values: Partial<Record<SupportedOption, string>>, flag: SupportedOption): string {
	const value = values[flag]?.trim();
	if (!value) throw new Error(`Missing value for ${flag}`);
	return value;
}

function parseLaunchOptions(argv: string[]): LaunchOptions {
	const values: Partial<Record<SupportedOption, string>> = {};

	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === undefined) throw new Error("Missing launcher argument");
		if (!isSupportedOption(flag)) throw new Error(`Unsupported launcher argument: ${flag}`);
		if (values[flag] !== undefined) throw new Error(`Repeated launcher argument: ${flag}`);
		const value = argv[index + 1];
		if (value === undefined) throw new Error(`Missing value for ${flag}`);
		values[flag] = value;
		index += 1;
	}

	if (optionValue(values, "--mode") !== "rpc") {
		throw new Error("Profiled worker only supports --mode rpc");
	}

	const thinking = values["--thinking"];
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ExplicitThinkingLevel)) {
		throw new Error(`Unsupported thinking level: ${thinking}`);
	}

	return {
		agent: optionValue(values, "--agent"),
		sessionFile: path.resolve(optionValue(values, "--session-file")),
		sessionDir: path.resolve(optionValue(values, "--session-dir")),
		...(values["--model"] !== undefined ? { model: optionValue(values, "--model") } : {}),
		...(thinking !== undefined ? { thinking: thinking as ExplicitThinkingLevel } : {}),
		appendSystemPrompt: optionValue(values, "--append-system-prompt"),
	};
}

function assertValidProfile(agent: AgentDefinition): void {
	if (typeof agent.name !== "string" || typeof agent.systemPrompt !== "string" || !agent.name || !agent.systemPrompt.trim()) {
		throw new Error(`OMP agent definition "${agent.name}" has no system prompt`);
	}
	if (
		agent.tools !== undefined &&
		(!Array.isArray(agent.tools) || !agent.tools.every(tool => typeof tool === "string" && tool.length > 0))
	) {
		throw new Error(`OMP agent definition "${agent.name}" has malformed tools`);
	}
	if (
		agent.spawns !== undefined &&
		agent.spawns !== "*" &&
		(!Array.isArray(agent.spawns) || !agent.spawns.every(name => typeof name === "string" && name.length > 0))
	) {
		throw new Error(`OMP agent definition "${agent.name}" has malformed spawns`);
	}
}

function getTeamsExtensionPath(name: "index" | "profile-ready"): string {
	const dir = path.dirname(fileURLToPath(import.meta.url));
	for (const extension of [".ts", ".js"]) {
		const entry = path.join(dir, `${name}${extension}`);
		if (fs.existsSync(entry)) return entry;
	}
	throw new Error(`Teams ${name} extension is unavailable`);
}

function profileSpawns(agent: AgentDefinition): string {
	if (agent.spawns === undefined) return "";
	return agent.spawns === "*" ? "*" : agent.spawns.join(",");
}

function profileTools(agent: AgentDefinition, settings: Settings): string[] | undefined {
	if (agent.tools === undefined) return undefined;
	// ponytail: discovery adds task-only yield; persistent teammates finish on agent_end.
	const tools = agent.tools.filter(name => name !== "exec" && name !== "yield");
	if (agent.tools.includes("exec")) {
		const backends = resolveEvalBackends({ settings } as Parameters<typeof resolveEvalBackends>[0]);
		if (backends.python || backends.js) tools.push("eval");
		tools.push("bash");
	}
	const canSpawn = agent.spawns === "*" || (Array.isArray(agent.spawns) && agent.spawns.length > 0);
	if (canSpawn) tools.push("task");
	return [...new Set(tools)];
}

function inheritedRetryFallbackChain(settings: Settings, role: string | undefined): string[] | undefined {
	const chain = settings.get("retry.fallbackChains")[role ?? "default"];
	return Array.isArray(chain) && chain.every(selector => typeof selector === "string") ? chain : undefined;
}

let disposeSession: (() => Promise<void>) | undefined;

async function launch(): Promise<never> {
	const options = parseLaunchOptions(process.argv.slice(2));
	const cwd = process.cwd();
	const settings = await Settings.init({ cwd });
	const { agents } = await discoverAgents(cwd);
	const profile = getAgent(agents, options.agent);
	if (!profile) throw new Error(`Unknown OMP agent definition: ${options.agent}`);
	if ((settings.get("task.disabledAgents") ?? []).includes(profile.name)) {
		throw new Error(`OMP agent definition is disabled: ${profile.name}`);
	}
	assertValidProfile(profile);
	const advisorSelection = resolveAgentAdvisorSelection({
		settingsOverride: settings.get("task.agentAdvisor")[profile.name],
		agentAdvisor: profile.advisor,
	});
	if (profile.readSummarize === false) settings.override("read.summarize.enabled", false);
	settings.override("advisor.enabled", advisorSelection !== undefined);
	if (advisorSelection?.model) settings.override("modelRoles", { ...settings.getModelRoles(), advisor: advisorSelection.model });

	const toolNames = profileTools(profile, settings);
	if (toolNames === undefined) delete process.env.PI_TEAMS_PROFILE_TOOLS;
	else process.env.PI_TEAMS_PROFILE_TOOLS = JSON.stringify(toolNames);
	process.env.PI_TEAMS_PROFILE_READY = "1";

	const sessionManager = await SessionManager.open(options.sessionFile, options.sessionDir, undefined, {
		initialCwd: cwd,
	});
	process.env.PI_TEAMS_PROFILE_SESSION_FILE = sessionManager.getSessionFile() ?? options.sessionFile;
	const inheritedModels = getRestorableSessionModels(
		sessionManager.buildSessionContext().models,
		sessionManager.getLastModelChangeRole(),
	);
	const modelSelection = resolveAgentModelSelection({
		requestModel: options.model,
		settingsOverride: settings.get("task.agentModelOverrides")[profile.name],
		agentModel: profile.model,
		settings,
		activeModelPattern: inheritedModels[0],
		fallbackModelPattern: inheritedModels[1],
	});
	const prewalkPattern = resolveAgentPrewalkPattern({
		settingsOverride: settings.get("task.agentPrewalk")[profile.name],
		agentPrewalk: resolveAgentPrewalkDefault(profile, settings.get("task.prewalk")),
	});
	const eventBus = new EventBus();
	const teamsExtensionPath = getTeamsExtensionPath("index");
	const profileReadyExtensionPath = getTeamsExtensionPath("profile-ready");
	const { session, extensionsResult, setToolUIContext, modelFallbackMessage } = await createAgentSession({
		cwd,
		settings,
		sessionManager,
		modelPattern: modelSelection.patterns,
		modelPatternFallbackRole: modelSelection.patterns.length > 0 ? `teams-profile:${profile.name}` : undefined,
		modelPatternDefaultFallbackChain:
			modelSelection.patterns.length === 1 ? inheritedRetryFallbackChain(settings, modelSelection.role) : undefined,
		thinkingLevel: options.thinking ? (options.thinking as AgentDefinition["thinkingLevel"]) : profile.thinkingLevel,
		customSystemPrompt: profile.systemPrompt,
		appendSystemPrompt: options.appendSystemPrompt,
		toolNames,
		spawns: profileSpawns(profile),
		agentName: profile.name,
		additionalExtensionPaths: [teamsExtensionPath, profileReadyExtensionPath],
		eventBus,
	});
	if (!session.model) throw new Error(modelFallbackMessage ?? `Could not resolve model for OMP agent definition: ${profile.name}`);
	disposeSession = () => session.dispose();
	if (prewalkPattern) {
		await session.modelRegistry.awaitBackgroundRefresh();
		const resolvedPrewalk = resolveModelOverride([prewalkPattern], session.modelRegistry, settings);
		if (resolvedPrewalk.model && session.modelRegistry.hasConfiguredAuth(resolvedPrewalk.model)) {
			session.armPrewalk(resolvedPrewalk.model, resolvedPrewalk.thinkingLevel);
		}
	}
	for (const extensionPath of [teamsExtensionPath, profileReadyExtensionPath]) {
		if (extensionsResult.extensions.some(extension => path.resolve(extension.resolvedPath) === extensionPath)) continue;
		const error = extensionsResult.errors.find(extension => path.resolve(extension.path) === extensionPath)?.error;
		throw new Error(error ? `Teams worker extension failed to load: ${error}` : "Teams worker extension did not load");
	}

	if (toolNames !== undefined) await session.setActiveToolsByName(toolNames);

	for (const skillName of profile.autoloadSkills ?? []) {
		const skill = session.skills.find(candidate => candidate.name === skillName);
		if (!skill) throw new Error(`Autoload skill is missing or disabled: ${skillName}`);
		const { message } = await buildSkillPromptMessage(skill, { args: "" }, "autoload");
		await session.sendCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: message,
				display: false,
				details: { name: skill.name, path: skill.filePath },
			},
			{ triggerTurn: false },
		);
	}
	eventBus.emit("teams:skills-loaded", undefined);

	return await runRpcMode(session, setToolUIContext);
}

void launch().catch(async error => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	try {
		await disposeSession?.();
	} catch {
		// Startup already failed; retain the original error.
	}
	process.exit(1);
});
