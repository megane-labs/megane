#!/bin/bash
set -euo pipefail

# Shared SessionStart hook for every coding agent that supports lifecycle
# hooks. Wired up from:
#   - Claude Code: .claude/settings.json  (command: $CLAUDE_PROJECT_DIR/.agents/hooks/session-start.sh)
#   - Codex CLI:   .codex/hooks.json      (command: "$(git rev-parse --show-toplevel)/.agents/hooks/session-start.sh")
#
# Both tools read the same JSON contract on stdout: `hookSpecificOutput.additionalContext`
# is injected into the first turn so the agent reliably applies AGENTS.md and
# verifies the project skills before starting any work. Keep this file free of
# tool-specific paths; AGENTS.md documents the layout.
cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "## Megane project bootstrap (MANDATORY)\n\nBefore producing your first response to the user, you MUST:\n\n1. Re-read the CRITICAL RULES section of AGENTS.md (Claude Code loads it through CLAUDE.md, which imports it) and follow them strictly. They are the authoritative list; do not paraphrase or substitute remembered rules.\n2. Confirm that the 11 Megane skills are loaded (`commit`, `github-cli`, `dev-setup`, `build`, `testing`, `e2e-coverage`, `preview`, `pre-release`, `post-release`, `add-format`, `add-node`). In Claude Code check the `available skills` section of the system reminder; in Codex run `/skills`. If any are missing, warn the user and suggest checking `.agents/skills/` (Claude Code reads it through the `.claude/skills` symlink).\n\nDo not skip these steps even on resumed/compacted sessions."
  }
}
JSON
