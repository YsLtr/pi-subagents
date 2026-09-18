import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { mock } from "node:test";
import { watchBackgroundSubagent } from "../../src/runtime/background-watch.ts";
import { stopRunningSubagent } from "../../src/runtime/running-registry.ts";
import { hasSubagentExitSidecar, writeSubagentExitSidecar } from "../../src/session/exit-sidecar.ts";
import { readSubagentTimeoutSidecar } from "../../src/session/timeout-sidecar.ts";
import type { RunningSubagent, SubagentTimeoutBudget } from "../../src/types.ts";
import {
	afterEach,
	assert,
	createSessionFile,
	createTestDir,
	describe,
	it,
	rmSync,
	sleep,
} from "../support/index.ts";

const dirs: string[] = [];
const spawnedGroups: number[] = [];

/**
 * A real detached process group, which is what the runtime actually kills:
 * background children are spawned `detached: true`, so the child is its own
 * group leader and `-pid` addresses the whole group. A plain fake cannot stand
 * in here because the liveness probe signals the group, and this test process
 * is usually not a group leader itself.
 */
function spawnDetachedGroup(): number {
	const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	proc.unref();
	spawnedGroups.push(proc.pid!);
	return proc.pid!;
}

function spawnLeaderWithStubbornDescendant(): ChildProcess {
	const proc = spawn(
		process.execPath,
		[
			"-e",
			`const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);`,
		],
		{ detached: true, stdio: "ignore" },
	);
	spawnedGroups.push(proc.pid!);
	return proc;
}

function isProcessGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killSpawnedGroups(): void {
	for (const pid of spawnedGroups.splice(0)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
}

async function waitForProcessGroupExit(pid: number): Promise<void> {
	while (isProcessGroupAlive(pid)) await sleep(10);
}

/**
 * Fail loudly instead of hanging. A regression that stops the watcher settling
 * would otherwise stall the whole run and be reported as a harness timeout
 * rather than as the assertion that actually broke.
 */
function settleWithin<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`watcher did not settle within ${ms}ms: ${label}`)), ms);
			timer.unref?.();
		}),
	]);
}

function appendAssistantEntry(sessionFile: string, id: string, text: string): void {
	appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "message",
			id,
			message: { role: "assistant", content: [{ type: "text", text }] },
		})}\n`,
	);
}

/** A steer the runtime wrote into the child's session, as the idle warning is. */
function appendRuntimeSteer(sessionFile: string, id: string, text: string): void {
	appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "message",
			id,
			message: { role: "user", content: [{ type: "text", text }] },
		})}\n`,
	);
}

function makeSession(): string {
	const dir = createTestDir();
	dirs.push(dir);
	return createSessionFile(dir, [{ type: "session", id: "sess", version: 3 }]);
}

function makeRunning(
	sessionFile: string,
	childProcess: ChildProcess,
	timeoutBudget: SubagentTimeoutBudget,
	overrides: Partial<RunningSubagent> = {},
): RunningSubagent {
	return {
		id: "timeout-child",
		name: "timeout-child",
		task: "Loop forever",
		mode: "background",
		executionState: "running",
		deliveryState: "detached",
		parentClosePolicy: "terminate",
		async: true,
		startTime: Date.now(),
		sessionFile,
		timeoutBudget,
		childProcess,
		...overrides,
	};
}

/**
 * Stands in for a real child Pi process. On SIGTERM it does exactly what the
 * child extension does: publishes an ordinary `done` exit sidecar from its
 * shutdown hook, then exits cleanly. Anything that reads that `done` as the
 * child's own verdict will erase the timeout the parent just enforced.
 */
function makeRuntime(
	signals: Array<NodeJS.Signals>,
	child: ChildProcess,
	sessionFile: string,
	options: {
		exitCode?: number;
		sidecar?: object | null;
		restartForTimeoutWrapUp?: (running: RunningSubagent) => Promise<void>;
	} = {},
) {
	return {
		cleanupNoSessionSessionFile() {},
		async restartForTimeoutWrapUp(running: RunningSubagent) {
			if (!options.restartForTimeoutWrapUp) throw new Error("unexpected timeout wrap-up restart");
			await options.restartForTimeoutWrapUp(running);
		},
		terminateBackgroundChildProcess(_running: RunningSubagent, signal: NodeJS.Signals) {
			signals.push(signal);
			if (signal !== "SIGTERM") return;
			const sidecar = options.sidecar === undefined ? { type: "done" } : options.sidecar;
			if (sidecar) writeSubagentExitSidecar(sessionFile, sidecar);
			child.emit("exit", options.exitCode ?? 0);
		},
	};
}

async function runExitSidecarRace(timerOrder: "group" | "poll"): Promise<Awaited<ReturnType<typeof watchBackgroundSubagent>>> {
	const sessionFile = makeSession();
	const child = new EventEmitter() as ChildProcess;
	Object.defineProperty(child, "pid", { value: 42 });
	Object.defineProperty(child, "exitCode", { value: 0, writable: true });
	let probes = 0;
	const processProbe = {
		platform: "linux" as const,
		kill() {
			probes += 1;
			// The initial exit handler is probe 1. With the 25ms group poll and
			// 1000ms watcher poll both due, probe 41 is the watcher poll.
			if (timerOrder === "poll" && probes >= 41) {
				throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
			}
			if (timerOrder === "group" && probes === 2) {
				throw Object.assign(new Error("process group is gone"), { code: "ESRCH" });
			}
			return true as const;
		},
	};
	const running = makeRunning(sessionFile, child, {}, { timeoutExpiry: { kind: "timeout", seconds: 1 } });
	const resultPromise = watchBackgroundSubagent(
		running,
		{
			cleanupNoSessionSessionFile() {},
			terminateBackgroundChildProcess() {},
		},
		new AbortController().signal,
		{ processProbe },
	);
	writeSubagentExitSidecar(sessionFile, {
		type: "ping",
		name: "child",
		message: "needs help",
		outputTokens: 42,
		contextTokens: 17,
		contextWindow: 100,
	});
	child.emit("exit", 0);
	if (timerOrder === "group") {
		mock.timers.tick(25);
	} else {
		mock.timers.tick(1000);
	}
	return resultPromise;
}

describe("background watcher timeout budgets", () => {
	afterEach(() => {
		killSpawnedGroups();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("settles when the process group died before the exit listener attached", async () => {
		const sessionFile = makeSession();
		const pid = spawnDetachedGroup();
		process.kill(-pid, "SIGKILL");
		await settleWithin(waitForProcessGroupExit(pid), 2000, "detached process group exit");

		const child = new EventEmitter() as ChildProcess;
		Object.defineProperty(child, "pid", { value: pid });
		const running = makeRunning(sessionFile, child, {}, { noSession: true });
		running.timeoutBudget = undefined;

		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
		);
		let result;
		try {
			result = await settleWithin(resultPromise, 2500, "dead child without exit event");
		} finally {
			child.emit("exit", 1);
			await resultPromise;
		}

		assert.equal(result.exitCode, 1);
	});

	it("keeps the exit sidecar result when group and watcher polls race", async () => {
		mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000 });
		try {
			const groupFirst = await runExitSidecarRace("group");
			mock.timers.reset();
			mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: 1_000 });
			const pollFirst = await runExitSidecarRace("poll");

			for (const result of [groupFirst, pollFirst]) {
				assert.equal(result.exitCode, 0);
				assert.equal(result.timedOut, undefined);
				assert.deepEqual(result.ping, { name: "child", message: "needs help" });
				assert.equal(result.outputTokens, 42);
				assert.equal(result.contextTokens, 17);
				assert.equal(result.contextWindow, 100);
				assert.equal(result.summarySource, "runtime");
				assert.equal(result.errorMessage, undefined);
				assert.ok(result.sessionFile);
				assert.equal(hasSubagentExitSidecar(result.sessionFile), false);
				assert.equal(readSubagentTimeoutSidecar(result.sessionFile), null);
			}
			assert.deepEqual(
				{
					summary: groupFirst.summary,
					summarySource: groupFirst.summarySource,
					exitCode: groupFirst.exitCode,
					timedOut: groupFirst.timedOut,
					outputTokens: groupFirst.outputTokens,
					contextTokens: groupFirst.contextTokens,
					contextWindow: groupFirst.contextWindow,
					ping: groupFirst.ping,
					errorMessage: groupFirst.errorMessage,
				},
				{
					summary: pollFirst.summary,
					summarySource: pollFirst.summarySource,
					exitCode: pollFirst.exitCode,
					timedOut: pollFirst.timedOut,
					outputTokens: pollFirst.outputTokens,
					contextTokens: pollFirst.contextTokens,
					contextWindow: pollFirst.contextWindow,
					ping: pollFirst.ping,
					errorMessage: pollFirst.errorMessage,
				},
			);
		} finally {
			mock.timers.reset();
		}
	});

	it("keeps a live Windows child supervised until its real exit", async () => {
		const sessionFile = makeSession();
		const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 2600)"], {
			stdio: "ignore",
		});
		const running = makeRunning(sessionFile, child, {}, { noSession: true });
		running.timeoutBudget = undefined;
		const probedPids: number[] = [];
		const processProbe: {
			platform: NodeJS.Platform;
			kill(pid: number, signal?: NodeJS.Signals | number): true;
		} = {
			platform: "linux",
			kill(pid: number, signal: NodeJS.Signals | number = 0) {
				probedPids.push(pid);
				if (pid < 0) {
					processProbe.platform = "win32";
					throw Object.assign(new Error("unsupported process group probe"), { code: "EINVAL" });
				}
				return process.kill(pid, signal);
			},
		};
		const options = { processProbe };
		let settled = false;
		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess() {},
			},
			new AbortController().signal,
			options,
		).then((result) => {
			settled = true;
			return result;
		});

		try {
			await sleep(1200);
			assert.equal(settled, false);
			assert.deepEqual(probedPids, [-child.pid!]);
			const result = await settleWithin(resultPromise, 2000, "live Windows child exit");
			assert.ok(probedPids.includes(child.pid!));
			assert.equal(result.exitCode, 0);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await resultPromise;
		}
	});

	it("reports the kill even though the dying child publishes a done sidecar", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 });

		const result = await watchBackgroundSubagent(
			running,
			makeRuntime(signals, child, sessionFile),
			new AbortController().signal,
		);

		assert.deepEqual(signals, ["SIGTERM"]);
		assert.equal(result.timedOut, "timeout");
		assert.equal(result.timedOutAfter, 1);
		assert.equal(result.timeoutBlocksResume, undefined);
		assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), {
			kind: "timeout",
			blocksResume: false,
			// The verdict carries the budget it enforced, so a resume is bounded
			// even when the session mode never persisted launch metadata.
			budget: { timeoutSeconds: 1 },
		});
	});

	it("never files a killed child as a clean exit", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 });

		// The child shuts down gracefully on SIGTERM and exits 0.
		const result = await watchBackgroundSubagent(
			running,
			makeRuntime([], child, sessionFile, { exitCode: 0 }),
			new AbortController().signal,
		);

		assert.equal(result.timedOut, "timeout");
		assert.notEqual(result.exitCode, 0);
	});

	it("kills a child that stops writing to its session", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, { idleTimeoutSeconds: 1 });

		const result = await watchBackgroundSubagent(
			running,
			makeRuntime(signals, child, sessionFile),
			new AbortController().signal,
		);

		assert.deepEqual(signals, ["SIGTERM"]);
		assert.equal(result.timedOut, "idle-timeout");
		assert.equal(result.timedOutAfter, 1);
		assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), {
			kind: "idle-timeout",
			blocksResume: false,
			budget: { idleTimeoutSeconds: 1 },
		});
	});

	it("records the resume block the agent asked for", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 }, { timeoutBlocksResume: true });

		const result = await watchBackgroundSubagent(
			running,
			makeRuntime([], child, sessionFile),
			new AbortController().signal,
		);

		assert.equal(result.timeoutBlocksResume, true);
		assert.deepEqual(readSubagentTimeoutSidecar(sessionFile), {
			kind: "timeout",
			blocksResume: true,
			budget: { timeoutSeconds: 1 },
		});
	});

	it("lets a child that asked for help keep its ping", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 });

		const result = await watchBackgroundSubagent(
			running,
			makeRuntime([], child, sessionFile, { sidecar: { type: "ping", name: "child", message: "stuck" } }),
			new AbortController().signal,
		);

		assert.equal(result.timedOut, undefined);
		assert.equal(result.ping?.message, "stuck");
		assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
	});

	it("does not kill a child that published its outcome before the deadline", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		// The child finished on its own terms; its exit is already in flight.
		writeSubagentExitSidecar(sessionFile, { type: "done" });
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 });

		const resultPromise = watchBackgroundSubagent(
			running,
			makeRuntime(signals, child, sessionFile),
			new AbortController().signal,
		);
		await sleep(1600);
		const signalsAfterDeadline = [...signals];
		child.emit("exit", 0);
		const result = await settleWithin(resultPromise, 5000, "already-finished child");

		assert.deepEqual(signalsAfterDeadline, [], "a child that already finished must not be killed");
		assert.equal(result.timedOut, undefined);
		assert.equal(result.exitCode, 0);
		assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
	});

	it("keeps a working child alive past the idle budget while its session grows", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, { idleTimeoutSeconds: 2 });

		const resultPromise = watchBackgroundSubagent(
			running,
			makeRuntime(signals, child, sessionFile),
			new AbortController().signal,
		);
		for (let tick = 0; tick < 4; tick++) {
			await sleep(900);
			appendAssistantEntry(sessionFile, `m${tick}`, `Still working, step ${tick}.`);
		}
		const signalsWhileWorking = [...signals];

		writeSubagentExitSidecar(sessionFile, { type: "done" });
		child.emit("exit", 0);
		const result = await settleWithin(resultPromise, 5000, "producing child");

		assert.deepEqual(signalsWhileWorking, [], "a child that keeps producing must not be killed");
		assert.equal(result.timedOut, undefined);
		assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
	});

	it("does not let a runtime-written prompt restart the idle clock", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, { idleTimeoutSeconds: 2 });

		const resultPromise = watchBackgroundSubagent(
			running,
			makeRuntime(signals, child, sessionFile),
			new AbortController().signal,
		);
		// Parent-written user messages, including a wrap-up prompt, are not child
		// progress. Counting one would buy a silent child a fresh full interval.
		await sleep(1200);
		appendRuntimeSteer(sessionFile, "warn", "You have produced no output for 1s of your 2s idle budget.");
		await sleep(1400);

		assert.deepEqual(signals, ["SIGTERM"], "the parent prompt must not buy the child a second budget");
		const result = await settleWithin(resultPromise, 5000, "warned idle child");
		assert.equal(result.timedOut, "idle-timeout");
	});

	it("interrupts an uncooperative generation at the warning threshold and completes its wrap-up", async () => {
		const sessionFile = makeSession();
		const firstChild = new EventEmitter() as ChildProcess;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		let restarts = 0;
		const running = makeRunning(
			sessionFile,
			firstChild,
			{ timeoutSeconds: 2 },
			{ timeoutWarnThreshold: 50 } as Partial<RunningSubagent>,
		);

		const result = await settleWithin(
			watchBackgroundSubagent(
				running,
				makeRuntime(signals, firstChild, sessionFile, {
					async restartForTimeoutWrapUp(current) {
						restarts += 1;
						current.childProcess = wrapUpChild;
						appendAssistantEntry(sessionFile, "wrap-up", "Reported the committed work after interruption.");
						writeSubagentExitSidecar(sessionFile, { type: "done" });
						setTimeout(() => wrapUpChild.emit("exit", 0), 50);
					},
				}),
				new AbortController().signal,
			),
			4000,
			"timeout wrap-up restart",
		);

		assert.deepEqual(signals, ["SIGTERM"]);
		assert.equal(restarts, 1);
		assert.equal(result.timedOut, undefined);
		assert.deepEqual(result.timeoutWrapUp, { kind: "timeout", seconds: 2, threshold: 50 });
		assert.match(result.summary, /Reported the committed work after interruption/);
		assert.ok(result.elapsed < 2, "the wrap-up must use the original deadline rather than receive a fresh budget");
	});

	it("honors a short soft deadline before the hard timeout", async () => {
		const sessionFile = makeSession();
		const firstChild = new EventEmitter() as ChildProcess;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		const running = makeRunning(
			sessionFile,
			firstChild,
			{ timeoutSeconds: 1 },
			{ timeoutWarnThreshold: 50 } as Partial<RunningSubagent>,
		);

		const result = await settleWithin(
			watchBackgroundSubagent(
				running,
				makeRuntime([], firstChild, sessionFile, {
					async restartForTimeoutWrapUp(current) {
						current.childProcess = wrapUpChild;
						appendAssistantEntry(sessionFile, "short-wrap-up", "Short-budget report.");
						writeSubagentExitSidecar(sessionFile, { type: "done" });
						setTimeout(() => wrapUpChild.emit("exit", 0), 10);
					},
				}),
				new AbortController().signal,
			),
			2500,
			"short timeout wrap-up",
		);

		assert.equal(result.timedOut, undefined);
		assert.deepEqual(result.timeoutWrapUp, { kind: "timeout", seconds: 1, threshold: 50 });
	});

	it("does not restart until the interrupted process group is fully gone", async () => {
		const sessionFile = makeSession();
		const firstChild = spawnLeaderWithStubbornDescendant();
		const firstPid = firstChild.pid!;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		let groupAliveAtRestart = true;
		const running = makeRunning(
			sessionFile,
			firstChild,
			{ timeoutSeconds: 2 },
			{ timeoutWarnThreshold: 50 } as Partial<RunningSubagent>,
		);

		const result = await settleWithin(
			watchBackgroundSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					terminateBackgroundChildProcess(_current, signal) {
						signals.push(signal);
						try {
							process.kill(-firstPid, signal);
						} catch {}
					},
					async restartForTimeoutWrapUp(current) {
						groupAliveAtRestart = isProcessGroupAlive(firstPid);
						current.childProcess = wrapUpChild;
						appendAssistantEntry(sessionFile, "reaped-wrap-up", "Old group reaped before report.");
						writeSubagentExitSidecar(sessionFile, { type: "done" });
						setTimeout(() => wrapUpChild.emit("exit", 0), 10);
					},
				},
				new AbortController().signal,
				{ timeoutKillEscalationMs: 200 },
			),
			4000,
			"stubborn descendant wrap-up",
		);

		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
		assert.equal(groupAliveAtRestart, false, "the replacement must not overlap a stubborn old descendant");
		assert.equal(result.timedOut, undefined);
	});

	it("reports the original hard timeout when restart preparation spends the reserve", async () => {
		const sessionFile = makeSession();
		const firstChild = new EventEmitter() as ChildProcess;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(
			sessionFile,
			firstChild,
			{ timeoutSeconds: 2 },
			{ timeoutWarnThreshold: 50 } as Partial<RunningSubagent>,
		);

		const result = await settleWithin(
			watchBackgroundSubagent(
				running,
				{
					cleanupNoSessionSessionFile() {},
					terminateBackgroundChildProcess(current, signal) {
						signals.push(signal);
						if (current.childProcess === firstChild) {
							writeSubagentExitSidecar(sessionFile, { type: "done" });
							firstChild.emit("exit", 0);
							return;
						}
						wrapUpChild.emit("exit", signal === "SIGKILL" ? 137 : 143);
					},
					async restartForTimeoutWrapUp(current) {
						await sleep(1300);
						current.childProcess = wrapUpChild;
						appendAssistantEntry(sessionFile, "late-wrap-up", "This report started too late.");
						setTimeout(() => wrapUpChild.emit("exit", 0), 20);
					},
				},
				new AbortController().signal,
			),
			5000,
			"late restart hard timeout",
		);

		assert.equal(result.timedOut, "timeout");
		assert.equal(result.timedOutAfter, 2);
		assert.ok(signals.length >= 2, "the late replacement must be terminated rather than reported as success");
	});

	it("cancels a replacement created after manual stop during restart", async () => {
		const sessionFile = makeSession();
		const firstChild = new EventEmitter() as ChildProcess;
		const wrapUpChild = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		const controller = new AbortController();
		let restartEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			restartEntered = resolve;
		});
		const running = makeRunning(
			sessionFile,
			firstChild,
			{ timeoutSeconds: 4 },
			{ timeoutWarnThreshold: 25, abortController: controller } as Partial<RunningSubagent>,
		);

		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess(current, signal) {
					signals.push(signal);
					if (current.childProcess === firstChild) {
						writeSubagentExitSidecar(sessionFile, { type: "done" });
						firstChild.emit("exit", 0);
						return;
					}
					wrapUpChild.emit("exit", signal === "SIGKILL" ? 137 : 143);
				},
				async restartForTimeoutWrapUp(current) {
					restartEntered();
					await sleep(100);
					current.childProcess = wrapUpChild;
					appendAssistantEntry(sessionFile, "cancelled-wrap-up", "Must not be reported as complete.");
					setTimeout(() => wrapUpChild.emit("exit", 0), 20);
				},
			},
			controller.signal,
		);

		await settleWithin(entered, 2500, "restart entry");
		await stopRunningSubagent(running, async () => {});
		const result = await settleWithin(resultPromise, 3000, "manual stop during restart");

		assert.equal(result.error, "cancelled");
		assert.notEqual(result.exitCode, 0);
		assert.ok(signals.length >= 2, "the replacement created after abort must be terminated");
	});

	it("never bounds a child whose agent set no budget", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, {});
		running.timeoutBudget = undefined;

		const resultPromise = watchBackgroundSubagent(
			running,
			makeRuntime(signals, child, sessionFile),
			new AbortController().signal,
		);
		await sleep(2500);
		const signalsWhileWorking = [...signals];

		writeSubagentExitSidecar(sessionFile, { type: "done" });
		child.emit("exit", 0);
		const result = await settleWithin(resultPromise, 5000, "unbounded child");

		assert.deepEqual(signalsWhileWorking, []);
		assert.equal(result.timedOut, undefined);
		// An opt-in feature must leave an agent that never opted in untouched.
		assert.equal(running.timeoutExpiry, undefined);
		assert.equal(running.timeoutKillTimer, undefined);
		assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
	});

	it("leaves no sidecar behind for an ephemeral child", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 }, { noSession: true });

		const result = await watchBackgroundSubagent(
			running,
			makeRuntime([], child, sessionFile),
			new AbortController().signal,
		);

		assert.equal(result.timedOut, "timeout");
		assert.equal(result.sessionFile, undefined);
		assert.equal(readSubagentTimeoutSidecar(sessionFile), null);
		assert.equal(hasSubagentExitSidecar(sessionFile), false, "an ephemeral child must leave no sidecar residue");
	});

	it("escalates to SIGKILL when the child ignores the first signal", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		// A real live process group, so the liveness probe before escalating
		// passes. No real signal reaches it: the injected runtime only records.
		Object.defineProperty(child, "pid", { value: spawnDetachedGroup() });
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 });

		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				// The child swallows SIGTERM and keeps running.
				terminateBackgroundChildProcess(_running: RunningSubagent, signal: NodeJS.Signals) {
					signals.push(signal);
					if (signal === "SIGKILL") {
						try {
							process.kill(-child.pid!, signal);
						} catch {}
					}
				},
			},
			new AbortController().signal,
			{ timeoutKillEscalationMs: 300 },
		);
		await sleep(1800);
		assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

		child.emit("exit", 137);
		const result = await settleWithin(resultPromise, 5000, "escalated child");
		assert.equal(result.timedOut, "timeout");
	});

	it("escalates against a child that publishes a done sidecar but does not die", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		Object.defineProperty(child, "pid", { value: spawnDetachedGroup() });
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 });

		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess(_running: RunningSubagent, signal: NodeJS.Signals) {
					signals.push(signal);
					// The shutdown hook publishes `done` because of our own SIGTERM.
					// That is not evidence the process died, and a child that keeps
					// running after publishing it must still be reaped.
					if (signal === "SIGTERM") writeSubagentExitSidecar(sessionFile, { type: "done" });
					if (signal === "SIGKILL") {
						try {
							process.kill(-child.pid!, signal);
						} catch {}
					}
				},
			},
			new AbortController().signal,
			{ timeoutKillEscalationMs: 300 },
		);
		await sleep(1800);
		assert.deepEqual(
			signals,
			["SIGTERM", "SIGKILL"],
			"a kill-induced done sidecar must not buy a still-running child its life",
		);

		child.emit("exit", 0);
		await settleWithin(resultPromise, 5000, "publishing-but-alive child");
	});

	it("does not escalate once the child's process group is gone", async () => {
		const sessionFile = makeSession();
		const child = new EventEmitter() as ChildProcess;
		// No pid: nothing is left to signal, so the group probe reports it gone.
		const signals: Array<NodeJS.Signals> = [];
		const running = makeRunning(sessionFile, child, { timeoutSeconds: 1 });

		const resultPromise = watchBackgroundSubagent(
			running,
			{
				cleanupNoSessionSessionFile() {},
				terminateBackgroundChildProcess(_running: RunningSubagent, signal: NodeJS.Signals) {
					signals.push(signal);
				},
			},
			new AbortController().signal,
			{ timeoutKillEscalationMs: 300 },
		);
		await sleep(1800);
		assert.deepEqual(signals, ["SIGTERM"], "a dead process group must not be signalled again");

		child.emit("exit", 143);
		await settleWithin(resultPromise, 5000, "already-dead child");
	});
});
