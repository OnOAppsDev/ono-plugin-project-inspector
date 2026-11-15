#!/bin/sh
# check-bun.sh — Bun preflight for the Ono Project Inspector.
#
# Every Inspector helper is a TypeScript file executed with Bun. This check runs
# before any helper (and before anything is written) so a missing runtime stops
# the workflow with an actionable message instead of a bare "command not found"
# halfway through a stage.
#
# It never installs anything and never falls back to another runtime.
# POSIX sh on purpose: Bun cannot check for itself, and Claude Code runs its
# Bash tool through a POSIX shell on macOS, Linux and Windows (Git Bash).
#
# Usage:   sh "${CLAUDE_PLUGIN_ROOT}/scripts/check-bun.sh"
# Exit 0:  Bun found — prints "bun <version> (<path>)" on stdout.
# Exit 2:  Bun missing or not runnable — prints installation guidance on stderr.

missing() {
  cat >&2 <<'MSG'
BUN NOT FOUND — the Ono Project Inspector cannot run.

The Inspector's helper scripts require the Bun runtime (https://bun.sh).
Nothing was inspected and no project files were modified.

Install Bun, then open a new terminal / restart Claude Code and re-run the command:

  macOS / Linux / WSL:   curl -fsSL https://bun.sh/install | bash
  macOS (Homebrew):      brew install oven-sh/bun/bun
  Windows (PowerShell):  powershell -c "irm bun.sh/install.ps1 | iex"

Verify with:  bun --version

The Inspector does not install Bun for you and does not fall back to Node.js or
any other runtime.
MSG
  exit 2
}

BUN_PATH=$(command -v bun 2>/dev/null) || missing
[ -n "$BUN_PATH" ] || missing
BUN_VERSION=$(bun --version 2>/dev/null) || missing
[ -n "$BUN_VERSION" ] || missing

echo "bun $BUN_VERSION ($BUN_PATH)"
exit 0
