export function getInteractiveProcessFile(doneSentinelFile: string): string {
	return `${doneSentinelFile}.pid`;
}
