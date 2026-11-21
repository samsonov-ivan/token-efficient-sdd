#!/bin/sh
# Run the pinned WP-00 one-step model on an Apple Silicon machine.
set -eu
: "${FRUGAL_MOCK_SUMMARY:?Set this to the successful mock probe summary.json}"
: "${FRUGAL_MLX_ENV:?Set this to the isolated MLX virtual environment}"
: "${FRUGAL_MODEL_SNAPSHOT:?Set this to the SmolLM2-360M-Instruct snapshot directory}"
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
model_dir=$(CDPATH= cd -- "$FRUGAL_MODEL_SNAPSHOT" && pwd -P)
runtime=$(CDPATH= cd -- "$FRUGAL_MLX_ENV" && pwd -P)
revision=a10cc1512eabd3dde888204e902eca88bddb4951
expected_weights=e6bffe7435d7ddc10fd3b9a9efd429dafbacb1cb17015fb5562664e7532bf86e
test "$(basename "$model_dir")" = "$revision" || { echo 'Model snapshot revision mismatch' >&2; exit 1; }
test "$(shasum -a 256 "$model_dir/model.safetensors" | cut -d ' ' -f 1)" = "$expected_weights" || { echo 'Model weights checksum mismatch' >&2; exit 1; }
"$runtime/bin/python" -c 'from importlib.metadata import version; assert version("mlx-lm") == "0.32.2" and version("mlx") == "0.32.4"'
server_dir=$(mktemp -d "${TMPDIR:-/tmp}/frugal-mlx.XXXXXX")
ln -s "$model_dir" "$server_dir/SmolLM2-360M-Instruct"
cd "$server_dir"
port=$("$runtime/bin/python" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
HF_HUB_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1 "$runtime/bin/mlx_lm.server" --model SmolLM2-360M-Instruct --host 127.0.0.1 --port "$port" --max-tokens 32 > server.log 2>&1 &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true' EXIT
trap 'exit 130' INT TERM
echo "MLX log: $server_dir/server.log"
attempt=0
until curl --noproxy '*' --silent --fail --max-time 2 "http://127.0.0.1:$port/v1/models" > /dev/null; do
  kill -0 "$server_pid" 2>/dev/null || { cat server.log >&2; exit 1; }
  attempt=$((attempt+1))
  test "$attempt" -lt 45 || { echo 'MLX startup timed out' >&2; exit 1; }
  sleep 1
done
cd "$repo_root"
FRUGAL_MLX_SERVER_LOG="$server_dir/server.log" FRUGAL_LOCAL_BASE_URL="http://127.0.0.1:$port/v1" node scripts/probe-opencode.mjs live-local
