# OMENA downstream engineering inventory

This is Omenabenz Global Ventures Limited's downstream fork of `ggml-org/llama.cpp`, maintained for the OMENA Autonomous DevOps & Engineering Platform. The company reports that it is a production infrastructure asset. This repository review does not establish the state of a deployed server.

## Audited baseline

- Branch: `master`; audited head: `9c0db4cccb5e9d13e791f047bfdea5dd2d22d468`.
- One remote branch and no remote tags were advertised during the audit.
- Upstream merge base: `52624716156a25af417b616e23bc712452d9396c`.
- 23 downstream commits and 3,737 tracked files were inventoried. All 11,247 branch-reachable commits were scanned, together with current files and commit messages.
- The 23-file workbench unit-test baseline passed 363 tests. Live Gemini calls, a production deployment, and cloud credentials were not exercised.

## Feature inventory

Commit identifiers below are downstream commits unless explicitly marked as inherited. Implementation and unit-test evidence do not establish production availability.

| Feature | Files | Commits | Status |
| --- | --- | --- | --- |
| Gemini provider and model discovery | `tools/ui/src/lib/workbench/providers/gemini.provider.ts`, `provider.service.ts`, `settings/workbench-settings.service.ts` | `1607bf179a4c`, `f4dec290397e`, `63b858cf68cc`, `eeaa2cec5fa5`, `d77fd6e250a7` | Implementation and mocked provider tests present; live provider not tested. |
| Thought signatures | `gemini.provider.ts`, `tools/ui/src/lib/types/api.d.ts` | `fd1eadd3327f`, `97e385856309`, `902608c6d757` | Signature parsing, history preservation, and Part-level serialization have dedicated unit tests. |
| Agentic tool execution | `tools/ui/src/lib/stores/agentic/index.svelte.ts`, `workbench/security/workbench-security.bridge.ts`, `workbench/terminal/terminal.service.ts` | `1607bf179a4c`, `f4dec290397e`, `d87fd90bdc5b` | Provider/tool loop and client policy are present; native execution is inherited. |
| Workbench UI and task graph | `tools/ui/src/lib/workbench/components/`, `workbench/task/`, `tools/ui/src/routes/+layout.svelte` | `1607bf179a4c`, `f4dec290397e`, `0b196bea31d9` | Components, graph, and layout tests present. |
| Persistent storage and server sync | `tools/ui/src/lib/services/database.service.ts`, `server-storage-sync.service.ts`, `workbench/persistence/` | `1607bf179a4c`, `362d910164de`, `ea1e5ce5d0e0` | IndexedDB/checkpoints and server-file snapshots present; private settings and Gemini keys are excluded from new settings sync. Review older snapshots privately. |
| Supervisor and workspace defaults | `scripts/workbench.sh`, `workbench.env.example`, `workbench/settings/workbench-settings.service.ts` | `1607bf179a4c`, `b053bfee7ba6`, `9b934f3a5592`, `d87fd90bdc5b` | Start/stop/health/log commands and configurable process directory present. Existing `/home/ubuntu` default is preserved; it is not a sandbox. |
| Packaging and assets | `scripts/package-workbench.sh`, `scripts/ui-assets.cmake`, `tools/ui/vite.config.ts` | `1607bf179a4c`, `b053bfee7ba6`, `9b934f3a5592`, `28d062bcd23b`, `bf2254865b7b`, `ec4b4b651d08` | UI/native assembly exists; package contains the environment example, not live runtime configuration. |
| Diagnostics | `scripts/sandbox-validate.js` | `1607bf179a4c` | Mock HTTP server and archive smoke harness; it does not validate the actual C++ server or inference. |
| Native `/tools` API | `tools/server/server.cpp`, `tools/server/server-tools.cpp`, `common/arg.cpp` | Inherited at the upstream merge base | GET/POST routes, tool selection, file operations, and shell execution exist upstream; these are not Omenabenz-specific C++ changes. |
| Deployment and systemd | `DEPLOYMENT.md` | `1607bf179a4c` | Build/deploy instructions and a sample unit exist; no installed service was audited. |
| Docker and Terraform generation | Native shell tool and workbench provider prompt/tool loop | No dedicated downstream generator found | General shell/file tools can create such files; no specialized generator or validated cloud deployment was identified. |
| Caddy/reverse proxy | `DEPLOYMENT.md` | `1607bf179a4c` | Nginx example present. No Omenabenz Caddy configuration or integration was found. |

## Trust and configuration boundaries

The native tools API is privileged. Frontend command classification, execution modes, and path checks do not prevent a client from calling the authenticated API directly. Treat access to the workbench as access to the service account.

The supervisor now binds to loopback and restricts CORS by default. A non-loopback bind requires a server API key. It preserves configured workspace paths and passes keys through the supported `LLAMA_API_KEY` environment mechanism rather than process arguments. Existing runtime configurations using public binding without a key or wildcard CORS must be updated before restarting.

Provider keys are configured per browser. Settings synchronization keeps non-private preferences and conversations but does not publish the Gemini key or registry-marked private app settings to the shared server snapshot. This does not encrypt browser storage or erase old snapshots. Review existing `settings.json` and backups privately; rotate keys if those files were exposed.

`GEMINI_API_KEY`, `GITHUB_TOKEN`, and `WORKBENCH_PASSWORD` examples are placeholders only. No new password login or automatic server-side Gemini configuration was implemented. Never set secrets in Vite public environment variables or commit runtime `.env` files.

## GitHub Actions audit

57 YAML workflow files were reviewed, inherited from upstream without downstream changes. No workflow runs were returned at audit time. Several workflows expect upstream-specific self-hosted runners, secrets, release registries, or bot accounts; the draft and labeling workflows use `pull_request_target`.

Do not enable upstream-only privileged automation on company runners without reviewing its events, checkout refs, permissions, secrets, and publishing destinations. A repository transfer does not provision organization secrets or validate runner isolation. The audit did not verify secret values, external publishing accounts, or installed runners.

## Migration to `omenabenzglobal`

The intended destination is `omenabenzglobal/llama.cpp`. Until GitHub confirms the transfer, the source remains `newomenabenz-bot/llama.cpp`.

1. Review and publish the focused cleanup under the repository's contribution/agent instructions. Preserve the MIT license, upstream attribution, default branch, and existing commit ancestry.
2. Confirm exposed credentials, if any are identified, have been revoked or rotated before migration. No destructive history rewrite is part of this patch.
3. Confirm destination ownership, repository-creation permission, and that the organization has no conflicting repository/fork in the same network. Review active deployments, webhooks, applications, deploy keys, Actions, and package references before changing ownership.
4. Transfer the existing repository through GitHub repository settings or an owner-authorized transfer API. Do not create an unrelated replacement copy or merge upstream as part of the transfer.
5. Verify the repository ID, fork relationship, default branch, branch heads, commit ancestry, visibility, installed App access, and redirects after completion.
6. Update deployment clones to `https://github.com/omenabenzglobal/llama.cpp.git`, review integrations and organization settings, and perform a controlled release/rollback check. GitHub redirects do not replace that verification.

No production service should restart merely because ownership changes. Deploy the hardened configuration through the existing maintenance process.

Company contact: [ceo@omenabenzglobalventures.online](mailto:ceo@omenabenzglobalventures.online).
