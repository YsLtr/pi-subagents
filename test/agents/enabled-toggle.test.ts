import { readFileSync } from "node:fs";
import { getEffectiveAgentDefinitions, setAgentEnabled } from "../../src/agents/definitions.ts";
import {
	afterEach,
	assert,
	createTestDir,
	describe,
	it,
	join,
	mkdirSync,
	resetSubagentStateForTest,
	writeFileSync,
} from "../support/index.ts";

describe("agent enabled toggle persistence", () => {
	afterEach(() => {
		resetSubagentStateForTest();
	});

	it("lists disabled definitions only when includeDisabled is set", () => {
		const dir = createTestDir();
		const configDir = join(dir, "agent-root");
		const agentsDir = join(configDir, "agents");
		mkdirSync(agentsDir, { recursive: true });
		writeFileSync(join(agentsDir, "active.md"), "---\nname: active\ndescription: Active agent\n---\n\nBody.");
		writeFileSync(
			join(agentsDir, "paused.md"),
			"---\nname: paused\nenabled: false\ndescription: Paused agent\n---\n\nBody.",
		);
		process.env.PI_CODING_AGENT_DIR = configDir;

		const projectCwd = join(dir, "empty-project");
		const effective = getEffectiveAgentDefinitions(projectCwd);
		assert.deepEqual(effective.map((d) => d.name), ["active"]);

		const listing = getEffectiveAgentDefinitions(projectCwd, { includeDisabled: true });
		assert.deepEqual(listing.map((d) => d.name), ["active", "paused"]);
		assert.equal(listing.find((d) => d.name === "paused")?.enabled, false);
		assert.equal(listing.find((d) => d.name === "active")?.enabled, undefined);
	});

	it("appends enabled: false when the key is absent and preserves the rest", () => {
		const dir = createTestDir();
		const file = join(dir, "agent.md");
		writeFileSync(file, "---\nname: tester\ndescription: Tester\n---\n\nYou are the tester.\n");
		setAgentEnabled(file, false);
		assert.equal(
			readFileSync(file, "utf8"),
			"---\nname: tester\ndescription: Tester\nenabled: false\n---\n\nYou are the tester.\n",
		);
	});

	it("flips an existing enabled line, preserving comments and key order", () => {
		const dir = createTestDir();
		const file = join(dir, "agent.md");
		writeFileSync(
			file,
			"---\nname: tester\n# comment stays\nenabled:    true\nmode: background\n---\n\nBody.\n",
		);
		setAgentEnabled(file, false);
		assert.equal(
			readFileSync(file, "utf8"),
			"---\nname: tester\n# comment stays\nenabled: false\nmode: background\n---\n\nBody.\n",
		);
		setAgentEnabled(file, true);
		assert.equal(
			readFileSync(file, "utf8"),
			"---\nname: tester\n# comment stays\nenabled: true\nmode: background\n---\n\nBody.\n",
		);
	});

	it("throws for a file without frontmatter", () => {
		const dir = createTestDir();
		const file = join(dir, "agent.md");
		writeFileSync(file, "no frontmatter here\n");
		assert.throws(() => setAgentEnabled(file, true), /frontmatter/);
	});
});
