#!/bin/sh
# write-guard.sh — PreToolUse hook for Write|Edit|MultiEdit|NotebookEdit (0.11.3).
#
# Scope: ONLY calls made by the project-inspector agent. Claude Code puts
# `agent_type` into the hook input when a tool call comes from a subagent; the
# main session (the developer's own edits) and every other agent are allowed
# immediately, without starting Bun and without output.
#
# Identification is by that metadata only — never by file path or content:
#   - no top-level "agent_type" naming the Inspector  -> not a confirmed
#     Inspector call -> allow (exit 0). This includes malformed input in which
#     the metadata cannot be found: nothing is guessed.
#   - "agent_type" names the Inspector -> scripts/write-guard.ts decides from
#     the target's repository branch. Every outcome other than an explicit
#     allow (exit 0) is a DENY (exit 2): a protected branch, an undeterminable
#     branch, malformed input, a missing Bun, or a crash. A confirmed Inspector
#     call never fails open.
#
# Exit 2 blocks the tool call and shows stderr to the agent (documented
# PreToolUse behavior). This hook never asks the developer anything.

payload=$(cat)

# A real top-level key is an unescaped "agent_type"; inside JSON string values
# (file content) every quote is escaped as \", so content cannot forge it.
printf '%s' "$payload" | grep -Eq '(^|[^\\])"agent_type"[[:space:]]*:[[:space:]]*"[^"]*project-inspector"' || exit 0

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if ! command -v bun >/dev/null 2>&1; then
  echo "REFUSED: the Inspector write guard needs Bun to check the branch, and Bun is not on PATH. The write was blocked; nothing was written. Install Bun (see scripts/check-bun.sh) and re-run." >&2
  exit 2
fi

printf '%s' "$payload" | bun "$DIR/write-guard.ts"
status=$?
[ "$status" -eq 0 ] && exit 0
[ "$status" -eq 2 ] || echo "REFUSED: the Inspector write guard could not complete (exit $status), so the write was blocked; nothing was written." >&2
exit 2
