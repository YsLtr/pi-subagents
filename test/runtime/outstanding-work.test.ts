import { createHerdrWorkReporter } from "../../src/mux/herdr-work.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerOutstandingWorkReporting } from "../../src/runtime/work-reporting.ts";
import {
	requestSubagentBatchStop,
	resetSubagentBatchStopRequest,
	runningSubagents,
	resetRuntimeStateForTest,
} from "../../src/runtime/state.ts";
import { getLaunchedSubagentResult, wireSubagentSteerBack } from "../../src/runtime/running-registry.ts";
import type { RunningSubagent, SubagentResult } from "../../src/types.ts";

function child(id: string): RunningSubagent {
	return { id, name: id, task: "test", mode: "background", executionState: "running",
		deliveryState: "detached", parentClosePolicy: "terminate", async: true, sessionFile: "child.jsonl", startTime: Date.now() };
}

test("async launch publishes before yielding and keeps last result outstanding until the parent settles after reading it", async () => {
	resetRuntimeStateForTest(() => {});
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const messages: object[] = [];
	const deliveries: Array<{ deliverAs?: string }> = [];
	const counts: number[] = [];
	// SAFETY: Only event registration and result delivery are used at this Pi boundary.
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, handler),
		sendMessage: (message: object, options: { deliverAs?: string }) => { messages.push(message); deliveries.push(options); } } as unknown as ExtensionAPI;
	// SAFETY: The reporting lifecycle only reads mode and session identity from this context.
	const ctx = { mode: "tui", sessionManager: { getSessionFile: () => "session.jsonl" }, isIdle: () => true } as unknown as ExtensionContext;
	const reporting = registerOutstandingWorkReporting(pi, async () => createHerdrWorkReporter(ctx,
		{ HERDR_ENV: "1", HERDR_PANE_ID: "owned-parent" }, async (args) => {
			if (args[0] === "status") return { running: true, compatible: true, protocol: 22 };
			if (args[1] === "current") return { result: { pane: { pane_id: "owned-parent" } } };
			const at = args.indexOf("--token");
			if (at >= 0) {
				const token = args[at + 1];
				const stored = token.slice(token.indexOf("=") + 1).slice(0, 80);
				const [sessionHash, count] = stored.split(":");
				assert.equal(sessionHash, "_DeKcJt9bzqtHI0cxFnhsQumaFsupaf-ehQ9lfpvQjc");
				counts.push(Number(count));
			}
			return { result: {} };
		}));
	const emit = async (name: string, event = {}) => { await events.get(name)?.(event, ctx); };
	await reporting.start(ctx);
	const savedAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
	delete process.env.PI_SUBAGENT_AUTO_EXIT;
	try {
		let finish: ((result: SubagentResult) => void) | undefined;
		const result = new Promise<SubagentResult>((resolve) => { finish = resolve; });
		const running = child("hidden-one");
		runningSubagents.set(running.id, running);
		wireSubagentSteerBack(pi, running, result, String, () => {});
		const launch = await getLaunchedSubagentResult(running, {
			formatElapsed: String, updateWidget() {}, waitForSubagentResult: async () => assert.fail("must remain async"),
			asSubagentToolResult: (value) => value,
		});
		await emit("tool_result", { toolName: "subagent" });
		assert.equal(launch.details.status, "started");
		assert.equal(counts.at(-1), 1);
		await emit("agent_settled");
		assert.equal(counts.at(-1), 1);
		resetSubagentBatchStopRequest();
		assert.ok(finish);
		finish({ name: running.name, task: running.task, summary: "done", exitCode: 0, elapsed: 1 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(runningSubagents.size, 0);
		assert.equal(messages.length, 1);
		assert.equal(deliveries.at(-1)?.deliverAs, "steer");
		await emit("agent_settled");
		assert.equal(counts.at(-1), 1, "queued delivery is still work");
		await emit("context", { messages: messages.map((m: object) => ({ ...m, role: "custom" })) });
		assert.equal(counts.at(-1), 1, "keep the lease throughout the continuation");
		await emit("agent_settled");
		assert.equal(counts.at(-1), 0);
	} finally {
		if (savedAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
		else process.env.PI_SUBAGENT_AUTO_EXIT = savedAutoExit;
		await reporting.stop();
		resetRuntimeStateForTest(() => {});
	}
});

async function harness() {
	resetRuntimeStateForTest(() => {});
	const events = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const messages: object[] = [];
	const deliveries: Array<{ deliverAs?: string }> = [];
	const counts: number[] = [];
	// SAFETY: These are the only Pi boundary methods used by reporting and result routing.
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => events.set(name, handler),
		sendMessage: (message: object, options: { deliverAs?: string }) => { messages.push(message); deliveries.push(options); } } as unknown as ExtensionAPI;
	// SAFETY: Lifecycle test context deliberately excludes unrelated UI/provider methods.
	const ctx = { mode: "tui", sessionManager: { getSessionFile: () => "parent.jsonl" }, isIdle: () => true } as unknown as ExtensionContext;
	const reporting = registerOutstandingWorkReporting(pi, async () => ({ publish: async (count) => { counts.push(count); }, stop: async () => {} }));
	await reporting.start(ctx);
	return { pi, counts, messages, deliveries,
		emit: async (name: string, event = {}) => { await events.get(name)?.(event, ctx); },
		stop: async () => { await reporting.stop(); resetRuntimeStateForTest(() => {}); },
	};
}

for (const outcome of ["completed", "cancelled", "ping", "watcher-error"] as const) {
	test(`${outcome} leaves a second child outstanding and routes the first report without a zero gap`, async () => {
		const h = await harness();
		try {
			const first = child("first");
			const second = child("second");
			runningSubagents.set(first.id, first);
			runningSubagents.set(second.id, second);
			await h.emit("tool_result");
			assert.equal(h.counts.at(-1), 2);
			const result = outcome === "watcher-error" ? Promise.reject(new Error("watcher failed")) : Promise.resolve({
				name: first.name, task: first.task, summary: "report", exitCode: outcome === "cancelled" ? 1 : 0, elapsed: 1,
				...(outcome === "cancelled" ? { error: "cancelled" } : {}),
				...(outcome === "ping" ? { ping: { name: first.name, message: "need help" } } : {}),
			});
			wireSubagentSteerBack(h.pi, first, result, String, () => {});
			await new Promise<void>((resolve) => setImmediate(resolve));
			await h.emit("context", { messages: h.messages.map((m) => ({ ...m, role: "custom" })) });
			await h.emit("agent_settled");
			assert.equal(h.counts.at(-1), 1);
			assert.ok(h.counts.slice(1).every((count) => count > 0));
			assert.equal(h.messages.length, 1);
		} finally { await h.stop(); }
	});
}

test("awaited children and manual-close children count, foreign adopted observations do not", async () => {
	const h = await harness();
	try {
		const sync = { ...child("sync"), blocking: true, async: false, deliveryState: "awaited" as const, allowSteerDelivery: false };
		const manual = { ...child("manual"), mode: "interactive" as const, autoExit: false };
		runningSubagents.set(sync.id, sync);
		runningSubagents.set(manual.id, manual);
		runningSubagents.set("foreign", { ...child("foreign"), verifiedRunCancelDenied: true });
		await h.emit("tool_result");
		assert.equal(h.counts.at(-1), 2);
		wireSubagentSteerBack(h.pi, sync, Promise.resolve({ name: sync.name, task: sync.task, summary: "done", exitCode: 0, elapsed: 1 }), String, () => {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		await h.emit("agent_settled");
		assert.equal(h.counts.at(-1), 1);
		assert.equal(h.messages.length, 0, "synchronous ownership must not gain a steer");
		runningSubagents.clear();
		await h.emit("tool_result");
		assert.equal(h.counts.at(-1), 0);
	} finally { await h.stop(); }
});

test("a report parked for the operator's next prompt releases its lease on the settle that follows", async () => {
	const h = await harness();
	const savedAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
	delete process.env.PI_SUBAGENT_AUTO_EXIT;
	try {
		const running = child("parked");
		runningSubagents.set(running.id, running);
		await h.emit("tool_result");
		assert.equal(h.counts.at(-1), 1);
		requestSubagentBatchStop();
		wireSubagentSteerBack(h.pi, running, Promise.resolve({ name: running.name, task: running.task, summary: "done", exitCode: 0, elapsed: 1 }), String, () => {});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(h.deliveries.at(-1)?.deliverAs, "nextTurn");
		assert.equal(runningSubagents.size, 0);
		await h.emit("agent_settled");
		assert.equal(h.counts.at(-1), 0);
	} finally {
		if (savedAutoExit === undefined) delete process.env.PI_SUBAGENT_AUTO_EXIT;
		else process.env.PI_SUBAGENT_AUTO_EXIT = savedAutoExit;
		await h.stop();
	}
});

test("session stop detaches reporting before registry cleanup or late watcher outcomes", async () => {
	const h = await harness();
	const running = child("late");
	runningSubagents.set(running.id, running);
	await h.emit("tool_result");
	await h.stop();
	const count = h.counts.length;
	running.allowSteerDelivery = false;
	wireSubagentSteerBack(h.pi, running, Promise.resolve({ name: running.name, task: running.task, summary: "done", exitCode: 0, elapsed: 1 }), String, () => {});
	await new Promise<void>((resolve) => setImmediate(resolve));
	await h.emit("agent_settled");
	assert.equal(h.counts.length, count);
	assert.equal(h.messages.length, 0);
});
