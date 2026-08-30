---
description: Using GitHub CLI (gh) for PRs, issues, and API calls. Use when interacting with GitHub.
---

# GitHub CLI Usage

## Remote URL Workaround

The git remote may point to a local proxy (`http://127.0.0.1:…/git/…`) instead of GitHub directly. When this happens, `gh` commands like `gh pr create` fail with:

> none of the git remotes configured for this repository point to a known GitHub host

### Fix: Temporarily swap the remote URL

```bash
# Save current remote and switch to GitHub
ORIG_REMOTE=$(git remote get-url origin)
git remote set-url origin https://github.com/megane-labs/megane.git

# Run gh commands
gh pr create --base main --title "..." --body "..."

# Restore original remote
git remote set-url origin "$ORIG_REMOTE"
```

Always restore the original remote URL after the `gh` command completes.

## Authentication

A `GITHUB_TOKEN` is set in the environment. No additional auth setup is needed.
