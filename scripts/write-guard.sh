#!/bin/sh
# write-guard.sh — PreToolUse hook for Write|Edit|MultiEdit|NotebookEdit (0.11.3; Node.js since 0.12.0).
#
# Scope: ONLY calls made by the project-inspector agent. Claude Code puts
# `agent_type` into the hook input when a tool call comes from a subagent; the
# main session (the developer's own edits) and every other agent are allowed
# immediately, without starting Node.js and without output.
#
# Identification is by that metadata only — never by file path or content:
#   - no top-level "agent_type" naming the Inspector  -> not a confirmed
#     Inspector call -> allow (exit 0). This includes malformed input in which
#     the metadata cannot be found: nothing is guessed.
#   - "agent_type" names the Inspector -> scripts/write-guard.ts decides from
#     the target's repository branch.
#
# Authorization of an Inspector call is EXPLICIT: the write is allowed only when
# write-guard.ts exits 0 AND its stdout is exactly the ALLOW response line
# (ONO-INSPECTOR-WRITE-GUARD:ALLOW plus one newline), byte for byte. Anything
# else is a DENY (exit 2): a protected or undeterminable branch, malformed
# input, Node.js missing or unsupported or unable to start, the helper missing
# or failing to load or parse, a helper that exits 0 silently, extra or
# different output, or a crash. A confirmed Inspector call never fails open.
#
# Exit 2 blocks the tool call and shows stderr to the agent (documented
# PreToolUse behavior). This hook never asks the developer anything.
#
# Portability (macOS, Linux, Windows Git Bash): the helper path is derived from
# this script's own path as given by hooks.json ("${CLAUDE_PLUGIN_ROOT}/scripts/
# write-guard.sh"), without `cd`/`pwd`, so a Windows-native plugin path such as
# C:\Users\…\scripts reaches node.exe unchanged and nothing relies on MSYS path
# conversion. Every path is quoted. Keep this file LF-only (.gitattributes).

ALLOW_RESPONSE='ONO-INSPECTOR-WRITE-GUARD:ALLOW'

payload=$(cat)

# A real top-level key is an unescaped "agent_type"; inside JSON string values
# (file content) every quote is escaped as \", so content cannot forge it.
printf '%s' "$payload" | grep -Eq '(^|[^\\])"agent_type"[[:space:]]*:[[:space:]]*"[^"]*project-inspector"' || exit 0

deny() {
  echo "REFUSED: $1 The write was blocked; nothing was written." >&2
  exit 2
}

GUARD="$(dirname -- "$0")/write-guard.ts"

command -v node >/dev/null 2>&1 \
  || deny "the Inspector write guard needs Node.js (22.18+ on Node 22, or 24+) to check the branch, and node is not on PATH. See README § Requirements."
[ -f "$GUARD" ] || deny "the Inspector write guard helper is missing ($GUARD)."

# The trailing '.' keeps every newline of the helper's stdout (command
# substitution strips trailing newlines); the helper's exit status is carried out.
out=$(printf '%s' "$payload" | node --no-warnings "$GUARD"; status=$?; printf '.'; exit "$status")
status=$?

expected="$ALLOW_RESPONSE
."
if [ "$status" -eq 0 ] && [ "$out" = "$expected" ]; then
  exit 0
fi
[ "$status" -eq 2 ] && exit 2
if [ "$status" -eq 0 ]; then
  deny "the Inspector write guard exited 0 without the explicit ALLOW response, so the write is not authorized."
fi
deny "the Inspector write guard could not complete (exit $status), so the write is not authorized."
