import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentsOverlay } from "../../src/tools/subagents-view.ts";
import { afterEach, assert, describe, it, resetSubagentStateForTest } from "../support/index.ts";

const testRuntime = {
	getShellReadyDelayMs: () => 800,
	isMuxAvailable: () => false,
	watchBackgroundSubagent: async () => ({
		name: "",
		task: "",
		summary: "",
		exitCode: 0,
		elapsed: 0,
	}),
	watchSubagent: async () => ({
		name: "",
		task: "",
		summary: "",
		exitCode: 0,
		elapsed: 0,
	}),
	getWatcherSignal: (_r: any, c: AbortController) => c.signal,
	startWidgetRefresh: () => {},
	getContextWindow: () => undefined,
	runningSubagents: new Map(),
	pi: { on() {} } as any,
	wireSubagentSteerBack: () => {},
};

function createOverlay(): SubagentsOverlay {
	const done = () => {};
	const ctx = {
		cwd: "/tmp",
		ui: {
			confirm: async () => true,
			input: async () => "test message",
			notify: () => {},
		},
		sessionManager: {
			getSessionFile: () => null,
		},
	} as any;
	const theme = {
		fg: (_t: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	};
	const tui = { requestRender: () => {}, terminal: { columns: 80 } } as any;
	return new SubagentsOverlay(done as any, ctx, theme, testRuntime as any, tui);
}

function stripAnsi(str: string): string {
	return str.replace(new RegExp("\\x1b\\[[0-9;]*[a-zA-Z]", "g"), "");
}

function renderText(overlay: SubagentsOverlay): string {
	return overlay.render(80).map(stripAnsi).join("\n");
}

function makeAgentDir(name: string, frontmatter: string): { dir: string; agentFile: string } {
	const dir = mkdtempSync(join(tmpdir(), `pi-subagents-${name}-`));
	const agentsDir = join(dir, "agents");
	mkdirSync(agentsDir, { recursive: true });
	const agentFile = join(agentsDir, `aaa-${name}.md`);
	writeFileSync(agentFile, `---\nname: aaa-${name}\n${frontmatter}description: ${name} test agent\n---\n\nBody.`);
	process.env.PI_CODING_AGENT_DIR = dir;
	return { dir, agentFile };
}

describe("agents tab enabled toggle", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("toggles the selected agent's enabled state in its file with Space", () => {
		const { agentFile } = makeAgentDir("togglable", "");
		const overlay = createOverlay();
		try {
			overlay.handleInput("\x1b[C"); // Running -> Completed
			overlay.handleInput("\x1b[C"); // Completed -> Agents

			const before = renderText(overlay);
			assert.ok(before.includes("aaa-togglable"), `Expected agent row in:\n${before}`);
			assert.ok(!before.includes("aaa-togglable on"), `Row must not show "on" status:\n${before}`);
			assert.ok(before.includes("Space disable"), `Expected disable hint in:\n${before}`);

			overlay.handleInput(" ");
			const after = renderText(overlay);
			assert.ok(!after.includes("aaa-togglable off"), `Row must not show "off" status:\n${after}`);
			assert.ok(after.includes("Space enable"), `Expected enable hint in:\n${after}`);
			assert.match(readFileSync(agentFile, "utf8"), /^enabled: false$/m);

			overlay.handleInput(" ");
			assert.match(readFileSync(agentFile, "utf8"), /^enabled: true$/m);
		} finally {
			overlay.dispose();
		}
	});

	it("keeps a disabled agent visible so it can be re-enabled", () => {
		const { agentFile } = makeAgentDir("paused", "enabled: false\n");
		const overlay = createOverlay();
		try {
			overlay.handleInput("\x1b[C");
			overlay.handleInput("\x1b[C");
			const text = renderText(overlay);
			assert.ok(text.includes("aaa-paused"), `Expected disabled agent listed in:\n${text}`);
			assert.ok(!text.includes("aaa-paused off"), `Row must not show "off" status:\n${text}`);
			assert.ok(text.includes("Space enable"), `Expected enable hint in:\n${text}`);

			overlay.handleInput(" ");
			assert.match(readFileSync(agentFile, "utf8"), /^enabled: true$/m);
		} finally {
			overlay.dispose();
		}
	});
});
