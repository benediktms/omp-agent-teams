import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";
import { sanitizeName } from "./names.js";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface TeamTask {
	id: string; // stringified integer (Claude-style)
	subject: string;
	description: string;
	owner?: string; // agent name
	status: TaskStatus;
	blocks: string[];
	blockedBy: string[];
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export function getTaskListDir(teamDir: string, taskListId: string): string {
	return path.join(teamDir, "tasks", sanitizeName(taskListId));
}

function taskPath(taskListDir: string, taskId: string): string {
	return path.join(taskListDir, `${sanitizeName(taskId)}.json`);
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

async function readJson(file: string): Promise<unknown | null> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(file, "utf8");
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ENOENT") return null;
		throw new Error(`Unable to read task ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}

	try {
		return JSON.parse(raw) as unknown;
	} catch (err: unknown) {
		throw new Error(`Invalid task JSON in ${file}`, { cause: err });
	}
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	await fs.promises.rename(tmp, file);
}

function isStatus(s: unknown): s is TaskStatus {
	return s === "pending" || s === "in_progress" || s === "completed";
}

function coerceTask(obj: unknown): TeamTask | null {
	if (!isRecord(obj)) return null;
	if (typeof obj.id !== "string") return null;
	if (typeof obj.subject !== "string") return null;
	if (typeof obj.description !== "string") return null;
	if (!isStatus(obj.status)) return null;

	if (obj.owner !== undefined && typeof obj.owner !== "string") return null;
	if (!isStringArray(obj.blocks)) return null;
	if (!isStringArray(obj.blockedBy)) return null;
	if (obj.metadata !== undefined && !isRecord(obj.metadata)) return null;
	if (typeof obj.createdAt !== "string") return null;
	if (typeof obj.updatedAt !== "string") return null;

	return {
		id: obj.id,
		subject: obj.subject,
		description: obj.description,
		owner: typeof obj.owner === "string" ? obj.owner : undefined,
		status: obj.status,
		blocks: obj.blocks,
		blockedBy: obj.blockedBy,
		metadata: obj.metadata,
		createdAt: obj.createdAt,
		updatedAt: obj.updatedAt,
	};
}

async function readTask(file: string): Promise<TeamTask | null> {
	const obj = await readJson(file);
	if (obj === null) return null;
	const task = coerceTask(obj);
	if (!task) throw new Error(`Invalid task JSON in ${file}`);
	return task;
}

async function allocateTaskId(taskListDir: string): Promise<string> {
	await ensureDir(taskListDir);

	const highwater = path.join(taskListDir, ".highwatermark");
	const lock = `${highwater}.lock`;

	return await withLock(
		lock,
		async () => {
			let n = 0;
			try {
				const raw = await fs.promises.readFile(highwater, "utf8");
				const parsed = Number.parseInt(raw.trim(), 10);
				if (Number.isFinite(parsed) && parsed > 0) n = parsed;
			} catch {
				// ignore
			}
			n += 1;
			await fs.promises.writeFile(highwater, `${n}\n`, "utf8");
			return String(n);
		},
		{ label: "tasks:allocate" },
	);
}

export function shortTaskId(id: string): string {
	return id;
}

export function formatTaskLine(t: TeamTask, opts: { blocked?: boolean } = {}): string {
	const blocked = Boolean(opts.blocked);
	const status = blocked && t.status === "pending" ? "blocked" : t.status;

	const deps = t.blockedBy?.length ?? 0;
	const blocks = t.blocks?.length ?? 0;

	const who = t.owner ? `@${t.owner}` : "";
	const head = `${t.id.padStart(3, " ")} ${status.padEnd(11)} ${who}`.trimEnd();

	const tags: string[] = [];
	if (blocked && t.status === "in_progress") tags.push("blocked");
	if (deps) tags.push(`deps:${deps}`);
	if (blocks) tags.push(`blocks:${blocks}`);
	const tagText = tags.length ? ` [${tags.join(" ")}]` : "";

	const preview = t.subject.length > 80 ? `${t.subject.slice(0, 80)}…` : t.subject;
	return `${head}${tagText}  ${preview}`;
}

export async function listTasks(teamDir: string, taskListId: string): Promise<TeamTask[]> {
	const dir = getTaskListDir(teamDir, taskListId);
	try {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		const files = entries
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

		return await Promise.all(files.map(async (file) => {
			const task = await readTask(path.join(dir, file));
			if (!task) throw new Error(`Task disappeared while listing: ${path.join(dir, file)}`);
			return task;
		}));
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ENOENT") return [];
		throw err;
	}
}

export async function getTask(teamDir: string, taskListId: string, taskId: string): Promise<TeamTask | null> {
	const dir = getTaskListDir(teamDir, taskListId);
	return await readTask(taskPath(dir, taskId));
}

export async function createTask(
	teamDir: string,
	taskListId: string,
	input: { subject: string; description: string; owner?: string },
): Promise<TeamTask> {
	const dir = getTaskListDir(teamDir, taskListId);
	const id = await allocateTaskId(dir);
	const now = new Date().toISOString();
	const task: TeamTask = {
		id,
		subject: input.subject,
		description: input.description,
		owner: input.owner,
		status: "pending",
		blocks: [],
		blockedBy: [],
		metadata: {},
		createdAt: now,
		updatedAt: now,
	};

	await writeJsonAtomic(taskPath(dir, id), task);
	return task;
}

export async function updateTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	updater: (current: TeamTask) => TeamTask,
): Promise<TeamTask | null> {
	const dir = getTaskListDir(teamDir, taskListId);
	const file = taskPath(dir, taskId);
	const lock = `${file}.lock`;

	await ensureDir(dir);

	return await withLock(
		lock,
		async () => {
			const cur = await readTask(file);
			if (!cur) return null;
			const next = updater({ ...cur });
			next.updatedAt = new Date().toISOString();
			await writeJsonAtomic(file, next);
			return next;
		},
		{ label: `tasks:update:${taskId}` },
	);
}

export async function isTaskBlocked(teamDir: string, taskListId: string, task: TeamTask): Promise<boolean> {
	if (!task.blockedBy?.length) return false;
	for (const depId of task.blockedBy) {
		const dep = await getTask(teamDir, taskListId, depId);
		if (!dep) return true;
		if (dep.status !== "completed") return true;
	}
	return false;
}

export async function agentHasActiveTask(teamDir: string, taskListId: string, agentName: string): Promise<boolean> {
	const tasks = await listTasks(teamDir, taskListId);
	return tasks.some((t) => t.owner === agentName && t.status === "in_progress");
}

/**
 * Claim a specific task (owner must be empty).
 * Returns the updated task if claim succeeded, otherwise null.
 */
export async function claimTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	opts: { checkAgentBusy?: boolean } = {},
): Promise<TeamTask | null> {
	if (opts.checkAgentBusy) {
		const busy = await agentHasActiveTask(teamDir, taskListId, agentName);
		if (busy) return null;
	}

	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		// Not claimable
		if (cur.status !== "pending") return cur;
		if (cur.owner) return cur;
		return {
			...cur,
			owner: agentName,
			status: "in_progress",
		};
	});
}

/**
 * Start an assigned task (owner matches), marking it in_progress.
 */
export async function startAssignedTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status !== "pending") return cur;
		return { ...cur, status: "in_progress" };
	});
}

export async function completeTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	result?: string,
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status === "completed") return cur;
		const metadata = { ...(cur.metadata ?? {}) };
		if (result) metadata.result = result;
		metadata.completedAt = new Date().toISOString();
		return { ...cur, status: "completed", metadata };
	});
}

export async function unassignTask(
	teamDir: string,
	taskListId: string,
	taskId: string,
	agentName: string,
	reason?: string,
	extraMetadata?: Record<string, unknown>,
): Promise<TeamTask | null> {
	return await updateTask(teamDir, taskListId, taskId, (cur) => {
		if (cur.owner !== agentName) return cur;
		if (cur.status === "completed") return cur;

		const metadata = { ...(cur.metadata ?? {}) };
		if (reason) metadata.unassignedReason = reason;
		metadata.unassignedAt = new Date().toISOString();
		if (extraMetadata) Object.assign(metadata, extraMetadata);

		return {
			...cur,
			owner: undefined,
			status: "pending",
			metadata,
		};
	});
}

/** Reset all non-completed tasks owned by agent back to pending + unowned. */
export async function unassignTasksForAgent(
	teamDir: string,
	taskListId: string,
	agentName: string,
	reason?: string,
): Promise<number> {
	const tasks = await listTasks(teamDir, taskListId);
	let changed = 0;
	for (const t of tasks) {
		if (t.owner !== agentName) continue;
		if (t.status === "completed") continue;
		const updated = await updateTask(teamDir, taskListId, t.id, (cur) => {
			// Re-check ownership under the per-task lock to avoid races with other claimers.
			if (cur.owner !== agentName) return cur;
			if (cur.status === "completed") return cur;

			const metadata = { ...(cur.metadata ?? {}) };
			if (reason) metadata.unassignedReason = reason;
			metadata.unassignedAt = new Date().toISOString();
			return {
				...cur,
				owner: undefined,
				status: "pending",
				metadata,
			};
		});
		if (updated) changed += 1;
	}
	return changed;
}

/**
 * Find and claim the first available task:
 * - pending
 * - unowned
 * - unblocked
 */
export async function claimNextAvailableTask(
	teamDir: string,
	taskListId: string,
	agentName: string,
	opts: { checkAgentBusy?: boolean } = {},
): Promise<TeamTask | null> {
	if (opts.checkAgentBusy) {
		const busy = await agentHasActiveTask(teamDir, taskListId, agentName);
		if (busy) return null;
	}

	const tasks = await listTasks(teamDir, taskListId);
	for (const t of tasks) {
		if (t.status !== "pending") continue;
		if (t.owner) continue;
		if (await isTaskBlocked(teamDir, taskListId, t)) continue;

		const claimed = await claimTask(teamDir, taskListId, t.id, agentName, { checkAgentBusy: false });
		if (claimed && claimed.owner === agentName && claimed.status === "in_progress") return claimed;
	}
	return null;
}

export type TaskDependencyOpResult =
	| { ok: true; task: TeamTask; dependency: TeamTask }
	| { ok: false; error: string };

function uniqStrings(xs: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const x of xs) {
		if (seen.has(x)) continue;
		seen.add(x);
		out.push(x);
	}
	return out;
}

async function withTaskLocks<T>(files: string[], fn: () => Promise<T>): Promise<T> {
	const locks = [...new Set(files)].sort().map((file) => `${file}.lock`);
	const acquire = async (index: number): Promise<T> => {
		if (index === locks.length) return await fn();
		const lock = locks[index];
		if (!lock) throw new Error("Missing task lock");
		return await withLock(lock, () => acquire(index + 1), { label: `tasks:dependency:${path.basename(lock)}` });
	};
	return await acquire(0);
}

async function changeTaskDependency(
	teamDir: string,
	taskListId: string,
	taskId: string,
	depId: string,
	add: boolean,
): Promise<TaskDependencyOpResult> {
	if (!taskId || !depId) return { ok: false, error: "Missing task id or dependency id" };
	if (taskId === depId) return { ok: false, error: add ? "Task cannot depend on itself" : "Task cannot remove itself as a dependency" };

	const dir = getTaskListDir(teamDir, taskListId);
	await ensureDir(dir);
	const taskFile = taskPath(dir, taskId);
	const depFile = taskPath(dir, depId);

	return await withTaskLocks([taskFile, depFile], async () => {
		const task = await readTask(taskFile);
		if (!task) return { ok: false, error: `Task not found: ${taskId}` };
		const dependency = await readTask(depFile);
		if (!dependency) return { ok: false, error: `Dependency task not found: ${depId}` };

		const now = new Date().toISOString();
		const updatedTask: TeamTask = {
			...task,
			blockedBy: add ? uniqStrings([...task.blockedBy, depId]) : task.blockedBy.filter((id) => id !== depId),
			updatedAt: now,
		};
		const updatedDependency: TeamTask = {
			...dependency,
			blocks: add ? uniqStrings([...dependency.blocks, taskId]) : dependency.blocks.filter((id) => id !== taskId),
			updatedAt: now,
		};

		try {
			await writeJsonAtomic(taskFile, updatedTask);
			await writeJsonAtomic(depFile, updatedDependency);
		} catch (err: unknown) {
			try {
				await writeJsonAtomic(taskFile, task);
				await writeJsonAtomic(depFile, dependency);
			} catch (rollbackErr: unknown) {
				throw new Error(`Unable to update dependency atomically; rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`, { cause: err });
			}
			throw err;
		}
		return { ok: true, task: updatedTask, dependency: updatedDependency };
	});
}

/**
 * Add a dependency edge: taskId is blockedBy depId (and depId blocks taskId).
 */
export async function addTaskDependency(
	teamDir: string,
	taskListId: string,
	taskId: string,
	depId: string,
): Promise<TaskDependencyOpResult> {
	return await changeTaskDependency(teamDir, taskListId, taskId, depId, true);
}

/**
 * Remove dependency edge: taskId no longer blockedBy depId (and depId no longer blocks taskId).
 */
export async function removeTaskDependency(
	teamDir: string,
	taskListId: string,
	taskId: string,
	depId: string,
): Promise<TaskDependencyOpResult> {
	return await changeTaskDependency(teamDir, taskListId, taskId, depId, false);
}

export type TaskClearMode = "completed" | "all";

export interface ClearTasksResult {
	mode: TaskClearMode;
	taskListId: string;
	taskListDir: string;
	deletedTaskIds: string[];
	skippedTaskIds: string[];
	errors: Array<{ file: string; error: string }>;
}

/**
 * Delete task JSON files from the task list directory.
 *
 * Safety properties:
 * - Only deletes `*.json` files inside `<teamDir>/tasks/<taskListId>/`.
 * - Refuses to operate if the resolved task list directory is not within `teamDir`.
 */
export async function clearTasks(
	teamDir: string,
	taskListId: string,
	mode: TaskClearMode = "completed",
): Promise<ClearTasksResult> {
	const taskListDir = getTaskListDir(teamDir, taskListId);

	// Path safety: ensure the taskListDir is inside teamDir (prevents path traversal accidents).
	const teamAbs = path.resolve(teamDir);
	const listAbs = path.resolve(taskListDir);
	if (!(listAbs === teamAbs || listAbs.startsWith(teamAbs + path.sep))) {
		throw new Error(`Refusing to clear tasks outside teamDir. teamDir=${teamAbs} taskListDir=${listAbs}`);
	}

	let entries: fs.Dirent[] = [];
	try {
		entries = await fs.promises.readdir(taskListDir, { withFileTypes: true });
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ENOENT") {
			return { mode, taskListId, taskListDir, deletedTaskIds: [], skippedTaskIds: [], errors: [] };
		}
		throw err;
	}

	const deletedTaskIds: string[] = [];
	const skippedTaskIds: string[] = [];
	const errors: Array<{ file: string; error: string }> = [];

	for (const e of entries) {
		if (!e.isFile()) continue;
		if (!e.name.endsWith(".json")) continue;

		const file = path.join(taskListDir, e.name);
		const fileAbs = path.resolve(file);
		if (!fileAbs.startsWith(listAbs + path.sep)) {
			errors.push({ file, error: "Refusing to delete file outside taskListDir" });
			continue;
		}

		await withTaskLocks([file], async () => {
			let shouldDelete = mode === "all";
			let taskIdFromName = e.name.slice(0, -".json".length);

			if (mode === "completed") {
				const task = await readTask(file);
				if (!task) return;
				if (task.status === "completed") {
					shouldDelete = true;
					taskIdFromName = task.id;
				}
			}

			if (!shouldDelete) {
				skippedTaskIds.push(taskIdFromName);
				return;
			}

			try {
				await fs.promises.unlink(file);
				deletedTaskIds.push(taskIdFromName);
			} catch (err: unknown) {
				if (isErrnoException(err) && err.code === "ENOENT") return;
				errors.push({ file, error: err instanceof Error ? err.message : String(err) });
			}
		});
	}

	return { mode, taskListId, taskListDir, deletedTaskIds, skippedTaskIds, errors };
}
