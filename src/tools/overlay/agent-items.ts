import { getEffectiveAgentDefinitions, setAgentEnabled } from "../../agents/definitions.ts";
import { type AgentDetailDefaults, buildSections } from "./data.ts";
import { firstLine } from "./render-helpers.ts";
import type { OverlayContext, OverlayItem } from "./render-types.ts";

export function buildAgentItems(_ctx: OverlayContext): OverlayItem[] {
	return getEffectiveAgentDefinitions(process.cwd(), { includeDisabled: true }).map((d) => {
		const defs = d as AgentDetailDefaults;
		const sections = buildSections(defs, undefined);
		if (d.body) {
			const bodyLines = d.body
				.split("\n")
				.filter((l: string) => l.trim())
				.map((l: string) => ({ label: "", value: l }));
			sections.push({ title: "Agent Body", fields: bodyLines });
		}
		const isEnabled = d.enabled !== false;

		return {
			id: d.name,
			icon: isEnabled ? "◆" : "◇",
			iconColor: isEnabled ? "accent" : "dim",
			name: d.name,
			agent: undefined,
			enabled: isEnabled,
			stats: [],
			activity: d.description ? firstLine(d.description, 60) : "(no description)",
			detailSections: sections,
			canKill: false,
			canResume: false,
			canToggle: true,
			onToggle: () => setAgentEnabled(d.path, !isEnabled),
		};
	});
}
