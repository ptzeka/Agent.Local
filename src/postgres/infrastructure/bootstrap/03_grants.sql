-- Run against the target database (agentlocal) AFTER dbup has created the tables. Default privileges
-- (02_schemas.sql) only cover FUTURE objects, so this grants on the tables that now exist — re-runnable.

GRANT SELECT ON ALL TABLES IN SCHEMA code, memo TO app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA code, memo TO app_readwrite;
