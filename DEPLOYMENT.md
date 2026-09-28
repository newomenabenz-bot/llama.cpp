# Llama Workbench — Production Deployment & Operations Manual
**Directive Reference**: `DIR-DEPLOY-01 (Amended)`  
**Release Target**: Llama Workbench (Embedded llama-server + Web UI + Autonomous Agent IDE)

---

## 1. System Requirements & Toolchain Prerequisites

### 1.1 Hardware Specifications
- **Operating System**: Linux (Ubuntu 22.04 LTS / Debian 12 recommended, x86_64).
- **RAM**: Minimum 2 GB (host only without local LLM); 8 GB+ recommended for local GGUF model execution.
- **Disk**: 500 MB for runtime distribution bundle; additional storage as needed for local GGUF models (`./data/models/`).

### 1.2 Toolchain Matrix (Build Environment vs. Lean Runtime)

| Component | Build Environment (VPS / CI) | Lean Runtime VPS (Workflow B) |
|---|---|---|
| **C++ Compiler** | `g++` or `clang++` (C++17 support) | *Not Required* |
| **CMake** | `>= 3.14` | *Not Required* |
| **Node.js & npm** | Node.js `>= 18.x`, npm | *Not Required* |
| **POSIX Shell & Utilities** | `bash`, `tar`, `curl` | `bash`, `tar`, `curl` |

To install build prerequisites on a fresh Debian/Ubuntu host:
```bash
sudo apt-get update && sudo apt-get install -y build-essential cmake nodejs npm curl
```

---

## 2. Deployment Workflows

### Workflow A: Build from Source on VPS (Requires Dev Toolchain)
Use this workflow on a build server, CI runner, or development VPS:

```bash
# 1. Clone repository
git clone https://github.com/newomenabenz-bot/llama.cpp.git
cd llama.cpp

# 2. Execute the automated packaging pipeline
./scripts/package-workbench.sh

# 3. Enter assembled release directory
cd dist-release/llama-workbench

# 4. Configure environment
cp workbench.env.example workbench.env

# 5. Start the supervisor daemon
./scripts/workbench.sh start

# 6. Verify health
./scripts/workbench.sh status
./scripts/workbench.sh health
```

---

### Workflow B: Deploy Pre-Packaged Archive to Lean VPS (Zero Toolchain)
Use this workflow on production machines where compilers and Node.js should not be installed:

```bash
# 1. Transfer archive to target VPS and extract
tar -xzf llama-workbench-v0.1.0-linux-x86_64.tar.gz
cd llama-workbench

# 2. Configure production settings
cp workbench.env.example workbench.env
# Edit workbench.env if non-standard port or local model path is needed:
# nano workbench.env

# 3. Launch process supervisor
./scripts/workbench.sh start

# 4. Verify status
./scripts/workbench.sh status
```

---

## 3. Configuration Management (`workbench.env`)

All operational parameters are configured via `workbench.env` (loaded automatically by `scripts/workbench.sh`):

```bash
# Network & Server Configuration
WORKBENCH_HOST=127.0.0.1
WORKBENCH_PORT=8080

# Local Model Configuration (Optional: Leave blank if using cloud Gemini or remote APIs)
WORKBENCH_MODEL_PATH=

# Context & Hardware Allocation
WORKBENCH_CTX_SIZE=4096
WORKBENCH_N_THREADS=4
WORKBENCH_N_GPU_LAYERS=0

# Runtime Working Directory & Paths
WORKBENCH_DATA_DIR=./data
WORKBENCH_WORKSPACE_DIR=./data/workspace
WORKBENCH_LOG_FILE=./data/logs/workbench.log
WORKBENCH_PID_FILE=./data/workbench.pid

# Server API Protection (Optional: sets Bearer token for incoming requests to llama-server)
WORKBENCH_API_KEY=
```

> [!IMPORTANT]
> `workbench.env` is strictly git-ignored to prevent accidental credential commits. Never commit live `.env` files into source control.

---

## 4. Runtime Process Supervisor (`scripts/workbench.sh`)

The supervisor manages the full process lifecycle:

| Command | Description |
|---|---|
| `./scripts/workbench.sh start` | Spawns `llama-server` in background via `nohup`, writes PID, and polls `/health` for 30s |
| `./scripts/workbench.sh stop` | Gracefully stops the process via `SIGTERM` (15s timeout) with `SIGKILL` escalation |
| `./scripts/workbench.sh restart` | Executes a clean `stop` followed by `start` |
| `./scripts/workbench.sh status` | Inspects process PID, reports uptime, port, and live health status |
| `./scripts/workbench.sh health` | Sends HTTP probe to `http://${WORKBENCH_HOST}:${WORKBENCH_PORT}/health` |
| `./scripts/workbench.sh logs` | Tails the live server log: `tail -f -n 100 $WORKBENCH_LOG_FILE` |

---

## 5. Systemd Service Integration

To manage Llama Workbench as a persistent Linux service that restarts automatically across reboots:

Create `/etc/systemd/system/llama-workbench.service`:

```ini
[Unit]
Description=Llama Workbench Autonomous Agent IDE & Server
After=network.target

[Service]
Type=forking
User=ubuntu
Group=ubuntu
WorkingDirectory=/opt/llama-workbench
ExecStart=/opt/llama-workbench/scripts/workbench.sh start
ExecStop=/opt/llama-workbench/scripts/workbench.sh stop
PIDFile=/opt/llama-workbench/data/workbench.pid
Restart=on-failure
RestartSec=5s
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable llama-workbench
sudo systemctl start llama-workbench
sudo systemctl status llama-workbench
```

---

## 6. Nginx Reverse Proxy Configuration (with SSE Streaming)

When exposing Llama Workbench over public HTTPS, configure Nginx to disable proxy buffering so Server-Sent Events (SSE) streaming and real-time agent output render smoothly without delay:

```nginx
server {
    listen 80;
    server_name workbench.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name workbench.example.com;

    ssl_certificate     /etc/letsencrypt/live/workbench.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/workbench.example.com/privkey.pem;

    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # WebSocket & HTTP Upgrade
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard Forwarding Headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # CRITICAL FOR SSE & AGENT STREAMING:
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

---

## 7. Update & Controlled Maintenance Protocol

> [!NOTE]
> System updates require a brief, controlled maintenance restart (`stop` $\rightarrow$ `update` $\rightarrow$ `rebuild` $\rightarrow$ `start`). Zero-downtime hot reloading is not applicable because the Web UI and native tools are compiled directly into the binary.

```bash
# 1. Stop active instance
/opt/llama-workbench/scripts/workbench.sh stop

# 2. Update source tree
cd /opt/llama.cpp
git fetch origin master
git checkout master

# 3. Rebuild and package new distribution
./scripts/package-workbench.sh

# 4. Copy newly built binary and assets into runtime path
cp build-release/bin/llama-server /opt/llama-workbench/bin/llama-server
cp scripts/workbench.sh /opt/llama-workbench/scripts/workbench.sh

# 5. Restart instance
/opt/llama-workbench/scripts/workbench.sh start
```

---

## 8. Data Persistence Architecture

The following directories survive updates and restarts:

- **Host-Side Storage (`data/`)**:
  - `data/models/`: Retains downloaded `.gguf` weights.
  - `data/workspace/`: Retains files created, modified, or restored by autonomous tools.
  - `data/logs/`: Retains server execution logs (`workbench.log`).
- **Client-Side Storage (Browser)**:
  - **Dexie IndexedDB (`version(1)`)**: Retains conversation history, session checkpoints, and message trees.
  - **LocalStorage (`LlamaUi.workbench.*`)**: Retains execution modes (`SAFE`, `ASSISTED`, `AUTONOMOUS`), API provider keys (Gemini, OpenAI, Anthropic, DeepSeek), token budgets, and terminal history.
