-- 002_add_repository.sql — adds the `repository` column to `commits`.
--
-- Multi-repo support: a single backend can now serve commits from several
-- repositories. The reader filters `latest commit for branch` queries by
-- repository so two clones don't collide on the same branch name (e.g. both
-- have a `main`).
--
-- Forward-only. Clean break (no NULL fallback): every existing row gets the
-- empty-string sentinel and must be re-published. The default is dropped
-- immediately after the column is added so future inserts fail loudly if the
-- publisher forgets to set it.

ALTER TABLE commits ADD COLUMN repository TEXT NOT NULL DEFAULT '';
ALTER TABLE commits ALTER COLUMN repository DROP DEFAULT;

-- Repository+branch+recency is the new "latest indexed commit" lookup key.
-- The old branch-only index becomes redundant.
CREATE INDEX IF NOT EXISTS commits_repo_branch_idx
    ON commits (repository, branch, indexed_at DESC);
DROP INDEX IF EXISTS commits_branch_idx;
