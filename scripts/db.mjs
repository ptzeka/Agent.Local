// One-shot SQLite query runner backed by better-sqlite3, so the repo DB tooling
// has no dependency on a system `sqlite3` binary (which isn't on PATH on Windows).
// Replicates the .sqliterc presentation: box table, headers, NULL nullvalue, timer.
//
//   node scripts/db.mjs <dbfile> "SELECT * FROM work LIMIT 5;"
//
// Invoked via scripts/db.sh, which resolves the host/agent DB path first.
import Database from 'better-sqlite3';

// --- repo/render: read-only access + box formatting --------------------------

// Run one SQL statement and return rows as arrays of stringified cells plus the
// ordered column names. SELECT-style statements expose columns(); writes don't.
function runStatement(db, sql) {
  const stmt = db.prepare(sql);
  if (!stmt.reader) {
    const info = stmt.run();
    return { columns: ['changes', 'lastInsertRowid'], rows: [[String(info.changes), String(info.lastInsertRowid)]] };
  }
  const rows = stmt.raw().all();
  const columns = stmt.columns().map((c) => c.name);
  const cells = rows.map((row) => row.map(formatCell));
  return { columns, rows: cells };
}

// .nullvalue NULL — render null as the literal text, everything else as a string.
function formatCell(value) {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return `<BLOB ${value.length} bytes>`;
  return String(value);
}

// Render a result set as sqlite3's `.mode box` Unicode table with `.headers on`.
function renderBox({ columns, rows }) {
  const widths = columns.map((name, i) =>
    Math.max(displayWidth(name), ...rows.map((row) => displayWidth(row[i])), 0),
  );
  const line = (left, mid, right) =>
    left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right;
  const rowText = (cells) =>
    '│' + cells.map((cell, i) => ` ${pad(cell, widths[i])} `).join('│') + '│';

  const out = [line('┌', '┬', '┐'), rowText(columns), line('├', '┼', '┤')];
  for (const row of rows) out.push(rowText(row));
  out.push(line('└', '┴', '┘'));
  return out.join('\n');
}

const displayWidth = (text) => String(text).length;
const pad = (text, width) => text + ' '.repeat(width - displayWidth(text));

// --- service: execute the query and present it -------------------------------

function executeQuery(dbFile, sql) {
  const db = new Database(dbFile, { readonly: false });
  try {
    const start = process.hrtime.bigint();
    const result = runStatement(db, sql);
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;

    if (result.rows.length > 0) console.log(renderBox(result));
    // .timer on — mirror sqlite3's trailing run-time line (real time only).
    console.log(`Run Time: real ${elapsedSeconds.toFixed(3)}`);
  } finally {
    db.close();
  }
}

// --- entry: arg parsing ------------------------------------------------------

function main() {
  const [dbFile, sql] = process.argv.slice(2);
  if (!dbFile || !sql) {
    console.error('usage: node scripts/db.mjs <dbfile> "<sql>"');
    process.exit(2);
  }
  try {
    executeQuery(dbFile, sql);
  } catch (error) {
    console.error(`[db] ${error.message}`);
    process.exit(1);
  }
}

main();
