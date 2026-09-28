/**
 * Unit tests for Workbench Context Budgeting, Tool Output Compaction & Token Estimator.
 *
 * Verifies:
 * 1. Head/tail compaction of oversized tool execution outputs.
 * 2. Protection of active/current turn tool responses from compaction.
 * 3. Token estimation across plain text, multimodal, reasoning, and tool calls.
 * 4. Context budget enforcement with warning/critical threshold transitions.
 * 5. Immutability of conversation histories during preparation.
 */

import { describe, expect, it } from 'vitest';
import {
	compactToolOutput,
	DEFAULT_CONTEXT_BUDGET_CONFIG,
	estimateHistoryTokens,
	estimateMessageTokens,
	estimateTextTokens,
	WorkbenchContextBudgetService
} from '$lib/workbench/context';
import type { ApiChatMessageData, DatabaseMessage } from '$lib/types';
import { ContentPartType } from '$lib/enums';

describe('Workbench Context Budget & Tool Compactor', () => {
	// --------------------------------------------------------------------------
	// 1. Tool Compactor Logic
	// --------------------------------------------------------------------------
	describe('compactToolOutput', () => {
		it('passes through small tool outputs untouched', () => {
			const content = 'File contents:\nexport const x = 42;\nconsole.log(x);';
			const result = compactToolOutput(content, { maxToolOutputChars: 4000 });

			expect(result.compacted).toBe(false);
			expect(result.text).toBe(content);
			expect(result.originalChars).toBe(content.length);
			expect(result.finalChars).toBe(content.length);
		});

		it('handles null or empty content gracefully', () => {
			const result = compactToolOutput('', { maxToolOutputChars: 4000 });
			expect(result.compacted).toBe(false);
			expect(result.text).toBe('');
			expect(result.originalChars).toBe(0);
		});

		it('compacts multi-line outputs exceeding maxToolOutputChars preserving head and tail', () => {
			// Generate 100 lines of log output
			const lines = Array.from({ length: 100 }, (_, i) => `Log entry line ${i + 1}: timestamp [2026-09-28] status OK payload data`);
			const content = lines.join('\n');
			expect(content.length).toBeGreaterThan(4000);

			const result = compactToolOutput(content, {
				maxToolOutputChars: 4000,
				headLinesPreserved: 10,
				tailLinesPreserved: 10
			});

			expect(result.compacted).toBe(true);
			expect(result.finalChars).toBeLessThan(result.originalChars);

			// Check first and last preserved lines
			expect(result.text).toContain('Log entry line 1:');
			expect(result.text).toContain('Log entry line 10:');
			expect(result.text).not.toContain('Log entry line 50:');
			expect(result.text).toContain('Log entry line 91:');
			expect(result.text).toContain('Log entry line 100:');

			// Check exact omission notice format
			const omittedLines = 100 - 10 - 10;
			expect(result.text).toContain(`... [Workbench: ${omittedLines} lines (`);
			expect(result.text).toContain('omitted for context budget] ...');
		});

		it('compacts single-line or huge minified outputs exceeding maxToolOutputChars', () => {
			const hugeSingleLine = '{"data":[' + '"item",'.repeat(2000) + '"end"]}';
			expect(hugeSingleLine.length).toBeGreaterThan(4000);

			const result = compactToolOutput(hugeSingleLine, { maxToolOutputChars: 1000 });

			expect(result.compacted).toBe(true);
			expect(result.text).toContain('{"data":[');
			expect(result.text).toContain('"end"]}');
			expect(result.text).toContain('... [Workbench: 0 lines (');
			expect(result.text).toContain('omitted for context budget] ...');
			expect(result.finalChars).toBeLessThan(hugeSingleLine.length);
		});
	});

	// --------------------------------------------------------------------------
	// 2. Token Estimator Logic
	// --------------------------------------------------------------------------
	describe('token-estimator', () => {
		it('calculates text tokens using 3.85 chars/token heuristic', () => {
			const text = '12345678';
			expect(estimateTextTokens(text)).toBe(Math.ceil(8 / 3.85));
			expect(estimateTextTokens('')).toBe(0);
		});

		it('estimates tokens for plain text messages including base framing overhead', () => {
			const msg: ApiChatMessageData = {
				role: 'user',
				content: 'Hello, what is the weather today?'
			};

			const tokens = estimateMessageTokens(msg);
			const expected = 4 + Math.ceil(msg.content.length / 3.85);
			expect(tokens).toBe(expected);
		});

		it('accounts for reasoning_content in assistant messages', () => {
			const plainMsg: ApiChatMessageData = {
				role: 'assistant',
				content: 'The answer is 42.'
			};
			const withReasoning: ApiChatMessageData = {
				role: 'assistant',
				content: 'The answer is 42.',
				reasoning_content: 'Let me think step by step through this complex mathematical derivation...'
			};

			const plainTokens = estimateMessageTokens(plainMsg);
			const reasoningTokens = estimateMessageTokens(withReasoning);

			expect(reasoningTokens).toBeGreaterThan(plainTokens);
			expect(reasoningTokens).toBe(plainTokens + Math.ceil(withReasoning.reasoning_content!.length / 3.85));
		});

		it('accounts for assistant tool_calls proposals and arguments', () => {
			const msgWithTools: ApiChatMessageData = {
				role: 'assistant',
				content: 'Let me check that file.',
				tool_calls: [
					{
						id: 'call_123',
						type: 'function',
						function: {
							name: 'read_file',
							arguments: JSON.stringify({ path: '/etc/hosts' })
						}
					}
				]
			};

			const tokens = estimateMessageTokens(msgWithTools);
			expect(tokens).toBeGreaterThan(4 + Math.ceil(msgWithTools.content.length / 3.85));
		});

		it('estimates multimodal image content parts at fixed token weight', () => {
			const multimodalMsg: ApiChatMessageData = {
				role: 'user',
				content: [
					{ type: ContentPartType.TEXT, text: 'Look at this picture:' },
					{ type: ContentPartType.IMAGE_URL, image_url: { url: 'data:image/png;base64,abc' } }
				]
			};

			const tokens = estimateMessageTokens(multimodalMsg);
			expect(tokens).toBeGreaterThan(256);
		});

		it('handles DatabaseMessage formats with serialized toolCalls string', () => {
			const dbMsg: Partial<DatabaseMessage> = {
				role: 'assistant',
				content: 'Executing search',
				toolCalls: JSON.stringify([{ id: 'c1', name: 'search', args: {} }]),
				reasoningContent: 'Planning query'
			};

			const tokens = estimateMessageTokens(dbMsg as DatabaseMessage);
			expect(tokens).toBeGreaterThan(20);
		});

		it('accurately aggregates full conversation history token counts', () => {
			const messages: ApiChatMessageData[] = [
				{ role: 'system', content: 'You are an autonomous coding assistant.' },
				{ role: 'user', content: 'List files in the directory.' },
				{
					role: 'assistant',
					content: 'Checking directory...',
					tool_calls: [
						{
							id: 'c1',
							type: 'function',
							function: { name: 'list_dir', arguments: '{"path":"."}' }
						}
					]
				},
				{ role: 'tool', content: 'file1.ts\nfile2.ts', tool_call_id: 'c1' }
			];

			const total = estimateHistoryTokens(messages);
			expect(total).toBeGreaterThan(40);
		});
	});

	// --------------------------------------------------------------------------
	// 3. WorkbenchContextBudgetService & Dispatch Preparation
	// --------------------------------------------------------------------------
	describe('WorkbenchContextBudgetService', () => {
		it('leaves messages untouched if total tokens are below warningThreshold', () => {
			const hugeHistoricalToolOutput = 'A'.repeat(10000);
			const messages: ApiChatMessageData[] = [
				{ role: 'user', content: 'Run command' },
				{ role: 'assistant', content: 'Running' },
				{ role: 'tool', content: hugeHistoricalToolOutput, tool_call_id: 'c1' },
				{ role: 'user', content: 'Next step' }
			];

			// Set maxTokens high enough so warningThreshold is not triggered
			const prepared = WorkbenchContextBudgetService.prepareMessagesForDispatch(messages, {
				maxTokens: 100000,
				warningThreshold: 0.75
			});

			expect(prepared[2].content).toBe(hugeHistoricalToolOutput);
			expect(prepared).toEqual(messages);
		});

		it('compacts oversized historical tool outputs when token budget exceeds warningThreshold', () => {
			const hugeLog = Array.from({ length: 150 }, (_, i) => `Server debug trace line ${i}: detailed output information`).join('\n');

			const messages: ApiChatMessageData[] = [
				{ role: 'user', content: 'Analyze logs' },
				{ role: 'assistant', content: 'Analyzing' },
				// Historical tool response that should be compacted
				{ role: 'tool', content: hugeLog, tool_call_id: 'call-hist' },
				{ role: 'assistant', content: 'I see an error on line 40.' },
				{ role: 'user', content: 'Continue fixing it.' }
			];

			// Set maxTokens low enough to trigger compaction
			const prepared = WorkbenchContextBudgetService.prepareMessagesForDispatch(messages, {
				maxTokens: 1500,
				warningThreshold: 0.5,
				maxToolOutputChars: 1000,
				headLinesPreserved: 5,
				tailLinesPreserved: 5
			});

			// Historical tool message must be compacted
			const compactedMsg = prepared[2];
			expect(compactedMsg.role).toBe('tool');
			expect(typeof compactedMsg.content).toBe('string');
			expect(compactedMsg.content).toContain('... [Workbench:');
			expect((compactedMsg.content as string).length).toBeLessThan(hugeLog.length);
		});

		it('NEVER compacts the current/active turn tool response even when oversized and above budget', () => {
			const hugeHistorical = Array.from({ length: 100 }, (_, i) => `Historical log line ${i}`).join('\n');
			const hugeCurrentTurn = Array.from({ length: 100 }, (_, i) => `Current turn execution output line ${i}`).join('\n');

			const messages: ApiChatMessageData[] = [
				{ role: 'user', content: 'Step 1' },
				{ role: 'assistant', content: 'Running step 1' },
				// Historical tool message (index 2)
				{ role: 'tool', content: hugeHistorical, tool_call_id: 'call-1' },
				{ role: 'assistant', content: 'Step 1 done. Starting step 2.' },
				// Current turn tool response (tail of messages array, index 4)
				{ role: 'tool', content: hugeCurrentTurn, tool_call_id: 'call-2' }
			];

			const prepared = WorkbenchContextBudgetService.prepareMessagesForDispatch(messages, {
				maxTokens: 1000,
				warningThreshold: 0.1, // Force trigger
				maxToolOutputChars: 500,
				headLinesPreserved: 5,
				tailLinesPreserved: 5
			});

			// Historical tool response (index 2) should be compacted
			expect((prepared[2].content as string)).toContain('... [Workbench:');
			expect((prepared[2].content as string).length).toBeLessThan(hugeHistorical.length);

			// Current turn tool response (index 4) MUST NOT be compacted!
			expect(prepared[4].content).toBe(hugeCurrentTurn);
			expect((prepared[4].content as string)).not.toContain('... [Workbench:');
		});

		it('protects multiple consecutive current-turn parallel tool responses at tail', () => {
			const hugeTool1 = 'Line A\n'.repeat(80);
			const hugeTool2 = 'Line B\n'.repeat(80);

			const messages: ApiChatMessageData[] = [
				{ role: 'user', content: 'Run parallel tools' },
				{ role: 'assistant', content: 'Proposing 2 parallel tools' },
				// Current turn has 2 consecutive tool responses at the tail
				{ role: 'tool', content: hugeTool1, tool_call_id: 'call-p1' },
				{ role: 'tool', content: hugeTool2, tool_call_id: 'call-p2' }
			];

			const prepared = WorkbenchContextBudgetService.prepareMessagesForDispatch(messages, {
				maxTokens: 100,
				warningThreshold: 0.1, // Aggressive trigger
				maxToolOutputChars: 200
			});

			// Neither tail tool message should be compacted
			expect(prepared[2].content).toBe(hugeTool1);
			expect(prepared[3].content).toBe(hugeTool2);
		});

		it('reports accurate budget status via getBudgetStatus', () => {
			const shortMessages: ApiChatMessageData[] = [
				{ role: 'user', content: 'Short prompt' }
			];

			const statusNormal = WorkbenchContextBudgetService.getBudgetStatus(shortMessages, {
				maxTokens: 10000,
				warningThreshold: 0.75,
				criticalThreshold: 0.9
			});

			expect(statusNormal.isWarning).toBe(false);
			expect(statusNormal.isCritical).toBe(false);

			const largeMessages: ApiChatMessageData[] = [
				{ role: 'user', content: 'X'.repeat(3000) } // ~780 tokens
			];

			const statusWarning = WorkbenchContextBudgetService.getBudgetStatus(largeMessages, {
				maxTokens: 1000,
				warningThreshold: 0.75,
				criticalThreshold: 0.9
			});

			expect(statusWarning.isWarning).toBe(true);
			expect(statusWarning.isCritical).toBe(false);

			const statusCritical = WorkbenchContextBudgetService.getBudgetStatus(largeMessages, {
				maxTokens: 800,
				warningThreshold: 0.75,
				criticalThreshold: 0.9
			});

			expect(statusCritical.isWarning).toBe(true);
			expect(statusCritical.isCritical).toBe(true);
		});
	});
});
