import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { EdgeRow, IEdgeRepository } from './types.js';

// reads the edges.jsonl sidecar codeindex co-locates with each snapshot at
// <baseDir>/commits/<sha>/edges.jsonl; read-per-call like the chunk store, so a
// republish is visible without a server restart
export class FileEdgeRepository implements IEdgeRepository {
  constructor(private readonly baseDir: string) {}

  async listEdges(commitSha: string): Promise<EdgeRow[]> {
    const path = join(this.baseDir, 'commits', commitSha, 'edges.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .filter(line => line.trim().length > 0)
      .flatMap(line => {
        try {
          return [JSON.parse(line) as EdgeRow];
        } catch {
          return [];
        }
      });
  }
}

// pg has no edges table yet (BACKLOG: pg edge parity); an empty result reads the
// same as "this commit was indexed before edge extraction existed"
export class NoEdgeRepository implements IEdgeRepository {
  async listEdges(): Promise<EdgeRow[]> {
    return [];
  }
}
