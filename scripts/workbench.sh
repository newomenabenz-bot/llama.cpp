#!/usr/bin/env bash
# ==============================================================================
# Llama Workbench Runtime Lifecycle Supervisor (POSIX Bash)
# Manages start, stop, restart, status, health, and logs for llama-server.
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Resolve relative paths against APP_ROOT
resolve_path() {
	local p="$1"
	if [[ "$p" == ./* ]]; then
		echo "$APP_ROOT/${p#./}"
	else
		echo "$p"
	fi
}

# 1. Load Environment Configuration
ENV_FILE="$APP_ROOT/workbench.env"
EXAMPLE_ENV="$APP_ROOT/workbench.env.example"

if [ ! -f "$ENV_FILE" ] && [ -f "$EXAMPLE_ENV" ]; then
	cp "$EXAMPLE_ENV" "$ENV_FILE"
	echo "[INFO] No workbench.env found; created default configuration from template."
fi

if [ -f "$ENV_FILE" ]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
elif [ -f "$EXAMPLE_ENV" ]; then
	set -a
	# shellcheck disable=SC1090
	source "$EXAMPLE_ENV"
	set +a
fi

# 2. Configuration Defaults
WORKBENCH_HOST="${WORKBENCH_HOST:-0.0.0.0}"
WORKBENCH_PORT="${WORKBENCH_PORT:-8080}"
WORKBENCH_CORS_ORIGINS="${WORKBENCH_CORS_ORIGINS:-*}"
WORKBENCH_MODEL_PATH="${WORKBENCH_MODEL_PATH:-}"
WORKBENCH_CTX_SIZE="${WORKBENCH_CTX_SIZE:-4096}"
WORKBENCH_N_THREADS="${WORKBENCH_N_THREADS:-4}"
WORKBENCH_N_GPU_LAYERS="${WORKBENCH_N_GPU_LAYERS:-0}"
WORKBENCH_PUBLIC_DIR="$(resolve_path "${WORKBENCH_PUBLIC_DIR:-$APP_ROOT/public}")"
WORKBENCH_DATA_DIR="$(resolve_path "${WORKBENCH_DATA_DIR:-$APP_ROOT/data}")"
WORKBENCH_WORKSPACE_DIR="$(resolve_path "${WORKBENCH_WORKSPACE_DIR:-/home/ubuntu}")"
WORKBENCH_LOG_FILE="$(resolve_path "${WORKBENCH_LOG_FILE:-$APP_ROOT/data/logs/workbench.log}")"
WORKBENCH_PID_FILE="$(resolve_path "${WORKBENCH_PID_FILE:-$APP_ROOT/data/workbench.pid}")"
WORKBENCH_API_KEY="${WORKBENCH_API_KEY:-}"
WORKBENCH_ENABLE_TOOLS="${WORKBENCH_ENABLE_TOOLS:-all}"

SERVER_BIN="$APP_ROOT/bin/llama-server"

check_port_in_use() {
	local port="$1"
	if command -v ss >/dev/null 2>&1; then
		ss -tuln 2>/dev/null | grep -qE "[:.]${port}\b" && return 0
	elif command -v netstat >/dev/null 2>&1; then
		netstat -tuln 2>/dev/null | grep -qE "[:.]${port}\b" && return 0
	elif command -v lsof >/dev/null 2>&1; then
		lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 0
	elif (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
		exec 3<&-
		exec 3>&-
		return 0
	fi
	return 1
}

ensure_directories() {
	mkdir -p "$WORKBENCH_DATA_DIR" \
		"$(dirname "$WORKBENCH_LOG_FILE")" \
		"$(dirname "$WORKBENCH_PID_FILE")"
	if [ -n "$WORKBENCH_WORKSPACE_DIR" ]; then
		mkdir -p "$WORKBENCH_WORKSPACE_DIR" 2>/dev/null || true
	fi
}

is_running() {
	if [ -f "$WORKBENCH_PID_FILE" ]; then
		local pid
		pid=$(cat "$WORKBENCH_PID_FILE" 2>/dev/null || echo "")
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			return 0
		fi
	fi
	return 1
}

do_start() {
	ensure_directories

	if is_running; then
		local pid
		pid=$(cat "$WORKBENCH_PID_FILE")
		echo "[INFO] Llama Workbench is already running (PID: $pid)."
		exit 0
	fi

	# Pre-flight Port Check
	if check_port_in_use "$WORKBENCH_PORT"; then
		echo "[ERROR] Port $WORKBENCH_PORT is already in use by another process." >&2
		exit 1
	fi

	if [ ! -x "$SERVER_BIN" ]; then
		echo "[ERROR] Binary not found or not executable: $SERVER_BIN"
		exit 1
	fi

	local args=(
		--host "$WORKBENCH_HOST"
		--port "$WORKBENCH_PORT"
		--cors-origins "${WORKBENCH_CORS_ORIGINS:-*}"
		--ctx-size "$WORKBENCH_CTX_SIZE"
		--threads "$WORKBENCH_N_THREADS"
	)

	if [ -n "$WORKBENCH_MODEL_PATH" ] && [ -f "$WORKBENCH_MODEL_PATH" ]; then
		args+=(
			-m "$WORKBENCH_MODEL_PATH"
			--n-gpu-layers "$WORKBENCH_N_GPU_LAYERS"
		)
	fi

	# Static Web UI document root (replaces conflicting workspace --path usage)
	if [ -n "$WORKBENCH_PUBLIC_DIR" ] && [ -d "$WORKBENCH_PUBLIC_DIR" ]; then
		args+=(--path "$WORKBENCH_PUBLIC_DIR")
	fi

	if [ -n "$WORKBENCH_API_KEY" ]; then
		args+=(--api-key "$WORKBENCH_API_KEY")
	fi

	# Native Tool Engine & Jinja Tool Calling Support (DEF-QA-001)
	args+=(--tools "${WORKBENCH_ENABLE_TOOLS:-all}" --jinja)

	echo "[INFO] Starting Llama Workbench on http://${WORKBENCH_HOST}:${WORKBENCH_PORT}..."

	# Permanently root workspace execution to /home/ubuntu (DIR-ROOT-WORKSPACE-17)
	local run_workspace="${WORKBENCH_WORKSPACE_DIR:-/home/ubuntu}"
	if [ -d "$run_workspace" ]; then
		cd "$run_workspace"
	else
		mkdir -p "$run_workspace" 2>/dev/null || true
		cd "$run_workspace" 2>/dev/null || cd /home/ubuntu 2>/dev/null || true
	fi
	echo "[INFO] Workbench process working directory rooted at: $(pwd)"

	nohup "$SERVER_BIN" "${args[@]}" >> "$WORKBENCH_LOG_FILE" 2>&1 &
	local pid=$!
	echo "$pid" > "$WORKBENCH_PID_FILE"

	# Poll health endpoint up to 30 seconds
	echo -n "[INFO] Waiting for server health endpoint"
	local healthy=false
	local check_host="$WORKBENCH_HOST"
	if [ "$check_host" = "0.0.0.0" ]; then
		check_host="127.0.0.1"
	fi
	for _ in $(seq 1 30); do
		if curl -s -f -m 2 "http://${check_host}:${WORKBENCH_PORT}/health" >/dev/null 2>&1; then
			healthy=true
			break
		fi
		if ! kill -0 "$pid" 2>/dev/null; then
			echo ""
			echo "[ERROR] llama-server (PID: $pid) terminated unexpectedly."
			tail -n 25 "$WORKBENCH_LOG_FILE" || true
			rm -f "$WORKBENCH_PID_FILE"
			exit 1
		fi
		echo -n "."
		sleep 1
	done

	echo ""
	if [ "$healthy" = true ]; then
		echo "[OK] Llama Workbench is running (PID: $pid) at http://${WORKBENCH_HOST}:${WORKBENCH_PORT}"
	else
		echo "[ERROR] Health check timed out after 30 seconds."
		echo "--- Tail of $WORKBENCH_LOG_FILE ---"
		tail -n 25 "$WORKBENCH_LOG_FILE" || true
		exit 1
	fi
}

do_stop() {
	if [ ! -f "$WORKBENCH_PID_FILE" ]; then
		echo "[INFO] No PID file found at $WORKBENCH_PID_FILE. Server is not running."
		return 0
	fi

	local pid
	pid=$(cat "$WORKBENCH_PID_FILE" 2>/dev/null || echo "")

	if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
		echo "[INFO] Process $pid is not active. Cleaning up stale PID file."
		rm -f "$WORKBENCH_PID_FILE"
		return 0
	fi

	echo "[INFO] Stopping Llama Workbench (PID: $pid)..."
	kill -15 "$pid" 2>/dev/null || true

	local stopped=false
	for _ in $(seq 1 15); do
		if ! kill -0 "$pid" 2>/dev/null; then
			stopped=true
			break
		fi
		sleep 1
	done

	if [ "$stopped" = false ]; then
		echo "[WARNING] Server did not stop gracefully within 15s. Escalating to SIGKILL..."
		kill -9 "$pid" 2>/dev/null || true
		sleep 1
	fi

	rm -f "$WORKBENCH_PID_FILE"
	echo "[OK] Llama Workbench stopped."
}

do_status() {
	if is_running; then
		local pid
		pid=$(cat "$WORKBENCH_PID_FILE")
		echo "[STATUS] RUNNING"
		echo "  PID:       $pid"
		echo "  Endpoint:  http://${WORKBENCH_HOST}:${WORKBENCH_PORT}"
		echo "  Workspace: $WORKBENCH_WORKSPACE_DIR"
		echo "  Logs:      $WORKBENCH_LOG_FILE"
		local check_host="$WORKBENCH_HOST"
		if [ "$check_host" = "0.0.0.0" ]; then
			check_host="127.0.0.1"
		fi
		if curl -s -f -m 2 "http://${check_host}:${WORKBENCH_PORT}/health" >/dev/null 2>&1; then
			echo "  Health:    OK (200)"
		else
			echo "  Health:    Degraded or Not Responding"
		fi
	else
		echo "[STATUS] STOPPED"
	fi
}

do_health() {
	local check_host="$WORKBENCH_HOST"
	if [ "$check_host" = "0.0.0.0" ]; then
		check_host="127.0.0.1"
	fi
	echo "Querying http://${check_host}:${WORKBENCH_PORT}/health..."
	curl -s -i "http://${check_host}:${WORKBENCH_PORT}/health" || {
		echo ""
		echo "[ERROR] Unable to reach http://${check_host}:${WORKBENCH_PORT}/health"
		exit 1
	}
	echo ""
}

do_logs() {
	if [ ! -f "$WORKBENCH_LOG_FILE" ]; then
		echo "[INFO] Log file does not exist yet: $WORKBENCH_LOG_FILE"
		exit 0
	fi
	tail -f -n 100 "$WORKBENCH_LOG_FILE"
}

# Subcommand Dispatch
ACTION="${1:-help}"

case "$ACTION" in
	start)
		do_start
		;;
	stop)
		do_stop
		;;
	restart)
		do_stop
		sleep 1
		do_start
		;;
	status)
		do_status
		;;
	health)
		do_health
		;;
	logs)
		do_logs
		;;
	*)
		echo "Usage: $0 {start|stop|restart|status|health|logs}"
		exit 1
		;;
esac
