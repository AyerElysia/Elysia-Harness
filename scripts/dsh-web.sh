#!/usr/bin/env bash
# Boot the web surface against this repository's own harness home.
#
# Each surface gets its own home: they mount different bundle sets and keep
# separate session histories. Both read this machine's model providers through
# homes/shared, which the home-level patch layer applies over every profile.
#
# DSH_HOME is bootstrap-only — app-boot refuses a DSH_* name from any discovered
# .env — so this script is the one place that sets it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The system node is 18; DSH requires ^22.19.
export PATH="$HOME/.local/share/node-v22/bin:$PATH"
export DSH_HOME="$ROOT/homes/web"
export DSH_AGENTS_HOME="$ROOT/homes/web/agents"

# KOOK channel: the bot account still comes from Elysium's existing adapter
# config. Since 2026-10-23 the Python kook_adapter is disabled, and KOOK is
# handed to ElyHarn: the gateway listens by default. One token keeps one
# socket — running several surfaces, start the others with ELYSIA_KOOK_LISTEN=0.
export ELYSIA_KOOK_CONFIG="${ELYSIA_KOOK_CONFIG:-$ROOT/../config/plugins/kook_adapter/config.toml}"
export ELYSIA_KOOK_LISTEN="${ELYSIA_KOOK_LISTEN:-1}"

# Livestream environment defaults. The upstream plugin keeps room and response
# state in its local settings. The stage stays on loopback; the desktop connects
# through a local SSH forward.
export ELYSIA_LIVE_ROOM="${ELYSIA_LIVE_ROOM:-31581575}"
export ELYSIA_STAGE_PORT="${ELYSIA_STAGE_PORT:-3300}"
export ELYSIA_STAGE_HOST="${ELYSIA_STAGE_HOST:-127.0.0.1}"

# Ayla channel: the plugin dials this backend and opens no port of its own.
# The mounted channel stays idle until its configured credentials are complete.
export AYLA_BASE_URL="${AYLA_BASE_URL:-http://127.0.0.1:8100}"
export AYLA_BOT_USER="${AYLA_BOT_USER:-elysia}"
# Credentials live outside Git: a local env file read only when it exists.
if [ -f "$ROOT/../.env.ayla" ]; then set -a; . "$ROOT/../.env.ayla"; set +a; fi
export AYLA_BOT_PASSWORD="${AYLA_BOT_PASSWORD:-}"

# The /api browser-trust fence accepts only the authority the page was served
# from. A Cloudflare quick tunnel reaches this server under its own hostname,
# so that hostname must be named here or every /api call from a tunneled page
# is refused (the plugin market shows "不受信任的地址" / untrusted origin).
#
# DSH_REMOTE_PUBLIC_URL overrides the existing public origin for this deployment.
PUBLIC_URL="${DSH_REMOTE_PUBLIC_URL:-https://climb-writing-bidder-here.trycloudflare.com}"
TRUSTED_ARGS=()
if [[ -n "$PUBLIC_URL" ]]; then
  HOST="${PUBLIC_URL#https://}"
  HOST="${HOST#http://}"
  HOST="${HOST%%/*}"
  TRUSTED_ARGS+=(--trusted-host "$HOST")
fi
TRUSTED_ARGS+=(--trusted-host 127.0.0.1:3299)
TRUSTED_ARGS+=(--trusted-host localhost:3299)

cd "$ROOT/dsh"
exec node_modules/.bin/tsx apps/cli/src/bin.ts --profile web "${TRUSTED_ARGS[@]}" "$@"
