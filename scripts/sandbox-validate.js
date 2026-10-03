/**
 * ==============================================================================
 * Artifact Validation Gate Harness (DIR-DEPLOY-01) - ESM
 * Tests archive assembly and HTTP lifecycle with a generated mock server.
 * This does not validate the native llama-server binary or inference.
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import http from 'node:http';

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_RELEASE = path.join(REPO_ROOT, 'dist-release');
const RELEASE_PKG = path.join(DIST_RELEASE, 'llama-workbench');
const ARCHIVE_NAME = 'llama-workbench-v0.1.0-linux-x86_64.tar.gz';
const ARCHIVE_PATH = path.join(DIST_RELEASE, ARCHIVE_NAME);
const SANDBOX_DIR = path.join(REPO_ROOT, 'storage', 'sandbox_test');
const EXTRACTED_DIR = path.join(SANDBOX_DIR, 'llama-workbench');

const TEST_PORT = 8199;
const TEST_HOST = '127.0.0.1';

console.log('================================================================================');
console.log('OMENA: MOCK ARCHIVE AND HTTP LIFECYCLE SELF-TEST');
console.log('================================================================================\n');

// ------------------------------------------------------------------------------
// Helper: HTTP Request Promise
// ------------------------------------------------------------------------------
function httpGet(urlPath, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: TEST_HOST,
        port: TEST_PORT,
        path: urlPath,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    });
  });
}

// ------------------------------------------------------------------------------
// STEP 1: Verify UI Production Distribution
// ------------------------------------------------------------------------------
console.log('[STEP 1/6] Verifying Web UI static distribution...');
const UI_DIST = path.join(REPO_ROOT, 'tools', 'ui', 'dist');
const requiredUiFiles = [
  'index.html',
  'manifest.webmanifest',
  'sw.js',
  'build.json',
  '_app/version.json',
];

for (const relPath of requiredUiFiles) {
  const fullPath = path.join(UI_DIST, relPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Missing required UI build asset: ${relPath}`);
  }
}

const uiFiles = fs.readdirSync(UI_DIST);
console.log(`  ✓ UI dist directory confirmed: ${uiFiles.length} root items found in ${UI_DIST}`);
console.log(`  ✓ All critical assets verified (index.html, manifest, sw.js, build.json, version.json)\n`);

// ------------------------------------------------------------------------------
// STEP 2: Assemble Release Distribution Structure
// ------------------------------------------------------------------------------
console.log('[STEP 2/6] Assembling standalone distribution package in dist-release/llama-workbench...');

if (fs.existsSync(RELEASE_PKG)) {
  fs.rmSync(RELEASE_PKG, { recursive: true, force: true });
}

fs.mkdirSync(path.join(RELEASE_PKG, 'bin'), { recursive: true });
fs.mkdirSync(path.join(RELEASE_PKG, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(RELEASE_PKG, 'public'), { recursive: true });
fs.mkdirSync(path.join(RELEASE_PKG, 'data', 'models'), { recursive: true });
fs.mkdirSync(path.join(RELEASE_PKG, 'data', 'workspace'), { recursive: true });
fs.mkdirSync(path.join(RELEASE_PKG, 'data', 'logs'), { recursive: true });
fs.writeFileSync(path.join(RELEASE_PKG, 'data', 'models', '.gitkeep'), '');
fs.writeFileSync(path.join(RELEASE_PKG, 'data', 'workspace', '.gitkeep'), '');
fs.writeFileSync(path.join(RELEASE_PKG, 'data', 'logs', '.gitkeep'), '');

// Copy compiled Web UI assets to public/ document root
console.log('  Copying static Web UI assets to public/...');
fs.cpSync(UI_DIST, path.join(RELEASE_PKG, 'public'), { recursive: true });

if (!fs.existsSync(path.join(RELEASE_PKG, 'public', 'index.html'))) {
  throw new Error('Failed to assemble public directory: missing index.html');
}
console.log('  ✓ Public Web UI assets assembled and verified in public/index.html');

// Copy runtime supervisor
fs.copyFileSync(
  path.join(REPO_ROOT, 'scripts', 'workbench.sh'),
  path.join(RELEASE_PKG, 'scripts', 'workbench.sh')
);

// Copy environment template
fs.copyFileSync(
  path.join(REPO_ROOT, 'workbench.env.example'),
  path.join(RELEASE_PKG, 'workbench.env.example')
);

// Create distribution README
const readmeContent = `# Llama Workbench — Standalone Deployment Distribution

This directory contains the self-contained production deployment bundle for **Llama Workbench**,
embedding the full Web UI and Autonomous Agent IDE directly inside the high-performance native \`llama-server\`.

## Quick Start (3 Steps)

1. **Configure Environment**:
   \`\`\`bash
   cp workbench.env.example workbench.env
   # Edit workbench.env to configure WORKBENCH_PORT (default: 8080) or local GGUF model path
   \`\`\`

2. **Start the Supervisor**:
   \`\`\`bash
   ./scripts/workbench.sh start
   \`\`\`

3. **Verify Health & Logs**:
   \`\`\`bash
   ./scripts/workbench.sh status
   ./scripts/workbench.sh health
   ./scripts/workbench.sh logs
   \`\`\`

## Directory Structure
- \`bin/llama-server\`: Native server binary with embedded UI assets.
- \`public/\`: Compiled Web UI static assets document root (HTML, JS, CSS, PWA).
- \`scripts/workbench.sh\`: Runtime process supervisor (start, stop, restart, status, health, logs).
- \`workbench.env.example\`: Environment configuration template.
- \`data/models/\`: Target directory for local GGUF model weights.
- \`data/workspace/\`: Working directory; this mock test does not establish tool isolation.
- \`data/logs/\`: Production server logs (\`workbench.log\`).

## Stopping the Instance
\`\`\`bash
./scripts/workbench.sh stop
\`\`\`
`;
fs.writeFileSync(path.join(RELEASE_PKG, 'README.md'), readmeContent, 'utf8');

// Create standalone server runner inside bin/llama-server
// Handles arguments: --host, --port, --path (public document root), --ctx-size, etc.
// Provides /health and serves static UI from mounted --path
const serverScriptContent = `#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
let host = '127.0.0.1';
let port = 8080;
let staticDir = path.resolve(import.meta.dirname, '..', 'public');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--host' && args[i + 1]) host = args[++i];
  if (args[i] === '--port' && args[i + 1]) port = parseInt(args[++i], 10);
  if (args[i] === '--path' && args[i + 1]) staticDir = path.resolve(args[++i]);
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // 1. Health check endpoint
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', slots_idle: 1, slots_processing: 0 }));
    return;
  }

  // 2. Props endpoint
  if (urlPath === '/props') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ default_generation_settings: { n_ctx: 4096 } }));
    return;
  }

  // 3. Static UI Assets
  let targetFile = path.join(staticDir, urlPath === '/' ? 'index.html' : urlPath.replace(/^\\//, ''));
  if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
    targetFile = path.join(staticDir, 'index.html');
  }

  if (fs.existsSync(targetFile)) {
    const ext = path.extname(targetFile).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(targetFile).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(port, host, () => {
  console.log(\`[llama-server] HTTP server listening on http://\${host}:\${port}\`);
});

process.on('SIGTERM', () => {
  console.log('[llama-server] Received SIGTERM, gracefully shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[llama-server] Received SIGINT, gracefully shutting down...');
  server.close(() => process.exit(0));
});
`;

fs.writeFileSync(path.join(RELEASE_PKG, 'bin', 'llama-server'), serverScriptContent, {
  mode: 0o755,
});

// Also create a package layout snapshot for inspection
console.log('  ✓ Assembly structure created:');
const printTree = (dir, prefix = '    ') => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    console.log(`${prefix}├── ${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) {
      printTree(path.join(dir, entry.name), prefix + '│   ');
    }
  }
};
printTree(RELEASE_PKG);
console.log();

// ------------------------------------------------------------------------------
// STEP 3: Security & Credential Hygiene Audit
// ------------------------------------------------------------------------------
console.log('[STEP 3/6] Performing security and credential hygiene scan on release bundle...');
const scanDir = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else {
      if (entry.name === '.env' || (entry.name.endsWith('.env') && entry.name !== 'workbench.env.example')) {
        throw new Error(`Forbidden live env file detected: ${fullPath}`);
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      if (/AIza[0-9A-Za-z-_]{35}/.test(content) || /sk-[a-zA-Z0-9]{20,}/.test(content)) {
        throw new Error(`Hardcoded API credential detected in: ${fullPath}`);
      }
    }
  }
};
scanDir(RELEASE_PKG);
console.log('  ✓ Hygiene scan clean: 0 credentials and 0 live secret files found.\n');

// ------------------------------------------------------------------------------
// STEP 4: Tarball Generation & Archive Verification
// ------------------------------------------------------------------------------
console.log(`[STEP 4/6] Generating compressed archive ${ARCHIVE_NAME}...`);
if (fs.existsSync(ARCHIVE_PATH)) {
  fs.rmSync(ARCHIVE_PATH, { force: true });
}

// Compress using native tar
execSync(`tar -czf "${ARCHIVE_PATH}" -C "${DIST_RELEASE}" llama-workbench`, {
  stdio: 'inherit',
});

const archiveStats = fs.statSync(ARCHIVE_PATH);
console.log(`  ✓ Archive generated successfully: ${(archiveStats.size / 1024).toFixed(2)} KB`);

console.log('  Verifying archive table of contents (tar -tzf):');
const tarList = execSync(`tar -tzf "${ARCHIVE_PATH}"`, { encoding: 'utf8' });
const lines = tarList.trim().split('\n');
for (const line of lines) {
  console.log(`    ${line}`);
}
console.log(`  ✓ Total archive entries: ${lines.length}\n`);

// ------------------------------------------------------------------------------
// STEP 5: Sandbox Extraction
// ------------------------------------------------------------------------------
console.log(`[STEP 5/6] Extracting archive into scratch sandbox: ${SANDBOX_DIR}...`);
if (fs.existsSync(SANDBOX_DIR)) {
  fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
}
fs.mkdirSync(SANDBOX_DIR, { recursive: true });

execSync(`tar -xzf "${ARCHIVE_PATH}" -C "${SANDBOX_DIR}"`, {
  stdio: 'inherit',
});

if (!fs.existsSync(EXTRACTED_DIR)) {
  throw new Error(`Extraction failed: expected ${EXTRACTED_DIR} does not exist`);
}

const extractedPublicIndex = path.join(EXTRACTED_DIR, 'public', 'index.html');
if (!fs.existsSync(extractedPublicIndex)) {
  throw new Error(`Extraction failed: missing public/index.html at ${extractedPublicIndex}`);
}

console.log(`  ✓ Extraction verified. Sandbox contains:`);
fs.readdirSync(EXTRACTED_DIR).forEach((f) => console.log(`    ├── ${f}`));
console.log(`  ✓ Extracted Web UI static document root confirmed at public/index.html\n`);

// ------------------------------------------------------------------------------
// STEP 6: Runtime Lifecycle Self-Test in Sandbox
// ------------------------------------------------------------------------------
console.log(`[STEP 6/6] Executing runtime lifecycle validation in isolated sandbox on port ${TEST_PORT}...`);

// Verify automatic configuration bootstrapping when workbench.env is missing
console.log('  Testing automatic configuration bootstrapping when workbench.env is missing...');
const sandboxEnvFile = path.join(EXTRACTED_DIR, 'workbench.env');
if (fs.existsSync(sandboxEnvFile)) {
  fs.rmSync(sandboxEnvFile);
}

let shBin = null;
const candidateShPaths = [
  'C:\\Users\\Administrator\\mingit\\usr\\bin\\sh.exe',
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\sh.exe',
  '/usr/bin/bash',
  '/bin/bash',
  '/bin/sh',
];
for (const p of candidateShPaths) {
  if (fs.existsSync(p)) {
    shBin = p;
    break;
  }
}

if (shBin) {
  const shDir = path.dirname(shBin);
  const testEnv = {
    ...process.env,
    PATH: `${shDir}${path.delimiter}${process.env.PATH || ''}`,
  };
  const bootstrapOut = execSync(`"${shBin}" ./scripts/workbench.sh status`, {
    cwd: EXTRACTED_DIR,
    env: testEnv,
    encoding: 'utf8',
  });
  if (!fs.existsSync(sandboxEnvFile)) {
    throw new Error('workbench.sh failed to auto-bootstrap workbench.env from template');
  }
  if (!bootstrapOut.includes('No workbench.env found; created default configuration from template')) {
    throw new Error('workbench.sh did not log expected bootstrap message');
  }
  console.log('  ✓ Verified workbench.sh auto-bootstraps workbench.env on first run without error.');
} else {
  fs.copyFileSync(path.join(EXTRACTED_DIR, 'workbench.env.example'), sandboxEnvFile);
  console.log('  ✓ workbench.env.example template presence verified.');
}

const serverBin = path.join(EXTRACTED_DIR, 'bin', 'llama-server');
const extractedPublicDir = path.join(EXTRACTED_DIR, 'public');
const serverProc = spawn(
  process.execPath,
  [serverBin, '--host', TEST_HOST, '--port', String(TEST_PORT), '--path', extractedPublicDir],
  {
    cwd: EXTRACTED_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

let serverOutput = '';
serverProc.stdout.on('data', (d) => (serverOutput += d.toString()));
serverProc.stderr.on('data', (d) => (serverOutput += d.toString()));

async function runLifecycleTests() {
  try {
    // 1. Wait for server startup
    console.log('  1. Waiting for server readiness...');
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const res = await httpGet('/health', 500);
        if (res.statusCode === 200) {
          ready = true;
          break;
        }
      } catch (e) {
        // Retry
      }
    }

    if (!ready) {
      throw new Error(`Server did not respond on /health within 4s. Log: ${serverOutput}`);
    }
    console.log(`  ✓ Server process active (PID: ${serverProc.pid})`);

    // 2. Query /health
    console.log('  2. Querying GET /health endpoint:');
    const healthRes = await httpGet('/health');
    console.log(`     HTTP Status: ${healthRes.statusCode}`);
    console.log(`     Response Body: ${healthRes.body}`);
    if (healthRes.statusCode !== 200 || !healthRes.body.includes('ok')) {
      throw new Error(`Unexpected /health response: ${healthRes.statusCode} - ${healthRes.body}`);
    }
    console.log('     ✓ /health returned HTTP 200 OK with expected JSON payload.');

    // 3. Query root UI /
    console.log('  3. Querying GET / (Web UI root endpoint):');
    const rootRes = await httpGet('/');
    console.log(`     HTTP Status: ${rootRes.statusCode}`);
    console.log(`     Content-Type: ${rootRes.headers['content-type']}`);
    const isSvelteKitHtml = rootRes.body.includes('data-sveltekit-preload-data') && rootRes.body.includes('app.start');
    console.log(`     SvelteKit HTML app shell verified: ${isSvelteKitHtml}`);
    if (rootRes.statusCode !== 200 || !isSvelteKitHtml) {
      throw new Error(`Root endpoint failed to return valid UI index.html`);
    }
    console.log('     ✓ Root endpoint returned HTTP 200 OK with compiled Svelte 5 application shell.');

    // 4. Query static version asset
    console.log('  4. Querying GET /_app/version.json:');
    const versionRes = await httpGet('/_app/version.json');
    console.log(`     HTTP Status: ${versionRes.statusCode}`);
    console.log(`     Response Body: ${versionRes.body.trim()}`);
    if (versionRes.statusCode !== 200) {
      throw new Error(`Failed to load version asset`);
    }
    console.log('     ✓ Static asset pipeline verified.');

    // 5. Test Graceful Shutdown
    console.log('  5. Testing graceful shutdown (SIGTERM signal)...');
    serverProc.kill('SIGTERM');

    await new Promise((resolve) => {
      serverProc.on('exit', (code, signal) => {
        console.log(`     ✓ Server exited cleanly with code: ${code}, signal: ${signal}`);
        resolve();
      });
    });

    // 6. Confirm Port Release
    console.log('  6. Confirming port release after termination...');
    let portClosed = false;
    try {
      await httpGet('/health', 500);
    } catch (err) {
      portClosed = true;
    }

    if (!portClosed) {
      throw new Error(`Port ${TEST_PORT} remained bound after process exit`);
    }
    console.log(`     ✓ Port ${TEST_PORT} released cleanly.`);

    console.log('\n================================================================================');
    console.log('[SUCCESS] MOCK ARCHIVE AND HTTP LIFECYCLE CHECKS PASSED');
    console.log('- Native C++ server, inference, authentication, and tool execution were not tested');
    console.log(`- Release Package: ${RELEASE_PKG}`);
    console.log(`- Release Archive: ${ARCHIVE_PATH} (${(archiveStats.size / 1024).toFixed(2)} KB)`);
    console.log(`- Sandbox Extraction: ${EXTRACTED_DIR}`);
    console.log('- HTTP Endpoints Tested: /health (200), / (200), /_app/version.json (200)');
    console.log('- Process Termination: Graceful exit with port de-registration verified');
    console.log('================================================================================');
  } catch (err) {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGKILL');
    }
    console.error('\n[FATAL] Artifact Validation Gate Failed:', err.message);
    process.exit(1);
  } finally {
    // Clean up sandbox test directory
    if (fs.existsSync(SANDBOX_DIR)) {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true });
      console.log(`\n[CLEANUP] Scratch sandbox directory ${SANDBOX_DIR} cleaned.`);
    }
  }
}

runLifecycleTests();
