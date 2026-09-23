import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getInboxPath, processUnreadMessages, writeToMailbox } from "../extensions/teams/mailbox.js";
import { addTaskDependency, clearTasks, createTask, getTask, getTaskListDir, updateTask } from "../extensions/teams/task-store.js";

const teamDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-agent-teams-coordination-"));
const namespace = "team";
const recipient = "leader";

try {
	await writeToMailbox(teamDir, namespace, recipient, { from: "worker", text: "one", timestamp: "2026-01-01T00:00:00.000Z" });
	await writeToMailbox(teamDir, namespace, recipient, { from: "worker", text: "two", timestamp: "2026-01-01T00:00:01.000Z" });
	await writeToMailbox(teamDir, namespace, recipient, { from: "worker", text: "three", timestamp: "2026-01-01T00:00:02.000Z" });

	const handled: string[] = [];
	await assert.rejects(
		processUnreadMessages(teamDir, namespace, recipient, async (message) => {
			handled.push(message.text);
			if (message.text === "two") throw new Error("handler failed");
		}),
		/handler failed/,
	);
	assert.deepEqual(handled, ["one", "two"]);

	await processUnreadMessages(teamDir, namespace, recipient, async (message) => {
		handled.push(message.text);
	});
	assert.deepEqual(handled, ["one", "two", "two", "three"]);

	let repeated = false;
	await processUnreadMessages(teamDir, namespace, recipient, async () => {
		repeated = true;
	});
	assert.equal(repeated, false);

	const concurrentRecipient = "concurrent-leader";
	await writeToMailbox(teamDir, namespace, concurrentRecipient, { from: "worker", text: "held", timestamp: "2026-01-01T00:00:03.000Z" });
	let beginHandler!: () => void;
	const handlerStarted = new Promise<void>((resolve) => { beginHandler = resolve; });
	let releaseHandler!: () => void;
	const handlerReleased = new Promise<void>((resolve) => { releaseHandler = resolve; });
	const concurrentHandled: string[] = [];
	const processing = processUnreadMessages(teamDir, namespace, concurrentRecipient, async (message) => {
		concurrentHandled.push(message.text);
		if (message.text === "held") {
			beginHandler();
			await handlerReleased;
		}
	});
	await handlerStarted;
	await writeToMailbox(teamDir, namespace, concurrentRecipient, { from: "worker", text: "added", timestamp: "2026-01-01T00:00:04.000Z" });
	releaseHandler();
	await processing;
	assert.deepEqual(concurrentHandled, ["held", "added"]);

	const abandonedRecipient = "restarted-leader";
	await writeToMailbox(teamDir, namespace, abandonedRecipient, { from: "worker", text: "abandoned", timestamp: "2026-01-01T00:00:05.000Z" });
	const abandonedPath = getInboxPath(teamDir, namespace, abandonedRecipient);
	const abandonedMailbox = JSON.parse(await fs.promises.readFile(abandonedPath, "utf8")) as Array<Record<string, unknown>>;
	const abandonedMessage = abandonedMailbox[0];
	assert.ok(abandonedMessage);
	abandonedMessage.processing = { id: "abandoned-claim", claimedAt: "2026-01-01T00:00:05.000Z", pid: 999999 };
	await fs.promises.writeFile(abandonedPath, JSON.stringify(abandonedMailbox), "utf8");
	const recovered: string[] = [];
	await processUnreadMessages(teamDir, namespace, abandonedRecipient, async (message) => {
		recovered.push(message.text);
	});
	assert.deepEqual(recovered, ["abandoned"]);

	const ackFailureRecipient = "ack-failure-leader";
	await writeToMailbox(teamDir, namespace, ackFailureRecipient, { from: "worker", text: "ack-failure", timestamp: "2026-01-01T00:00:06.000Z" });
	const ackFailurePath = getInboxPath(teamDir, namespace, ackFailureRecipient);
	const originalMailboxRename = fs.promises.rename;
	let mailboxWrites = 0;
	fs.promises.rename = async (from, to) => {
		if (to === ackFailurePath && ++mailboxWrites === 2) throw new Error("simulated acknowledgement failure");
		return await originalMailboxRename(from, to);
	};
	const ackFailureHandled: string[] = [];
	try {
		await assert.rejects(
			processUnreadMessages(teamDir, namespace, ackFailureRecipient, async (message) => {
				ackFailureHandled.push(message.text);
			}),
			/simulated acknowledgement failure/,
		);
	} finally {
		fs.promises.rename = originalMailboxRename;
	}
	await processUnreadMessages(teamDir, namespace, ackFailureRecipient, async (message) => {
		ackFailureHandled.push(message.text);
	});
	assert.deepEqual(ackFailureHandled, ["ack-failure", "ack-failure"]);

	const inboxPath = getInboxPath(teamDir, namespace, recipient);
	const corruptMailbox = "{ not json";
	await fs.promises.writeFile(inboxPath, corruptMailbox, "utf8");
	await assert.rejects(writeToMailbox(teamDir, namespace, recipient, { from: "worker", text: "lost", timestamp: "2026-01-01T00:00:02.000Z" }), /Invalid mailbox JSON/);
	assert.equal(await fs.promises.readFile(inboxPath, "utf8"), corruptMailbox);

	const taskListId = "tasks";
	const task = await createTask(teamDir, taskListId, { subject: "blocked", description: "blocked" });
	const dependency = await createTask(teamDir, taskListId, { subject: "blocker", description: "blocker" });
	const dependencyPath = path.join(getTaskListDir(teamDir, taskListId), `${dependency.id}.json`);
	const originalDependency = await fs.promises.readFile(dependencyPath, "utf8");
	const originalTask = await fs.promises.readFile(path.join(getTaskListDir(teamDir, taskListId), `${task.id}.json`), "utf8");
	const corruptTask = "{ not json";
	await fs.promises.writeFile(dependencyPath, corruptTask, "utf8");

	await assert.rejects(addTaskDependency(teamDir, taskListId, task.id, dependency.id), /Invalid task JSON/);
	assert.equal(await fs.promises.readFile(path.join(getTaskListDir(teamDir, taskListId), `${task.id}.json`), "utf8"), originalTask);
	assert.equal(await fs.promises.readFile(dependencyPath, "utf8"), corruptTask);
	await assert.rejects(getTask(teamDir, taskListId, dependency.id), /Invalid task JSON/);
	await assert.rejects(updateTask(teamDir, taskListId, dependency.id, (current) => current), /Invalid task JSON/);
	await assert.rejects(clearTasks(teamDir, taskListId, "completed"), /Invalid task JSON/);


	await fs.promises.writeFile(dependencyPath, originalDependency, "utf8");
	await updateTask(teamDir, taskListId, task.id, (current) => ({ ...current, status: "completed" }));

	const originalRename = fs.promises.rename;
	let beginFirstWrite!: () => void;
	const firstWriteStarted = new Promise<void>((resolve) => { beginFirstWrite = resolve; });
	let releaseFirstWrite!: () => void;
	const firstWriteReleased = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
	let holdFirstWrite = true;
	let failDependencyWrite = true;
	const taskPath = path.join(getTaskListDir(teamDir, taskListId), `${task.id}.json`);
	fs.promises.rename = async (from, to) => {
		if (to === taskPath && holdFirstWrite) {
			holdFirstWrite = false;
			beginFirstWrite();
			await firstWriteReleased;
		}
		if (to === dependencyPath && failDependencyWrite) {
			failDependencyWrite = false;
			throw new Error("simulated dependency write failure");
		}
		return await originalRename(from, to);
	};
	try {
		const add = addTaskDependency(teamDir, taskListId, task.id, dependency.id);
		await firstWriteStarted;
		const clear = clearTasks(teamDir, taskListId, "completed");
		releaseFirstWrite();
		await assert.rejects(add, /simulated dependency write failure/);
		const cleared = await clear;
		assert.deepEqual(cleared.deletedTaskIds, [task.id]);
	} finally {
		fs.promises.rename = originalRename;
	}
	assert.equal(await getTask(teamDir, taskListId, task.id), null);
	assert.equal(await fs.promises.readFile(dependencyPath, "utf8"), originalDependency);
	console.log("PASS: acknowledgement retry, dependency preservation, and corrupt-state preservation");
} finally {
	await fs.promises.rm(teamDir, { recursive: true, force: true });
}
