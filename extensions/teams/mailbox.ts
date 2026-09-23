import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { withLock } from "./fs-lock.js";
import { sanitizeName } from "./names.js";

export interface MailboxMessage {
	from: string;
	text: string;
	timestamp: string;
	read: boolean;
	color?: string;
	/** When true, the recipient should deliver this message as a steering interrupt
	 *  even if the agent is mid-turn, rather than queueing for the next idle window. */
	urgent?: boolean;
}

interface StoredMailboxMessage extends MailboxMessage {
	processing?: { id: string; claimedAt: string; pid: number };
}

const MAILBOX_CLAIM_TTL_MS = 60_000;
const activeMailboxClaims = new Set<string>();

function inboxDir(teamDir: string, namespace: string): string {
	return path.join(teamDir, "mailboxes", sanitizeName(namespace), "inboxes");
}

export function getInboxPath(teamDir: string, namespace: string, agentName: string): string {
	return path.join(inboxDir(teamDir, namespace), `${sanitizeName(agentName)}.json`);
}

async function ensureDir(p: string): Promise<void> {
	await fs.promises.mkdir(p, { recursive: true });
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function isLockTimeoutError(err: unknown): err is Error {
	return err instanceof Error && err.message.startsWith("Timeout acquiring lock:");
}

function coerceMailboxMessage(v: unknown): StoredMailboxMessage | null {
	if (!isRecord(v)) return null;
	if (typeof v.from !== "string") return null;
	if (typeof v.text !== "string") return null;
	if (typeof v.timestamp !== "string") return null;
	if (v.read !== undefined && typeof v.read !== "boolean") return null;
	if (v.color !== undefined && typeof v.color !== "string") return null;
	if (v.urgent !== undefined && typeof v.urgent !== "boolean") return null;
	if (v.processing !== undefined && (!isRecord(v.processing) || typeof v.processing.id !== "string" || typeof v.processing.claimedAt !== "string" || typeof v.processing.pid !== "number")) return null;
	return {
		from: v.from,
		text: v.text,
		timestamp: v.timestamp,
		read: v.read ?? false,
		color: v.color,
		urgent: v.urgent,
		processing: v.processing as StoredMailboxMessage["processing"],
	};
}

function isClaimActive(claim: NonNullable<StoredMailboxMessage["processing"]>): boolean {
	const age = Date.now() - Date.parse(claim.claimedAt);
	if (!Number.isFinite(age) || age > MAILBOX_CLAIM_TTL_MS) return false;
	if (claim.pid === process.pid) return activeMailboxClaims.has(claim.id);
	try {
		process.kill(claim.pid, 0);
		return true;
	} catch (err: unknown) {
		return !(isErrnoException(err) && err.code === "ESRCH");
	}
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
	return typeof err === "object" && err !== null && "code" in err;
}

async function readJsonArray(file: string): Promise<unknown[]> {
	let raw: string;
	try {
		raw = await fs.promises.readFile(file, "utf8");
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === "ENOENT") return [];
		throw new Error(`Unable to read mailbox ${file}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		throw new Error(`Invalid mailbox JSON in ${file}`, { cause: err });
	}
	if (!Array.isArray(parsed)) throw new Error(`Invalid mailbox JSON in ${file}: expected an array`);
	return parsed;
}

async function readMailbox(file: string): Promise<StoredMailboxMessage[]> {
	return (await readJsonArray(file)).map((message, index) => {
		const mailboxMessage = coerceMailboxMessage(message);
		if (!mailboxMessage) throw new Error(`Invalid mailbox message at index ${index} in ${file}`);
		return mailboxMessage;
	});
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
	await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	await fs.promises.rename(tmp, file);
}

/** Append a message to an agent's inbox. */
export async function writeToMailbox(
	teamDir: string,
	namespace: string,
	recipient: string,
	msg: Omit<MailboxMessage, "read"> & { read?: boolean },
): Promise<void> {
	const inboxPath = getInboxPath(teamDir, namespace, recipient);
	const lockPath = `${inboxPath}.lock`;

	await ensureDir(path.dirname(inboxPath));

	await withLock(
		lockPath,
		async () => {
			const arr = await readMailbox(inboxPath);
			const m: MailboxMessage = {
				from: msg.from,
				text: msg.text,
				timestamp: msg.timestamp,
				read: msg.read ?? false,
				color: msg.color,
				...(msg.urgent === true ? { urgent: true } : {}),
			};
			arr.push(m);
			await writeJsonAtomic(inboxPath, arr);
		},
		{ label: `mailbox:write:${namespace}:${recipient}` },
	);
}

/**
 * Read unread messages and mark them as read in a single locked transaction.
 * This is the worker/leader poll primitive.
 */
export async function popUnreadMessages(teamDir: string, namespace: string, agentName: string): Promise<MailboxMessage[]> {
	const inboxPath = getInboxPath(teamDir, namespace, agentName);
	const lockPath = `${inboxPath}.lock`;

	await ensureDir(path.dirname(inboxPath));

	try {
		return await withLock(
			lockPath,
			async () => {
				const arr = await readMailbox(inboxPath);
				if (arr.length === 0) return [];

				const unread: MailboxMessage[] = [];
				const updated = arr.map((m) => {
					if (!m.read && !m.processing) {
						const next = { ...m, read: true };
						unread.push(next);
						return next;
					}
					return m;
				});

				if (unread.length) await writeJsonAtomic(inboxPath, updated);
				return unread;
			},
			{ label: `mailbox:pop:${namespace}:${agentName}` },
		);
	} catch (err: unknown) {
		// In practice this can happen if a previous process crashed and left a non-stale
		// lockfile behind. Treat as transient and try again on the next poll tick.
		if (isLockTimeoutError(err)) return [];
		throw err;
	}
}

/**
 * Claim the next unread message under the lock, then run its handler outside
 * the lock. Claiming preserves FIFO across concurrent consumers; successful
 * handling is acknowledged in a second locked transaction.
 */
export async function processUnreadMessages(
	teamDir: string,
	namespace: string,
	agentName: string,
	handler: (message: MailboxMessage) => Promise<void>,
): Promise<void> {
	const inboxPath = getInboxPath(teamDir, namespace, agentName);
	const lockPath = `${inboxPath}.lock`;

	await ensureDir(path.dirname(inboxPath));
	while (true) {
		const claimId = randomUUID();
		const claimed = await withLock(
			lockPath,
			async () => {
				const messages = await readMailbox(inboxPath);
				const index = messages.findIndex((message) => !message.read);
				if (index < 0) return null;
				const message = messages.at(index);
				if (!message) return null;
				if (message.processing && isClaimActive(message.processing)) return null;
				messages[index] = { ...message, processing: { id: claimId, claimedAt: new Date().toISOString(), pid: process.pid } };
				await writeJsonAtomic(inboxPath, messages);
				const { processing: _processing, ...unclaimed } = message;
				return unclaimed;
			},
			{ label: `mailbox:claim:${namespace}:${agentName}` },
		);
		if (!claimed) return;

		activeMailboxClaims.add(claimId);
		try {
			try {
				await handler(claimed);
			} catch (err: unknown) {
				await withLock(
					lockPath,
					async () => {
						const messages = await readMailbox(inboxPath);
						const index = messages.findIndex((message) => message.processing?.id === claimId);
						if (index >= 0) {
							const claimedMessage = messages.at(index);
							if (!claimedMessage) return;
							const { processing: _processing, ...unclaimed } = claimedMessage;
							messages[index] = unclaimed;
							await writeJsonAtomic(inboxPath, messages);
						}
					},
					{ label: `mailbox:release:${namespace}:${agentName}` },
				);
				throw err;
			}

			await withLock(
				lockPath,
				async () => {
					const messages = await readMailbox(inboxPath);
					const index = messages.findIndex((message) => message.processing?.id === claimId);
					if (index < 0) throw new Error(`Mailbox claim lost for ${inboxPath}`);
					const claimedMessage = messages.at(index);
					if (!claimedMessage) throw new Error(`Mailbox claim lost for ${inboxPath}`);
					const { processing: _processing, ...acknowledged } = claimedMessage;
					messages[index] = { ...acknowledged, read: true };
					await writeJsonAtomic(inboxPath, messages);
				},
				{ label: `mailbox:ack:${namespace}:${agentName}` },
			);
		} finally {
			activeMailboxClaims.delete(claimId);
		}
	}
}
