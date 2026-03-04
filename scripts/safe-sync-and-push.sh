#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/safe-sync-and-push.sh -m "commit message" [--skip-build] [--base origin/main] [--origin-url <url>]

What it does:
  1) Verifies git repo + origin connectivity
  2) Fetches latest refs
  3) Rebases current branch on base branch (default: origin/main)
  4) Optionally runs frontend build (crypto-signal-dashboard)
  5) Stages all changes, commits (if there are changes), and pushes current branch

Notes:
  - If there are no file changes, commit step is skipped.
  - First push for a branch sets upstream automatically.
  - If origin is missing, it is auto-added using --origin-url or repo default.
USAGE
}

COMMIT_MSG=""
SKIP_BUILD=0
BASE_REF="origin/main"
DEFAULT_ORIGIN_URL="https://github.com/brownempire/BremBot.git"
ORIGIN_URL="$DEFAULT_ORIGIN_URL"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      COMMIT_MSG="${2:-}"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --base)
      BASE_REF="${2:-}"
      shift 2
      ;;
    --origin-url)
      ORIGIN_URL="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$COMMIT_MSG" ]]; then
  echo "Error: commit message is required via -m/--message" >&2
  usage
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "Error: not inside a git repository." >&2
  exit 1
fi

cd "$REPO_ROOT"

CURRENT_BRANCH="$(git branch --show-current)"
if [[ -z "$CURRENT_BRANCH" ]]; then
  echo "Error: detached HEAD detected. Checkout a branch first." >&2
  exit 1
fi

git_auth() {
  git "$@"
}

ssh_to_https() {
  local url="$1"
  if [[ "$url" =~ ^git@github.com:(.+)$ ]]; then
    echo "https://github.com/${BASH_REMATCH[1]}"
    return 0
  fi
  if [[ "$url" =~ ^ssh://git@github.com/(.+)$ ]]; then
    echo "https://github.com/${BASH_REMATCH[1]}"
    return 0
  fi
  echo "$url"
}

ensure_origin() {
  if git remote get-url origin >/dev/null 2>&1; then
    return 0
  fi

  echo "==> origin remote missing; adding origin -> $ORIGIN_URL"
  git remote add origin "$ORIGIN_URL"
}

check_and_fix_connectivity() {
  local current_url
  current_url="$(git remote get-url origin)"

  echo "==> Checking origin connectivity ($current_url)"
  if git_auth ls-remote --heads origin >/dev/null 2>&1; then
    return 0
  fi

  local fallback_url
  fallback_url="$(ssh_to_https "$current_url")"

  if [[ "$fallback_url" == "$current_url" ]]; then
    echo "Error: cannot connect to origin using current URL: $current_url" >&2
    return 1
  fi

  echo "==> SSH connectivity failed; trying HTTPS fallback: $fallback_url"
  git remote set-url origin "$fallback_url"

  if git_auth ls-remote --heads origin >/dev/null 2>&1; then
    echo "==> HTTPS connectivity established"
    return 0
  fi

  echo "Error: connectivity failed for both SSH and HTTPS origin URLs." >&2
  return 1
}

ensure_origin

echo "==> Repo: $REPO_ROOT"
echo "==> Branch: $CURRENT_BRANCH"
echo "==> Base ref: $BASE_REF"
echo "==> Origin: $(git remote get-url origin)"

check_and_fix_connectivity

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes. Commit or stash before running sync/rebase." >&2
  exit 1
fi

echo "==> Fetching latest refs"
git_auth fetch origin

echo "==> Rebasing $CURRENT_BRANCH onto $BASE_REF"
git rebase "$BASE_REF"

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  if [[ -d "$REPO_ROOT/crypto-signal-dashboard" ]]; then
    echo "==> Running frontend build check"
    (
      cd "$REPO_ROOT/crypto-signal-dashboard"
      npm run build
    )
  else
    echo "==> Skipping build check (crypto-signal-dashboard not found)"
  fi
else
  echo "==> Build check skipped by flag"
fi

echo "==> Staging changes"
git add -A

if git diff --cached --quiet; then
  echo "==> No changes to commit"
else
  echo "==> Creating commit"
  git commit -m "$COMMIT_MSG"
fi

echo "==> Verifying push authentication"
if ! git_auth push --dry-run >/dev/null 2>&1; then
  echo "Error: push auth failed for origin ($(git remote get-url origin))." >&2
  echo "Tip: configure credentials on this device (SSH key or HTTPS credential helper/PAT), then rerun." >&2
  exit 1
fi

echo "==> Pushing branch"
if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  git_auth push
else
  git_auth push -u origin "$CURRENT_BRANCH"
fi

echo "==> Done"
