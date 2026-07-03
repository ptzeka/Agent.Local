// kept out of index.ts so it stays pure and unit-testable; importing index.ts would run main()

// run present ⇒ headless single run; absent ⇒ REPL (login lives inside the interactive picker, not a flag)
export interface CliArgs {
  run?: string;
  sessionId?: string;
}

// accepts --run <input> and --session <id> in both --flag=value and --flag value forms;
// anything else is ignored so the no-flag default stays the interactive path
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
