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

# The /api browser-trust fence accepts only the authority the page was served
# from. A Cloudflare quick tunnel reaches this server under its own hostname,
# so that hostname must be named here or every /api call from a tunneled page
# is refused (the plugin market shows "不受信任的地址" / untrusted origin).
#
# Set DSH_REMOTE_PUBLIC_URL to the externally served origin on this host.
PUBLIC_URL="${DSH_REMOTE_PUBLIC_URL:-}"
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
