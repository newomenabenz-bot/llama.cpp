/**
 * Path Sandbox Validator.
 *
 * Enforces filesystem path boundaries against workspace roots for both
 * POSIX and Windows path representations without external dependencies.
 */

import type { PathValidationResult } from './types';

/**
 * Normalizes a path string:
 * - Unifies backslashes to forward slashes.
 * - Resolves '.' and '..' segments.
 * - Standardizes drive letters on Windows to lowercase.
 * - Strips trailing slashes (except for root).
 */
export function normalizePath(rawPath: string): string {
	if (!rawPath || typeof rawPath !== 'string') {
		return '';
	}

	// 1. Replace Windows backslashes with forward slashes
	let normalized = rawPath.replace(/\\/g, '/');

	// 2. Identify Windows drive prefix (e.g. "C:" or "c:")
	let drivePrefix = '';
	const driveMatch = normalized.match(/^([a-zA-Z]):(\/.*|$)/);
	if (driveMatch) {
		drivePrefix = driveMatch[1].toLowerCase() + ':';
		normalized = driveMatch[2] || '/';
	}

	// 3. Identify UNC prefix (e.g. "//server/share")
	let uncPrefix = '';
	if (normalized.startsWith('//')) {
		uncPrefix = '//';
		normalized = normalized.substring(2);
	}

	// 4. Determine if path is absolute
	const isAbsolute = normalized.startsWith('/');

	// 5. Segment resolution stack
	const segments = normalized.split('/').filter(Boolean);
	const resolvedSegments: string[] = [];

	for (const segment of segments) {
		if (segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (resolvedSegments.length > 0 && resolvedSegments[resolvedSegments.length - 1] !== '..') {
				resolvedSegments.pop();
			} else if (!isAbsolute) {
				resolvedSegments.push('..');
			}
			// If absolute and attempting to pop root, ignore the '..' (stays at root)
		} else {
			resolvedSegments.push(segment);
		}
	}

	let result = resolvedSegments.join('/');

	if (isAbsolute) {
		result = '/' + result;
	}

	if (drivePrefix) {
		result = drivePrefix + (result.startsWith('/') ? result : '/' + result);
	} else if (uncPrefix) {
		result = uncPrefix + result;
	}

	return result || (isAbsolute ? '/' : '.');
}

/**
 * Resolves a target path against a base directory.
 * If targetPath is absolute, returns normalized targetPath.
 * If targetPath is relative, joins with base directory and normalizes.
 */
export function resolvePath(baseDir: string, targetPath: string): string {
	const cleanBase = normalizePath(baseDir);
	const cleanTarget = (targetPath || '').replace(/\\/g, '/');

	// Check if target is absolute (starts with '/' or 'C:/' or '//')
	const isAbsoluteTarget =
		cleanTarget.startsWith('/') ||
		/^[a-zA-Z]:(\/.*|$)/.test(cleanTarget) ||
		cleanTarget.startsWith('//');

	if (isAbsoluteTarget) {
		return normalizePath(cleanTarget);
	}

	const joined = cleanBase.endsWith('/')
		? `${cleanBase}${cleanTarget}`
		: `${cleanBase}/${cleanTarget}`;

	return normalizePath(joined);
}

/**
 * Validates whether a target path is strictly contained within the specified workspace root.
 * Detects directory traversal attacks, root escapes, and sibling prefix attacks.
 */
export function validatePathWithinWorkspace(
	targetPath: string,
	workspaceRoot: string
): PathValidationResult {
	if (!workspaceRoot || typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
		return {
			allowed: false,
			normalizedPath: '',
			reason: 'Workspace root is undefined or invalid'
		};
	}

	if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
		return {
			allowed: false,
			normalizedPath: '',
			reason: 'Target path is empty or invalid'
		};
	}

	const normalizedRoot = normalizePath(workspaceRoot.trim());
	const resolvedTarget = resolvePath(normalizedRoot, targetPath.trim());

	// Traversal check: resolved target must be within root
	// Root match or strict child directory with trailing slash check
	const isRootExact = resolvedTarget === normalizedRoot;
	const isRootChild = resolvedTarget.startsWith(
		normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`
	);

	if (!isRootExact && !isRootChild) {
		return {
			allowed: false,
			normalizedPath: resolvedTarget,
			reason: `Path traversal detected: target path "${resolvedTarget}" is outside workspace root "${normalizedRoot}"`
		};
	}

	return {
		allowed: true,
		normalizedPath: resolvedTarget
	};
}
