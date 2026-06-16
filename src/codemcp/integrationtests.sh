#!/usr/bin/env bash
# codemcp — retrieval integration test (automated).
#
# Runs every codemcp retrieval tool over the real wiring (file vector store + embedder,
# reading a published codeindex snapshot) and asserts the output of each, printing one
# PASS/FAIL line per check and exiting non-zero if anything fails.
#
# It validates the two-tier `locate -> expand` contract: full tools (search_code / find_symbol /
# get_file_context) return bodies; locate_* tools return the same citations content-free; expand_chunk
# reconstructs one body; related_code is more-like-this; and the resolution guards refuse rather
# than guess.
#
# Usage (from repo root or anywhere):
#   src/codemcp/integrationtests.sh            # validate against the already-published index (fast)
#   src/codemcp/integrationtests.sh --build    # compile first, then validate
#   src/codemcp/integrationtests.sh --publish  # re-publish HEAD's index, then validate
#   src/codemcp/integrationtests.sh --full     # build + publish + validate
#
# Env overrides (must match what the index was published with):
#   BRANCH=main  EMBED_PROVIDER=local  EMBED_DIM=768
#
# Embedder caveat: the committed index uses the `local` hashed-bag embedder, which ranks by token
# overlap, not meaning. The checks below assert *consistency* (locate ordering matches search_code,
# bodies present/absent, refusals), never semantic quality — so they hold under any embedder.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

BRANCH="${BRANCH:-main}"
EMBED_PROVIDER="${EMBED_PROVIDER:-local}"
EMBED_DIM="${EMBED_DIM:-768}"

DO_BUILD=0
DO_PUBLISH=0
for arg in "$@"; do
  case "$arg" in
    --build)   DO_BUILD=1 ;;
    --publish) DO_PUBLISH=1 ;;
    --full)    DO_BUILD=1; DO_PUBLISH=1 ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# run a codemcp tool through the one-shot probe CLI (the file backend auto-discovers the index
# when launched from the package dir).
cm() {
  ( cd "$ROOT/src/codemcp" && node dist/server.js \
      --backend file --branch "$BRANCH" --embed-provider "$EMBED_PROVIDER" --embed-dim "$EMBED_DIM" \
      probe "$@" )
}

PASS=0
FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

ok()   { printf '  %s  %s\n' "$(green PASS)" "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  %s  %s\n' "$(red FAIL)" "$1"; FAIL=$((FAIL + 1)); [ $# -gt 1 ] && printf '        %s\n' "$2"; }

# assert haystack ($2) contains needle ($3); $1 is the check label
has()  { if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else bad "$1" "expected to contain: $3"; fi; }
# assert haystack ($2) does NOT contain needle ($3)
lacks() { if printf '%s' "$2" | grep -qF -- "$3"; then bad "$1" "should NOT contain: $3"; else ok "$1"; fi; }
# assert haystack ($2) matches ERE ($3)
matches() { if printf '%s' "$2" | grep -qE -- "$3"; then ok "$1"; else bad "$1" "expected to match: $3"; fi; }

# pull the first "[path:start-end]" citation out of a tool's output
first_cite() { printf '%s\n' "$1" | grep -oE '^\[[^]]+\]' | head -1 | tr -d '[]'; }

# ---- optional setup ---------------------------------------------------------
if [ "$DO_BUILD" = 1 ]; then
  echo "==> npm run build"
  ( cd "$ROOT" && npm run build ) || { echo "build failed" >&2; exit 1; }
fi
if [ "$DO_PUBLISH" = 1 ]; then
  echo "==> publish codeindex (HEAD, branch=$BRANCH)"
  "$ROOT/scripts/publish-codeindex.sh" -b "$BRANCH" -Repository "$ROOT" \
    || { echo "publish failed" >&2; exit 1; }
fi

echo
echo "codemcp retrieval integration test  (backend=file branch=$BRANCH embed=$EMBED_PROVIDER:$EMBED_DIM)"
echo "========================================================================"

# ---- 1. list_commits --------------------------------------------------------
echo "1. list_commits (discovery)"
S1="$(cm list_commits '{"limit":10}')"
matches "40-hex commit sha present"        "$S1" '[0-9a-f]{40}'
has     "branch=main reported"             "$S1" "branch=main"
matches "repository reported"              "$S1" 'repository=[^ ]+'

# ---- 2. search_code (full) --------------------------------------------------
echo "2. search_code (full search — bodies)"
S2="$(cm search_code '{"query":"similarity search over the vector store","k":5}')"
has     "resolution header (branch: main)" "$S2" "branch: main"
has     "scored hits"                      "$S2" "score="
has     "per-hit governance/body block"    "$S2" "governed by:"
SEED="$(first_cite "$S2")"
if [ -z "$SEED" ]; then
  bad "top hit yields a [path:start-end] citation" "no citation parsed from search_code output"
else
  ok "top hit yields a [path:start-end] citation"
fi
SEED_PATH="${SEED%:*}"; SEED_RANGE="${SEED##*:}"; SEED_START="${SEED_RANGE%-*}"; SEED_END="${SEED_RANGE#*-}"

# ---- 3. find_symbol (full) --------------------------------------------------
echo "3. find_symbol (exact symbol — body)"
S3="$(cm find_symbol '{"name":"CodeRetrieval"}')"
has     "cites codeRetrieval.ts"           "$S3" "src/codemcp/src/retrieval/codeRetrieval.ts"
has     "returns the class body"           "$S3" "class CodeRetrieval"

# ---- 4. get_file_context (full) ---------------------------------------------
echo "4. get_file_context (whole file — bodies + governance)"
S4="$(cm get_file_context '{"path":"src/codemcp/src/retrieval/codeRetrieval.ts"}')"
has     "governance preface"               "$S4" "Governing CLAUDE.md files"
has     "includes the class chunk"         "$S4" "codeRetrieval.ts:15-89"
lacks   "no foreign file leaks in"         "$S4" "src/memomcp/"

# ---- 5. locate_code (locate — content-free) ---------------------------------
echo "5. locate_code (locate tier — no bodies, same ranking as search_code)"
S5="$(cm locate_code '{"query":"similarity search over the vector store","k":5}')"
lacks   "no body / governance blocks"      "$S5" "governed by:"
has     "still scored"                     "$S5" "score="
S5_TOP="$(first_cite "$S5")"
if [ "$S5_TOP" = "$SEED" ]; then ok "top citation matches search_code (step 2)"; \
  else bad "top citation matches search_code (step 2)" "locate=$S5_TOP search=$SEED"; fi

# ---- 6. locate_symbol / locate_file (locate — content-free) -----------------
echo "6. locate_symbol & locate_file (exact-match locate — no bodies)"
S6S="$(cm locate_symbol '{"name":"CodeRetrieval"}')"
has     "locate_symbol cites the class"    "$S6S" "codeRetrieval.ts:15-89"
lacks   "locate_symbol has no body"        "$S6S" "class CodeRetrieval"
S6F="$(cm locate_file '{"path":"src/codemcp/src/retrieval/codeRetrieval.ts"}')"
has     "locate_file outlines the file"    "$S6F" "codeRetrieval.ts:15-89"
lacks   "locate_file has no bodies"        "$S6F" "governed by:"

# ---- 7. related_code (more-like-this) ---------------------------------------
echo "7. related_code (more-like-this — seed excluded)"
S7="$(cm related_code "{\"path\":\"$SEED_PATH\",\"startLine\":$SEED_START,\"endLine\":$SEED_END,\"k\":5}")"
has     "returns neighbour bodies"         "$S7" "governed by:"
lacks   "the seed itself is excluded"      "$S7" "$SEED_PATH:$SEED_START-$SEED_END"
S7BAD="$(cm related_code '{"path":"src/codemcp/src/retrieval/codeRetrieval.ts","startLine":2,"endLine":9,"k":5}')"
has     "refuses a non-boundary seed"      "$S7BAD" "no related chunks"

# ---- 8. expand_chunk (expand — closes the loop) -----------------------------
echo "8. expand_chunk (expand tier — reconstructs one body)"
S8="$(cm expand_chunk "{\"path\":\"$SEED_PATH\",\"startLine\":$SEED_START,\"endLine\":$SEED_END}")"
has     "returns the seed citation"        "$S8" "$SEED_PATH:$SEED_START-$SEED_END"
has     "with its full body block"         "$S8" "governed by:"
S8BAD="$(cm expand_chunk '{"path":"src/codemcp/src/retrieval/codeRetrieval.ts","startLine":2,"endLine":9}')"
has     "refuses a non-boundary range"     "$S8BAD" "no chunk at"

# ---- 9. resolution guard ----------------------------------------------------
echo "9. resolution guard (refuse, do not guess)"
S9="$(cm search_code '{"query":"anything","repository":"no/such-repo"}')"
has     "unknown repository is refused"    "$S9" "no indexed commits"

# ---- summary ----------------------------------------------------------------
echo "========================================================================"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf '%s — %d/%d checks passed\n' "$(green PASS)" "$PASS" "$TOTAL"
  exit 0
else
  printf '%s — %d/%d checks failed\n' "$(red FAIL)" "$FAIL" "$TOTAL"
  exit 1
fi
