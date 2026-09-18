import type { RunningSubagent } from "../types.ts";

/** Runtime-owned work: running children plus reports awaiting a settled continuation. */
class OutstandingWork {
	private pending = new Set<string>();
	private consumed = new Set<string>();
	private listener?: () => void;
	/** Registry changes, including resume/adoption and clear, share one notification boundary. */
	readonly running = new RunningWorkMap(() => this.listener?.());

	/** Subscribe for the lifetime of the owning session. */
	subscribe(listener: () => void): () => void {
		this.listener = listener;
		return () => { if (this.listener === listener) this.listener = undefined; };
	}

	/** Count each logical delegation once; foreign verified-run observers own no work. */
	get count(): number {
		const ids = new Set(this.pending);
		for (const running of this.running.values()) {
			if (!running.verifiedRunCancelDenied) ids.add(running.id);
		}
		return ids.size;
	}

	delivery(id: string, send: () => void, consumedOnDelivery = false): void {
		// No consumer means no reporting state to retain (headless/non-Herdr).
		if (!this.listener) { send(); return; }
		this.pending.add(id);
		if (consumedOnDelivery) this.consumed.add(id);
		else this.consumed.delete(id);
		this.listener();
		try { send(); } catch (error) {
			this.pending.delete(id);
			this.consumed.delete(id);
			this.listener?.();
			throw error;
		}
	}

	/** Mark reports present at the model-context boundary, without releasing their leases yet. */
	consume(messages: readonly unknown[]): void {
		for (const message of messages) {
			if (!message || typeof message !== "object" || !("role" in message) || message.role !== "custom") continue;
			if (!("customType" in message) || !["subagent_result", "subagent_ping"].includes(String(message.customType))) continue;
			if (!("details" in message) || !message.details || typeof message.details !== "object") continue;
			if ("id" in message.details && typeof message.details.id === "string" && this.pending.has(message.details.id)) {
				this.consumed.add(message.details.id);
			}
		}
	}

	/** Release only deliveries consumed by the just-settled parent continuation. */
	settle(): void {
		for (const id of this.consumed) this.pending.delete(id);
		this.consumed.clear();
		this.listener?.();
	}

	/** Discard session-scoped delivery bookkeeping at shutdown. */
	reset(): void {
		this.pending.clear();
		this.consumed.clear();
	}
}

class RunningWorkMap extends Map<string, RunningSubagent> {
	private changed: () => void;
	constructor(changed: () => void) { super(); this.changed = changed; }
	override set(id: string, running: RunningSubagent): this {
		super.set(id, running);
		this.changed();
		return this;
	}
	override delete(id: string): boolean {
		const removed = super.delete(id);
		if (removed) this.changed();
		return removed;
	}
	override clear(): void {
		super.clear();
		this.changed();
	}
}

/** The same module-owned registry is shared by every launch, watcher and resume path. */
export const outstandingWork = new OutstandingWork();
