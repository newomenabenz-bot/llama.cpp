import { buildInfoPlugin } from './scripts/vite-plugin-build-info';
import { nerdamerPlugin } from './scripts/vite-plugin-nerdamer';
import { relativizeBasePlugin } from './scripts/vite-plugin-relativize-base';
import { splashScreenPlugin } from './scripts/vite-plugin-splash-screen';
import { SVELTEKIT_PWA_OPTIONS } from './src/lib/constants/pwa.constants';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { playwright } from '@vitest/browser-playwright';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from 'vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const browserBaseConfig: any = {
	enabled: true,
	instances: [{ browser: 'chromium' }],
	provider: playwright({
		launchOptions: {
			args: ['--no-sandbox']
		}
	})
};

function splitChunksPlugin(): Plugin {
	return {
		name: 'workbench-split-chunks',
		enforce: 'post',
		config() {
			return {
				build: {
					rollupOptions: {
						output: {
							inlineDynamicImports: false
						}
					}
				}
			};
		},
		configResolved(config) {
			const output = config.build.rollupOptions.output;
			if (output) {
				if (Array.isArray(output)) {
					for (const o of output) {
						o.inlineDynamicImports = false;
						o.chunkFileNames = '_app/immutable/chunks/[name]-[hash].js';
					}
				} else {
					output.inlineDynamicImports = false;
					output.chunkFileNames = '_app/immutable/chunks/[name]-[hash].js';
				}
			}
		}
	};
}

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, process.cwd(), 'VITE_PUBLIC_');
	const SERVER_ORIGIN = env.VITE_PUBLIC_SERVER_ORIGIN || 'http://localhost:8080';

	return {
		build: {
			assetsInlineLimit: 32000,
			chunkSizeWarningLimit: 1000,
			minify: true,
			rollupOptions: {
				output: {
					inlineDynamicImports: false,
					manualChunks(id: string) {
						if (
							id.includes('mermaid') ||
							id.includes('d3') ||
							id.includes('dagre') ||
							id.includes('cytoscape') ||
							id.includes('elkjs') ||
							id.includes('khroma') ||
							id.includes('stylis')
						) {
							return 'vendor-diagrams';
						}
						if (
							id.includes('marked') ||
							id.includes('highlight.js') ||
							id.includes('rehype-highlight') ||
							id.includes('nerdamer') ||
							id.includes('katex') ||
							id.includes('rehype-katex') ||
							id.includes('remark-math') ||
							id.includes('big-integer') ||
							id.includes('decimal.js') ||
							id.includes('remark') ||
							id.includes('rehype') ||
							id.includes('unified') ||
							id.includes('unist') ||
							id.includes('mdast') ||
							id.includes('mdsvex') ||
							id.includes('dompurify') ||
							id.includes('micromark') ||
							id.includes('vfile')
						) {
							return 'vendor-render';
						}
						if (
							id.includes('@lucide/svelte') ||
							id.includes('bits-ui') ||
							id.includes('radix') ||
							id.includes('@floating-ui') ||
							id.includes('svelte-sonner') ||
							id.includes('mode-watcher')
						) {
							return 'vendor-ui';
						}
						if (id.includes('pdfjs-dist') || id.includes('fflate')) {
							return 'vendor-pdf';
						}
					}
				}
			}
		},

		plugins: [
			tailwindcss(),
			sveltekit(),
			SvelteKitPWA(SVELTEKIT_PWA_OPTIONS),
			splashScreenPlugin(),
			buildInfoPlugin(),
			nerdamerPlugin(),
			relativizeBasePlugin(),
			splitChunksPlugin()
		],

		resolve: {
			alias: {
				'katex-fonts': resolve('node_modules/katex/dist/fonts')
			}
		},

		server: {
			fs: {
				allow: [searchForWorkspaceRoot(process.cwd()), resolve(__dirname, 'tests')]
			},
			headers: {
				'Cross-Origin-Embedder-Policy': 'require-corp',
				'Cross-Origin-Opener-Policy': 'same-origin'
			},
			proxy: {
				'/cors-proxy': SERVER_ORIGIN,
				'/models': SERVER_ORIGIN,
				'/props': SERVER_ORIGIN,
				'/slots': SERVER_ORIGIN,
				'/tools': SERVER_ORIGIN,
				'/v1': SERVER_ORIGIN
			}
		},

		test: {
			projects: [
				{
					extends: './vite.config.ts',
					test: {
						browser: browserBaseConfig,
						include: ['tests/client/**/*.svelte.{test,spec}.{js,ts}'],
						name: 'client',
						setupFiles: ['./vitest-setup-client.ts']
					}
				},

				{
					extends: './vite.config.ts',
					test: {
						environment: 'node',
						include: ['tests/unit/**/*.{test,spec}.{js,ts}'],
						name: 'unit'
					}
				},

				{
					extends: './vite.config.ts',
					plugins: [
						storybookTest({
							storybookScript: 'pnpm run storybook --no-open'
						})
					],
					test: {
						browser: { ...browserBaseConfig, instances: [{ browser: 'chromium', headless: true }] },
						name: 'ui'
					}
				}
			]
		}
	};
});
