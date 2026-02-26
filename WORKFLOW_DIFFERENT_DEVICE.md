# Different-Device Git Workflow (Codex + GitHub)

This is a copy/paste-safe workflow for:

1) making changes
2) committing
3) pushing
4) getting back in sync with `origin/main`

It is based on what already worked in this repo (`work` branch with commits pushed to GitHub).

---

## 0) One-time checks per new device/session

```bash
cd /workspace/BremBot

# Verify this is a git repo and see current branch
git rev-parse --is-inside-work-tree && git branch --show-current

# Verify remote is connected
git remote -v

# If remote is missing, add it (replace URL if needed)
# git remote add origin https://github.com/<OWNER>/BremBot.git

# Confirm you can reach GitHub refs
git ls-remote --heads origin
```

If `git ls-remote` works, remote connectivity + auth are usually good.

---

## 1) Start work safely (always sync first)

```bash
cd /workspace/BremBot

# Fetch latest refs from GitHub
git fetch origin

# Switch to your working branch (example used in this repo: work)
git checkout work

# Rebase your branch on latest main to reduce merge pain
git rebase origin/main
```

If rebase conflicts:

```bash
# resolve files, then
git add <resolved-files>
git rebase --continue
# or abort if needed:
# git rebase --abort
```

---

## 2) Make changes + test

```bash
cd /workspace/BremBot

# (edit files)

# See what changed
git status --short

# Example app check for this repo
cd crypto-signal-dashboard
npm install
npm run build
cd ..
```

---

## 3) Commit (always commit uncommitted changes before switching devices)

```bash
cd /workspace/BremBot

# Stage what you changed
git add -A

# Commit
# Use a clear message tied to the fix
git commit -m "Describe the change clearly"
```

If there are no staged changes, git will tell you and skip the commit.

---

## 4) Push your branch

```bash
cd /workspace/BremBot

# First push on a new branch: set upstream
git push -u origin work

# Later pushes:
# git push
```

If rejected (non-fast-forward):

```bash
git fetch origin
git rebase origin/work
git push
```

---

## 5) Merge with origin/main (PR-first recommended)

Recommended:

1. Push branch (`work`).
2. Open/refresh PR into `main`.
3. Merge PR on GitHub.

Then sync local after merge:

```bash
cd /workspace/BremBot
git fetch origin
git checkout main
git pull --ff-only origin main

# Optional: bring your work branch up to date after merge
git checkout work
git rebase origin/main
```

---


## One-command helper script

Use the helper script to run the safe flow in one command:

```bash
cd /workspace/BremBot
scripts/safe-sync-and-push.sh -m "your commit message"
```

Optional flags:

```bash
# Skip frontend build check
scripts/safe-sync-and-push.sh -m "your commit message" --skip-build

# Rebase on a different base ref
scripts/safe-sync-and-push.sh -m "your commit message" --base origin/main
```

The script validates origin connectivity, fetches/rebases, runs build (unless skipped), stages all changes, commits if needed, then pushes the current branch.

---

## Fast “pre-push sanity” block (copy/paste)

```bash
cd /workspace/BremBot && \
git fetch origin && \
git remote -v && \
git branch --show-current && \
git status --short && \
(cd crypto-signal-dashboard && npm run build)
```

If that passes, do:

```bash
cd /workspace/BremBot
git add -A
git commit -m "your message"
git push -u origin "$(git branch --show-current)"
```

---

## Troubleshooting quick hits

- **`npm ci` lockfile mismatch**: run `npm install`, commit updated `package-lock.json`, push.
- **`next: not found`**: dependencies not installed in current environment; run `npm install` in `crypto-signal-dashboard`.
- **Auth/remote issues**: re-check `git remote -v` and `git ls-remote --heads origin`.

