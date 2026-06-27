-- Cluster-global role model. Idempotent: every statement is guarded or re-runnable, so provisioning
-- can be re-applied without error. LOCAL DEV passwords (= role name); override before any shared use.
--
-- Two NOLOGIN group roles bundle privilege; login users are granted into a group and never carry
-- privileges directly. readwrite inherits readonly, so a writer can also read.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_readonly') THEN
    CREATE ROLE app_readonly NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_readwrite') THEN
    CREATE ROLE app_readwrite NOLOGIN;
  END IF;
END $$;

-- a writer is also a reader
GRANT app_readonly TO app_readwrite;

-- login users: the read-path MCP server is structurally read-only (granted into app_readonly only),
-- the indexer and the memo server can write. This mirrors the agent's read/write tool split.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'codemcp_ro') THEN
    CREATE ROLE codemcp_ro LOGIN PASSWORD 'codemcp_ro';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'codeindex_rw') THEN
    CREATE ROLE codeindex_rw LOGIN PASSWORD 'codeindex_rw';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'memomcp_rw') THEN
    CREATE ROLE memomcp_rw LOGIN PASSWORD 'memomcp_rw';
  END IF;
END $$;

GRANT app_readonly  TO codemcp_ro;
GRANT app_readwrite TO codeindex_rw;
GRANT app_readwrite TO memomcp_rw;
