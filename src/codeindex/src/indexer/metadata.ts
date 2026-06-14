import { existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import type { Area } from '../types.js';

export function areaForPath(relPath: string): Area {
  const parts = relPath.split(posix.sep);
  if (parts[0] === 'src') {
    const sub = parts[1];
    if (sub === 'api') return 'api';
    if (sub === 'backend') return 'backend';
    if (sub === 'frontend') return 'frontend';
    if (sub === 'db') return 'db';
    if (sub === 'test') return 'test';
    if (sub === 'codemcp') return 'tools';
    return 'root';
  }
  if (parts[0] === 'tools') return 'tools';
  if (parts[0] === 'pipeline') return 'pipeline';
  if (parts[0] === 'minikube') return 'minikube';
  if (relPath.endsWith('.md')) return 'docs';
  return 'root';
}

export function languageForPath(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  if (dot < 0) return 'plain';
  const ext = relPath.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'cs': return 'csharp';
    case 'ts': return 'typescript';
    case 'tsx': return 'tsx';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'jsx': return 'jsx';
    case 'md': return 'markdown';
    case 'sql': return 'sql';
    case 'proto': return 'protobuf';
    case 'json': return 'json';
    case 'yml': case 'yaml': return 'yaml';
    default: return ext;
  }
}

// collects every CLAUDE.md / CLAUDE.BASE.md from the file's dir up to rootDir,
// ordered most-specific (closest) to least-specific (the root base contract)
export function claudeMdLineageForFile(rootDir: string, relPath: string): string[] {
  const out: string[] = [];
  let current = dirname(join(rootDir, relPath));
  const root = rootDir.replace(/[\\/]+$/, '');

  while (current.length >= root.length) {
    for (const name of ['CLAUDE.md', 'CLAUDE.BASE.md']) {
      const candidate = join(current, name);
      if (existsSync(candidate)) {
        const rel = candidate.substring(root.length + 1).split(/[\\/]/).join('/');
        out.push(rel);
      }
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}
