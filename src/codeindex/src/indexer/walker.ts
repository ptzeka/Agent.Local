import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, join, sep, posix } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// `ignore` is a CommonJS factory; importing it via createRequire avoids the
// NodeNext/ESM interop headaches around `module.exports = factory`.
const ignoreFactory: () => IgnoreLike = require('ignore');

interface IgnoreLike {
  add(patterns: string | string[]): IgnoreLike;
  ignores(path: string): boolean;
}

export interface WalkOptions {
  rootDir: string;
  excludeGlobs?: string[];
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;   // forward-slash, relative to rootDir
  sizeBytes: number;
}

const INDEXABLE_EXTENSIONS = new Set([
  '.cs',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.md',
  '.sql',
  '.proto',
  '.json',
  '.yml', '.yaml',
]);

// Hard caps so a stray giant file doesn't blow up the indexer.
const MAX_FILE_BYTES = 512 * 1024; // 512 KB

export function walkRepository(options: WalkOptions): DiscoveredFile[] {
  const rootDir = resolve(options.rootDir);
  const ig = ignoreFactory();

  const gitignorePath = join(rootDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, 'utf-8'));
  }
  if (options.excludeGlobs && options.excludeGlobs.length > 0) {
    ig.add(options.excludeGlobs);
  }
  // Always exclude these regardless of .gitignore presence.
  ig.add(['.git/', 'node_modules/', 'dist/', 'bin/', 'obj/', 'publish/']);

  const out: DiscoveredFile[] = [];
  walk(rootDir, rootDir, ig, out);
  return out;
}

function walk(rootDir: string, current: string, ig: IgnoreLike, out: DiscoveredFile[]): void {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const rel = toPosix(relative(rootDir, absolute));
    const relForMatch = entry.isDirectory() ? `${rel}/` : rel;
    if (ig.ignores(relForMatch)) continue;

    if (entry.isDirectory()) {
      walk(rootDir, absolute, ig, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = extOf(entry.name);
    if (!INDEXABLE_EXTENSIONS.has(ext)) continue;

    let size = 0;
    try { size = statSync(absolute).size; } catch { continue; }
    if (size > MAX_FILE_BYTES) continue;
    if (size === 0) continue;

    out.push({ absolutePath: absolute, relativePath: rel, sizeBytes: size });
  }
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot).toLowerCase();
}
