-- Run against the target database (agentlocal). Creates the per-service schemas and the DEFAULT
-- privileges that future tables inherit. dbup creates tables as `agent`, so the default-privilege
-- grants are scoped FOR ROLE agent — anything agent later creates in these schemas is auto-granted.

CREATE SCHEMA IF NOT EXISTS code AUTHORIZATION agent;
CREATE SCHEMA IF NOT EXISTS memo AUTHORIZATION agent;

GRANT USAGE ON SCHEMA code, memo TO app_readonly, app_readwrite;

ALTER DEFAULT PRIVILEGES FOR ROLE agent IN SCHEMA code, memo
  GRANT SELECT ON TABLES TO app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE agent IN SCHEMA code, memo
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_readwrite;
