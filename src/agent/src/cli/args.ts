/**
 * CLI argument parsing.
 *
 * Kept separate from the composition root in index.ts so it stays pure and
 * side-effect free — importing index.ts runs `main()`, while this module can be
 * unit-tested on its own.
 */

/** Parsed CLI invocation. `run` present ⇒ headless single run; absent ⇒ REPL. */
export interface CliArgs {
  /** The single-run input. When set, the process runs headless and exits. */
  run?: string;
  /** Optional session to resume; a fresh one is opened when omitted. */
  sessionId?: string;
}

/**
 * Minimal argv parser for the two recognised flags:
 *   --run <input>      run headless against this input, then exit
 *   --session <id>     resume this session (otherwise a fresh one is opened)
 * `--flag=value` and `--flag value` forms are both accepted. Anything else is
 * ignored so the interactive path stays the no-flag default.
 */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq >= 0 ? token.slice(0, eq) : token;
    const inlineValue = eq >= 0 ? token.slice(eq + 1) : undefined;
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };

    if (flag === "--run") {
      args.run = takeValue() ?? "";
    } else if (flag === "--session") {
      const value = takeValue();
      if (value !== undefined) args.sessionId = value;
    }
  }
  return args;
}
