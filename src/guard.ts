// Peer-task guard: decides which tool calls are risky enough that the owner (the human at the
// agent's terminal) must approve them when a peer, not the owner, started the work.
// Pure functions only; the extension does the prompting. See ADR 0001, "Owner gate".

import * as os from "node:os";
import * as path from "node:path";

export type GuardMode = "ask" | "block" | "off";
export type GuardScope = "peer" | "all";

export interface GuardConfig {
	/** ask: prompt the owner; block: refuse without asking; off: no guard. */
	mode: GuardMode;
	/** peer: only turns a peer message started; all: every turn, including the owner's own. */
	scope: GuardScope;
	/** Extra regular expressions (case-insensitive) matched against shell commands. */
	extraPatterns: string[];
}

export const DEFAULT_GUARD: GuardConfig = { mode: "ask", scope: "peer", extraPatterns: [] };

/** Shell command rules: [pattern, why it's risky]. Matched against bash and powershell commands. */
const COMMAND_RULES: ReadonlyArray<readonly [RegExp, string]> = [
	[/\bgit\s+push\b/i, "pushes to a git remote"],
	[
		/\bgit\s+(reset\s+--hard|clean\s+-\w*f|branch\s+-D|filter-(branch|repo)|rebase\b|tag\s+-d|update-ref\s+-d|checkout\s+--\s|restore\b|stash\s+(drop|clear))/i,
		"discards work or rewrites git history",
	],
	[/\bgit\s+config\s+(--global|--system)\b/i, "changes global git configuration"],
	[/\brm\s+(-\w*[rf]|--recursive|--force)/i, "deletes files recursively or forcibly"],
	[/\b(Remove-Item|ri)\b[^|;&]*\s-(Recurse|Force)\b/i, "deletes files recursively or forcibly"],
	[/\b(rmdir|rd|del|erase)\s+\/[sq]\b/i, "deletes files recursively or forcibly"],
	[/\b(sudo|doas)\b|\bsu\s+-|\brunas\b|\bStart-Process\b[^|;&]*-Verb\s+RunAs/i, "runs with elevated privileges"],
	[/\bchmod\s+(-R\b|\S*777)|\bchown\s+-R\b|\bicacls\b|\btakeown\b/i, "changes file ownership or permissions"],
	[
		/\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|owner|dist-tag|access)\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bdocker\s+push\b/i,
		"publishes a package or image",
	],
	[
		/\bgh\s+(release|secret|variable|repo\s+(create|delete|edit|rename|archive|fork)|pr\s+(merge|close)|issue\s+(close|delete)|api\s+.*-X\s*(POST|PUT|PATCH|DELETE))\b/i,
		"changes state on GitHub",
	],
	[
		/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+.*(-g|--global)\b|\b(pip|pip3|pipx)\s+install\b|\b(apt|apt-get|dnf|yum|pacman|brew|winget|choco|scoop)\s+(install|remove|uninstall|upgrade|purge)\b/i,
		"installs or removes software",
	],
	// As commands only, so the ".ssh" folder or a file like "ssh.test.ts" doesn't count.
	[/(^|[\s;&|(`])(ssh|scp|sftp|rsync)(\.exe)?(\s|$)/i, "reaches another machine"],
	[
		/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell|iex|Invoke-Expression)\b/i,
		"runs a downloaded script",
	],
	[
		/\bkubectl\s+(delete|apply|replace|scale|drain)\b|\bterraform\s+(apply|destroy)\b|\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/i,
		"changes infrastructure",
	],
	[
		/\b(shutdown|reboot|Stop-Computer|Restart-Computer|mkfs|diskpart|format-volume)\b|\bdd\s+if=|\breg\s+(add|delete)\b|\bsetx\b|\bSet-ExecutionPolicy\b/i,
		"changes the system",
	],
];

/**
 * Secrets: reading them is already risky, because a worker can hand the contents back to a peer.
 * Matched against shell commands and against read/grep/find/ls paths.
 */
const SECRET =
	/(^|[\s"'=:/\\])(\.ssh([\\/]|\b)|id_(rsa|ed25519|ecdsa|dsa)\b|\.env(\.[\w-]+)?\b|[\w.*-]*\.(pem|key|p12|pfx)\b|\.npmrc\b|\.netrc\b|_netrc\b|\.git-credentials\b|credentials\.json\b|secrets?\.(json|ya?ml|env|toml)\b|\.aws[\\/]|\.kube[\\/]|\.docker[\\/]config\.json\b|auth\.json\b|\.pi-peers[\\/](agents|run)\b)/i;

/** Agent, shell and git configuration: reading it is fine, changing it is risky. */
const CONFIG =
	/\.pi-peers\b|\.pi[\\/]agent\b|\.gitconfig\b|\.bashrc\b|\.zshrc\b|\.profile\b|\.bash_profile\b|Microsoft\.PowerShell_profile\.ps1|\$PROFILE\b/i;

/** Shell constructs that write, move or delete. */
const WRITES =
	/(^|[^<>&0-9])>>?|\btee\b|\bsed\s+(-\w*i|--in-place)|\b(rm|mv|cp|ln|truncate|chmod|chown|touch|install)\b|\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\b|\b(del|erase|move|copy|ren)\s/i;

/** Basenames or path fragments that are sensitive to write, wherever they are. */
const SENSITIVE_WRITE = /(^|[\\/])(\.env(\.[\w-]+)?|\.npmrc|\.gitconfig|id_(rsa|ed25519|ecdsa)(\.pub)?|[^\\/]+\.(pem|key|p12|pfx))$|(^|[\\/])(\.git|\.ssh|\.pi|\.pi-peers|\.aws|\.kube|\.github[\\/]workflows)([\\/]|$)/i;

/** The owner's extraPatterns from policy.json, matched against commands and file paths. */
function customReason(subject: string, extra: string[]): string | undefined {
	for (const src of extra) {
		try {
			if (new RegExp(src, "i").test(subject)) return `matches the custom guard pattern /${src}/`;
		} catch {
			// An invalid pattern in policy.json is ignored rather than blocking everything.
		}
	}
	return undefined;
}

function shellReason(command: string, extra: string[]): string | undefined {
	for (const [re, why] of COMMAND_RULES) if (re.test(command)) return why;
	if (SECRET.test(command)) return "reads or exposes secrets or credentials";
	if (CONFIG.test(command) && WRITES.test(command)) return "changes agent, shell or git configuration";
	return customReason(command, extra);
}

function writeReason(target: string, cwd: string): string | undefined {
	const expanded = target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
	const abs = path.resolve(cwd, expanded);
	const rel = path.relative(path.resolve(cwd), abs);
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return "writes outside the working folder";
	if (SENSITIVE_WRITE.test(abs)) return "writes a sensitive or configuration file";
	return undefined;
}

/**
 * Why this tool call needs the owner, or undefined when it doesn't.
 * Built-in tools are judged: bash/powershell commands, write/edit paths, and read/grep/find/ls
 * paths (secrets only). Other tools (MCP, extensions) pass.
 */
export function riskOf(toolName: string, input: Record<string, unknown>, cwd: string, extra: string[] = []): string | undefined {
	if ((toolName === "bash" || toolName === "powershell") && typeof input.command === "string") {
		return shellReason(input.command, extra);
	}
	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
		return writeReason(input.path, cwd) ?? customReason(input.path, extra);
	}
	if (toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls") {
		const targets = [input.path, input.glob].filter((v): v is string => typeof v === "string");
		if (targets.some((t) => SECRET.test(t) || SECRET.test(` ${t}`))) return "reads or exposes secrets or credentials";
		for (const t of targets) {
			const custom = customReason(t, extra);
			if (custom) return custom;
		}
	}
	return undefined;
}

/** Merge a partial guard section from policy.json over the defaults, ignoring junk values. */
export function guardFrom(raw: unknown): GuardConfig {
	const g = (raw && typeof raw === "object" ? raw : {}) as Partial<GuardConfig>;
	return {
		mode: g.mode === "ask" || g.mode === "block" || g.mode === "off" ? g.mode : DEFAULT_GUARD.mode,
		scope: g.scope === "all" || g.scope === "peer" ? g.scope : DEFAULT_GUARD.scope,
		extraPatterns: Array.isArray(g.extraPatterns) ? g.extraPatterns.filter((p): p is string => typeof p === "string") : [],
	};
}
