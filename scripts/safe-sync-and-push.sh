#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/safe-sync-and-push.sh -m "commit message" [--skip-build] [--base origin/main]

What it does:
  1) Verifies git repo + origin connectivity
  2) Fetches latest refs
  3) Rebases current branch on base branch (default: origin/main)
  4) Optionally runs frontend build (crypto-signal-dashboard)
  5) Stages all changes, commits (if there are changes), and pushes current branch

Notes:
  - If there are no file changes, commit step is skipped.
  - First push for a branch sets upstream automatically.
  - For HTTPS remotes in non-interactive environments, set GITHUB_TOKEN to enable authenticated git operations.
USAGE
}

COMMIT_MSG=""
SKIP_BUILD=0
BASE_REF="origin/main"

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

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
GIT_AUTH_ARGS=()
if [[ -n "${GITHUB_TOKEN:-}" && "$ORIGIN_URL" =~ ^https:// ]]; then
  AUTH_B64="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
  GIT_AUTH_ARGS=(-c "http.extraheader=AUTHORIZATION: basic $AUTH_B64")
fi

git_auth() {
  git "${GIT_AUTH_ARGS[@]}" "$@"
}

echo "==> Repo: $REPO_ROOT"
echo "==> Branch: $CURRENT_BRANCH"
echo "==> Base ref: $BASE_REF"

echo "==> Checking origin remote"
git remote get-url origin >/dev/null

echo "==> Checking origin connectivity"
git_auth ls-remote --heads origin >/dev/null

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

echo "==> Pushing branch"
if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  git_auth push
else
  git_auth push -u origin "$CURRENT_BRANCH"
fi

echo "==> Done"
