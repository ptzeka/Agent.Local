#!/usr/bin/env bash
#
# Clears all indexed snapshots from both data trees:
#   src/codeindex/data/commits/  (the publisher's working output)
#   src/codemcp/data/commits/    (the copy codemcp serves)
#
# Use this to reset the index from scratch (e.g. after stale per-commit
# snapshots accumulate, since publish never prunes old SHAs). By default the
# migration journal (schema_versions.json) is preserved; pass -s to remove it
# too and force a clean re-migration on the next publish.
#
# Usage:
#   scripts/clear-codeindex.sh [-y] [-s]
#
# Options:
#   -y, --yes, -Force         Skip the confirmation prompt.
#   -s, --schema, -IncludeSchema  Also delete schema_versions.json (resets the
#                             migration journal).
#   -h, --help                Show this help.
#
# Examples:
#   scripts/clear-codeindex.sh
#   scripts/clear-codeindex.sh -y
#   scripts/clear-codeindex.sh -y -s

set -euo pipefail

FORCE=0
INCLUDE_SCHEMA=0

# Accept short (-y/-s) and PowerShell-style long (-Force/-IncludeSchema) flags,
# case-insensitively, matching publish-codeindex.sh.
while [ $# -gt 0 ]; do
    key="${1%%=*}"
    lkey="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
    case "$lkey" in
        -y|--yes|-force)
            FORCE=1
            ;;
        -s|--schema|-includeschema)
            INCLUDE_SCHEMA=1
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
    # Cyan, matching publish-codeindex.sh.
    printf '\033[36m==> %s\033[0m\n' "$1"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CODEINDEX_DATA="$REPO_ROOT/src/codeindex/data"
CODEMCP_DATA="$REPO_ROOT/src/codemcp/data"

DATA_DIRS=("$CODEINDEX_DATA" "$CODEMCP_DATA")

# Enumerate what would be removed so the prompt is informed.
declare -a TARGETS=()
for data in "${DATA_DIRS[@]}"; do
    commits="$data/commits"
    if [ -d "$commits" ]; then
        for d in "$commits"/*/; do
            [ -d "$d" ] || continue
            TARGETS+=("$d")
        done
    fi
    if [ "$INCLUDE_SCHEMA" -eq 1 ] && [ -f "$data/schema_versions.json" ]; then
        TARGETS+=("$data/schema_versions.json")
    fi
done

if [ "${#TARGETS[@]}" -eq 0 ]; then
    write_step "Nothing to clear: no snapshots found under src/codeindex/data or src/codemcp/data."
    exit 0
fi

write_step "The following will be permanently removed:"
for t in "${TARGETS[@]}"; do
    printf '\033[90m  %s\033[0m\n' "$t"
done

if [ "$FORCE" -ne 1 ]; then
    read -r -p "Delete these ${#TARGETS[@]} item(s)? [y/N] " answer
    case "$answer" in
        [yY]|[yY][eE][sS]) ;;
        *) write_step "Aborted; nothing removed."; exit 0 ;;
    esac
fi

for t in "${TARGETS[@]}"; do
    rm -rf "$t"
done

write_step "Cleared ${#TARGETS[@]} item(s). Run scripts/publish-codeindex.sh to rebuild the index."
