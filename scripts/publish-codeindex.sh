#!/usr/bin/env bash
#
# Publishes a codeindex snapshot for a repository and copies the output into
# src/codemcp/data/ so codemcp can serve it.
#
# Workflow:
#   1. Prompt for the branch name (defaults to the current git branch).
#   2. Prompt for the absolute path of the repository to index
#      (defaults to this sandbox repo root). Passed as --root to the CLI.
#   3. Resolve the current HEAD SHA of the target repo and remove only that
#      SHA's folder from src/codeindex/data/commits/ and
#      src/codemcp/data/commits/ (leaves all other repos' folders intact).
#   4. Run: node src/codeindex/dist/cli.js --backend file --branch <branch> --root <path> publish
#      (--root sets what is indexed; git origin of that repo is used as the repository id)
#   5. Copy src/codeindex/data/. into src/codemcp/data/
#
# Usage:
#   scripts/publish-codeindex.sh [-b <branch>] [-r <repository>]
#
# Examples:
#   scripts/publish-codeindex.sh
#   scripts/publish-codeindex.sh -b main -r /home/me/repos/xpo-messaging-backend

set -euo pipefail

BRANCH=""
REPOSITORY=""

# Accept short (-b/-r) and PowerShell-style long (-Branch/-Repository) flags,
# case-insensitively, with either "-b value" or "-b=value" forms.
while [ $# -gt 0 ]; do
    arg="$1"
    val="${arg#*=}"
    [ "$val" = "$arg" ] && val=""   # no "=value" present
    key="${arg%%=*}"
    lkey="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
    case "$lkey" in
        -b|-branch)
            if [ -n "$val" ]; then BRANCH="$val"; else BRANCH="$2"; shift; fi
            ;;
        -r|-repository)
            if [ -n "$val" ]; then REPOSITORY="$val"; else REPOSITORY="$2"; shift; fi
            ;;
        -h|-help|--help)
            grep '^#' "$0" | sed 's/^#//; s/^!.*//'
            exit 0
            ;;
        *)
            echo "Unknown option: $key" >&2
            exit 1
            ;;
    esac
    shift
done

write_step() {
    # Cyan, matching the PowerShell Write-Step.
    printf '\033[36m==> %s\033[0m\n' "$1"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_PATH="$REPO_ROOT/src/codeindex/dist/cli.js"
CODEINDEX_DATA="$REPO_ROOT/src/codeindex/data"
CODEMCP_DATA="$REPO_ROOT/src/codemcp/data"

if [ ! -f "$CLI_PATH" ]; then
    echo "codeindex CLI not found at $CLI_PATH. Run 'npm install && npm run build' in src/codeindex first." >&2
    exit 1
fi

if [ -z "$REPOSITORY" ]; then
    read -r -p "Repository root (absolute path) [$REPO_ROOT]: " entered
    if [ -z "${entered// /}" ]; then
        REPOSITORY="$REPO_ROOT"
    else
        REPOSITORY="$(echo "$entered" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')"
    fi
fi

# Strip trailing slashes (no backslashes on Linux paths).
REPOSITORY="${REPOSITORY%/}"

if [ ! -d "$REPOSITORY" ]; then
    echo "Repository root not found: $REPOSITORY" >&2
    exit 1
fi

if [ -z "$BRANCH" ]; then
    default_branch="$(git -C "$REPOSITORY" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [ -z "${default_branch// /}" ]; then
        default_branch="main"
    fi

    read -r -p "Branch name [$default_branch]: " entered
    if [ -z "${entered// /}" ]; then
        BRANCH="$default_branch"
    else
        BRANCH="$(echo "$entered" | sed 's/[[:space:]]*$//; s/^[[:space:]]*//')"
    fi
fi

write_step "Repository root : $REPOSITORY"
write_step "Branch          : $BRANCH"

# Resolve the HEAD SHA of the target repo so we only clean matching folders.
head_sha="$(git -C "$REPOSITORY" rev-parse HEAD 2>/dev/null || true)"

SOURCE_COMMITS="$CODEINDEX_DATA/commits"
DEST_COMMITS="$CODEMCP_DATA/commits"

if [ -n "$head_sha" ]; then
    write_step "HEAD SHA: $head_sha - removing matching commit folder(s) only"
    for dir in "$SOURCE_COMMITS" "$DEST_COMMITS"; do
        target="$dir/$head_sha"
        if [ -e "$target" ]; then
            printf '\033[90m  Removing %s\033[0m\n' "$target"
            rm -rf "$target"
        fi
    done
else
    printf '\033[33m  Warning: could not resolve HEAD SHA; skipping pre-clean.\033[0m\n'
fi

write_step "Publishing codeindex (backend=file, branch=$BRANCH, root=$REPOSITORY)"
(
    cd "$REPO_ROOT"
    node "$CLI_PATH" --backend file --branch "$BRANCH" --root "$REPOSITORY" publish
)

mkdir -p "$CODEMCP_DATA"

write_step "Copying src/codeindex/data/. -> src/codemcp/data/"
cp -a "$CODEINDEX_DATA/." "$CODEMCP_DATA/"

echo ""
write_step "Done. Indexed snapshot for '$REPOSITORY' (branch '$BRANCH') is now available to codemcp."
if [ -d "$DEST_COMMITS" ]; then
    printf '\033[90mCommit folders now in src/codemcp/data/commits/:\033[0m\n'
    for d in "$DEST_COMMITS"/*/; do
        [ -d "$d" ] || continue
        printf '\033[90m  %s\033[0m\n' "$(basename "$d")"
    done
fi
