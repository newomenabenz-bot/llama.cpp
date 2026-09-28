/**
 * Command Guard - Shell Command Risk Classifier.
 *
 * Classifies shell commands into risk tiers (LOW, MEDIUM, HIGH, CRITICAL)
 * to prevent destructive execution, system compromise, or data loss.
 */

import type { CommandClassificationResult, CommandRisk } from './types';

const RISK_WEIGHTS: Record<CommandRisk, number> = {
	LOW: 1,
	MEDIUM: 2,
	HIGH: 3,
	CRITICAL: 4
};

// Patterns representing CRITICAL risk commands (system destructive, root wipe, disk format, fork bombs)
const CRITICAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(\/|\/\*|~|\.\.|\.)(\s|$|;)/i,
		reason: 'Destructive root or recursive directory wipe detected (rm -rf /)'
	},
	{
		pattern: /\b(del|erase)\s+.*([a-zA-Z]:\\|\*.*)(\/s|\/f)/i,
		reason: 'Destructive recursive filesystem deletion detected'
	},
	{
		pattern: /\b(rd|rmdir)\s+\/s\s+\/q\s+([a-zA-Z]:\\|\/|~)/i,
		reason: 'Destructive recursive root folder removal detected (rmdir /s /q)'
	},
	{
		pattern: /\b(mkfs(\.[a-zA-Z0-9_-]+)?|fdisk|parted|diskpart)\b|\bformat\s+[a-zA-Z]:/i,
		reason: 'Disk formatting or partition destruction command detected'
	},
	{
		pattern: /\bdd\s+if=.*of=(\/dev\/|\\\\\\.\\)/i,
		reason: 'Raw disk overwrite command detected (dd of=/dev/...)'
	},
	{
		pattern: /:\(\)\s*\{\s*:\|:&\s*\};:|%\s*0\s*\|\s*%\s*0/,
		reason: 'Fork bomb attack pattern detected'
	},
	{
		pattern: /\b(shutdown|reboot|poweroff|init\s+[06]|halt)\b/i,
		reason: 'System shutdown or reboot command detected'
	},
	{
		pattern: /(curl|wget|fetch)\s+[^|;&]+\|\s*(bash|sh|zsh|dash|powershell|pwsh|cmd)/i,
		reason: 'Untrusted remote binary execution pipe detected (curl | bash)'
	},
	{
		pattern: /(Invoke-Expression|iex)\s*(\(|.*(New-Object|iwr|Invoke-WebRequest))/i,
		reason: 'PowerShell arbitrary remote script execution detected (iex iwr)'
	},
	{
		pattern: /\b(chmod|chown)\s+.*(-R\s+)?(777|\+x)\s+(\/|\/etc|\/usr|\/bin|\/boot)/i,
		reason: 'Global system root permission degradation detected'
	},
	{
		pattern: /\b(sudo|doas|runas)\b/i,
		reason: 'Privilege escalation command detected (sudo/doas/runas)'
	}
];

// Patterns representing HIGH risk commands (arbitrary deletions, process killing, forced git)
const HIGH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /\brm\s+-[a-zA-Z]*f/i,
		reason: 'Force deletion command detected'
	},
	{
		pattern: /\b(unlink|truncate)\b/i,
		reason: 'File truncation or unlinking command detected'
	},
	{
		pattern: /\b(kill\s+-9|killall|taskkill\s+\/f)\b/i,
		reason: 'Forced process termination detected'
	},
	{
		pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|push\s+.*--force)\b/i,
		reason: 'Destructive git reset, clean, or force-push detected'
	},
	{
		pattern: /\b(nc|ncat|socat|netcat)\s+.*(-l|-e|\/dev\/tcp)/i,
		reason: 'Reverse shell or network socket listener detected'
	}
];

// Patterns representing MEDIUM risk commands (state mutation, builds, package installs)
const MEDIUM_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /\b(npm\s+(i|install|add|update)|yarn\s+add|pnpm\s+add|pip\s+install|cargo\s+build|gem\s+install)\b/i,
		reason: 'Package manager dependency installation or build'
	},
	{
		pattern: /\b(mkdir|touch|mv|cp|copy)\b/i,
		reason: 'Filesystem structure modification'
	},
	{
		pattern: /\bgit\s+(checkout|commit|merge|rebase|pull|push)\b/i,
		reason: 'Version control branch or history mutation'
	},
	{
		pattern: /\b(docker|podman|kubectl)\b/i,
		reason: 'Container runtime invocation'
	}
];

// Patterns representing LOW risk commands (inspection, testing, read-only queries)
const LOW_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{
		pattern: /^(ls|dir|vdir|pwd|cd)(\s+.*)?$/i,
		reason: 'Directory listing or location query'
	},
	{
		pattern: /^(cat|type|head|tail|more|less)(\s+.*)?$/i,
		reason: 'File content inspection'
	},
	{
		pattern: /^(grep|find|findstr|which|where)(\s+.*)?$/i,
		reason: 'Search or path lookup'
	},
	{
		pattern: /^(git\s+(status|log|diff|branch|show|remote))(\s+.*)?$/i,
		reason: 'Git inspection query'
	},
	{
		pattern: /^(npm\s+(test|run\s+test)|npx\s+vitest|cargo\s+test|pytest|go\s+test)(\s+.*)?$/i,
		reason: 'Automated test suite execution'
	},
	{
		pattern: /^(node\s+-v|npm\s+-v|python\s+--version|git\s+--version|uname|whoami|echo)(\s+.*)?$/i,
		reason: 'System introspection or echo'
	}
];

/**
 * Classifies a single command or sub-command string.
 */
function classifySingleSubcommand(subcmd: string): CommandClassificationResult {
	const trimmed = subcmd.trim();
	if (!trimmed) {
		return { risk: 'LOW', reason: 'Empty command' };
	}

	// 1. Check CRITICAL patterns
	for (const { pattern, reason } of CRITICAL_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { risk: 'CRITICAL', reason };
		}
	}

	// 2. Check HIGH patterns
	for (const { pattern, reason } of HIGH_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { risk: 'HIGH', reason };
		}
	}

	// 3. Check LOW inspection patterns
	for (const { pattern, reason } of LOW_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { risk: 'LOW', reason };
		}
	}

	// 4. Check MEDIUM mutation patterns
	for (const { pattern, reason } of MEDIUM_PATTERNS) {
		if (pattern.test(trimmed)) {
			return { risk: 'MEDIUM', reason };
		}
	}

	// Default fallback for unrecognized non-critical shell commands is MEDIUM
	return { risk: 'MEDIUM', reason: 'Unclassified command invocation' };
}

/**
 * Classifies the risk level of a shell command string, resolving chained sub-commands (&&, ||, ;, |).
 * The overall risk is the maximum risk of any sub-command in the pipeline.
 */
export function classifyCommandRisk(command: string): CommandClassificationResult {
	if (!command || typeof command !== 'string' || !command.trim()) {
		return { risk: 'LOW', reason: 'Empty command' };
	}

	const trimmedFull = command.trim();

	// 1. Evaluate CRITICAL patterns against the entire command line first (preserves pipes, fork bombs, chained redirects)
	for (const { pattern, reason } of CRITICAL_PATTERNS) {
		if (pattern.test(trimmedFull)) {
			return { risk: 'CRITICAL', reason };
		}
	}

	// 2. Split on command separators (;, &&, ||) to inspect individual sub-commands
	const subcommands = trimmedFull.split(/;|&&|\|\|/).map((s) => s.trim()).filter(Boolean);

	if (subcommands.length === 0) {
		return { risk: 'LOW', reason: 'Empty command' };
	}

	let highestRisk: CommandRisk = 'LOW';
	let highestReason = 'Safe inspection command';

	for (const sub of subcommands) {
		const result = classifySingleSubcommand(sub);
		if (RISK_WEIGHTS[result.risk] > RISK_WEIGHTS[highestRisk]) {
			highestRisk = result.risk;
			highestReason = result.reason || `Detected ${result.risk} risk sub-command`;
		}
	}

	return {
		risk: highestRisk,
		reason: highestReason
	};
}
