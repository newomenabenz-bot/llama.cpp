/**
 * LlamaServerProvider - Default upstream adapter for llama-server.
 *
 * Implements IModelProvider and IWorkbenchProvider by extending LocalLlamaProvider,
 * preserving backwards compatibility with all existing imports.
 */

import { LocalLlamaProvider } from './llama.provider';
export { LocalLlamaProvider };

export class LlamaServerProvider extends LocalLlamaProvider {
	override readonly id = 'llama-server';
	override readonly name = 'Llama.cpp Server';
	override readonly displayName = 'Llama.cpp Server';
}
