import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import type { DbConnectionFactory } from '../db/types.js';
import type { AppliedMigration, CommitRepository } from '../db/pgRepository.js';

const MIGRATION_LOCK_KEY = 7148291035;

interface Script {
  name: string;
  body: string;
  checksum: string;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: { name: string; checksum: string }[];
}

export interface MigrationRunnerOptions {
  // path to the migrations directory; defaults to ../../migrations relative to this file
  migrationsDir?: string;
  // when false, record migrations as applied without running their SQL — for non-SQL backends
  // (the debug file backend) so schema_versions stays in lockstep with what Postgres would have
  executeSql?: boolean;
}

export class MigrationRunner {
  private readonly migrationsDir: string;
  private readonly executeSql: boolean;

  constructor(
    private readonly factory: DbConnectionFactory,
    private readonly repo: CommitRepository,
    options: MigrationRunnerOptions = {},
  ) {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    this.migrationsDir = options.migrationsDir ?? resolve(thisDir, '..', '..', 'migrations');
    this.executeSql = options.executeSql ?? true;
  }

  async status(): Promise<MigrationStatus> {
    await using conn = await this.factory.getConnection();
    await this.repo.ensureSchemaVersionsTable(conn);
    const applied = await this.repo.getAppliedMigrations(conn);
    const appliedSet = new Set(applied.map(a => a.scriptName));
    const scripts = this.loadScripts();
    this.verifyAppliedChecksums(applied, scripts);
    const pending = scripts
      .filter(s => !appliedSet.has(s.name))
      .map(s => ({ name: s.name, checksum: s.checksum }));
    return { applied, pending };
  }

  async run(): Promise<{ appliedNow: string[] }> {
    const scripts = this.loadScripts();

    await using lockConn = await this.factory.getConnection();
    await this.repo.ensureSchemaVersionsTable(lockConn);
    await this.repo.acquireAdvisoryLock(lockConn, MIGRATION_LOCK_KEY);

    const appliedNow: string[] = [];
    try {
      const applied = await this.repo.getAppliedMigrations(lockConn);
      this.verifyAppliedChecksums(applied, scripts);
      const appliedSet = new Set(applied.map(a => a.scriptName));

      for (const script of scripts) {
        if (appliedSet.has(script.name)) continue;
        await this.applyScript(script);
        appliedNow.push(script.name);
      }
    } finally {
      await this.repo.releaseAdvisoryLock(lockConn, MIGRATION_LOCK_KEY);
    }

    return { appliedNow };
  }

  private async applyScript(script: Script): Promise<void> {
    await using conn = await this.factory.getConnection();
    await conn.begin();
    try {
      if (this.executeSql) {
        // the documented exception to "no SQL in code": by design it streams arbitrary SQL from .sql files
        await conn.query(script.body);
      }
      await this.repo.recordMigration(conn, script.name, script.checksum);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw new Error(`Migration ${script.name} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  private loadScripts(): Script[] {
    const entries = readdirSync(this.migrationsDir, { withFileTypes: true });
    const sqlFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.sql'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));

    return sqlFiles.map(name => {
      const body = readFileSync(resolve(this.migrationsDir, name), 'utf-8');
      const checksum = createHash('sha256').update(body).digest('hex');
      return { name, body, checksum };
    });
  }

  private verifyAppliedChecksums(applied: AppliedMigration[], scripts: Script[]): void {
    const byName = new Map(scripts.map(s => [s.name, s]));
    for (const row of applied) {
      const current = byName.get(row.scriptName);
      if (!current) {
        throw new Error(
          `Migration ${row.scriptName} was applied previously but is no longer present on disk. ` +
          `Forward-only migrations must not be deleted; restore the file or roll forward with a new migration.`,
        );
      }
      if (current.checksum !== row.checksum) {
        throw new Error(
          `Migration ${row.scriptName} has been modified after being applied ` +
          `(checksum mismatch: db=${row.checksum} disk=${current.checksum}). ` +
          `Forward-only migrations are immutable; create a new migration with the changes.`,
        );
      }
    }
  }
}
