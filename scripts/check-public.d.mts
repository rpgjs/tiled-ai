export function findings(path: string, text: string): string[];
export function scan(root: string): Promise<{ files: number; problems: string[] }>;
