# BremBot Command Reference (Git + App Workflow)

A practical, saveable reference for daily use on branch-based development across devices.

## 1) Daily Git health check (refresh + verify)

```bash
git status -sb
git branch -vv
git remote -v
git fetch --all --prune
git log --oneline --decorate --graph -20
```

### Check what is unsynced

```bash
# local commits not pushed (replace <branch>)
git log --oneline origin/<branch>..HEAD

# remote commits not pulled
git log --oneline HEAD..origin/<branch>
```

### Upstream tracking check

```bash
git rev-parse --abbrev-ref --symbolic-full-name @{u}
```

If no upstream exists, set one once:

```bash
git push -u origin <branch>
```

---

## 2) Cross-device rule (always commit uncommitted changes)

Before leaving one device or switching to another:

```bash
git status --porcelain
git add -A
git commit -m "WIP: <short context>"
git push
```

If upstream is missing:

```bash
git push -u origin <branch>
```

---

## 3) Branch operations

```bash
# switch to existing branch
git switch <branch>

# create + switch
git switch -c <new-branch>

# branch lists
git branch
git branch -a
```

---

## 4) Sync operations

```bash
# rebase-based pull
git pull --rebase

# publish local commits
git push
```

---

## 5) App setup/run/verify commands (crypto-signal-dashboard)

Run these from `crypto-signal-dashboard/`:

```bash
npm install
cp .env.local.example .env.local
npm run dev
npm run lint
npm run build
npm run start
```

Push notification setup (optional):

```bash
npx web-push generate-vapid-keys
```

---

## 6) Quick routines

### Start of day

```bash
git status -sb
git fetch --all --prune
git branch -vv
git pull --rebase
```

### Before coding

```bash
git switch <your-branch>
git status -sb
```

### Before ending session / changing device

```bash
git status --porcelain
git add -A
git commit -m "WIP: checkpoint"
git push
```

### Before opening PR

```bash
git fetch --all --prune
git log --oneline --decorate --graph -20
git status -sb
```

---

## 7) Notes for this repo

- This repository currently defines app scripts: `dev`, `build`, `start`, `lint`.
- There are no custom Makefile or `.sh` task runners currently present.
