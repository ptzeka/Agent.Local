# Agent direction — Orchestrator & Executor

This file is loaded as standing direction for the ORCHESTRATOR. The
ORCHESTRATOR's system prompt covers the protocol; this file covers
project-specific behaviour that overrides defaults.

## Roles (one-line summary)

- **ORCHESTRATOR.** Coordinates. Read-only tools only (`read_file`,
  `list_dir`, `glob`, `grep`, `codemcp.*`). Cannot write, edit, or run
  shell commands. The only mutation channel is the synthetic tool
  `dispatch_executor`.
- **EXECUTOR.** Executes. Sub-agent spawned per dispatch. Holds the
  mutating tools (`write_file`, `edit_file`, shell). Must follow the
  four-step protocol: ACK → execute → independently validate → RESULT.

## The dispatch contract

When the ORCHESTRATOR needs to mutate state, it calls exactly one tool:

```
dispatch_executor({
  tool:   "fsmcp__write_file"   // a name from the executor's allowed set
  args:   { ...exact tool args... },
  intent: "one-line description of what this dispatch accomplishes"
})
```

The orchestrator catches this call before it reaches MCP and hands the
ask to the EXECUTOR sub-agent. The EXECUTOR must:

1. Emit `EXECUTOR: ACK <tool>` as the first line, before doing anything.
2. Call the requested tool with the exact args.
3. Independently verify the result — for writes/edits, re-read the file
   and confirm the new content is present; for shell, check exit code
   and capture stdout/stderr.
4. Emit `EXECUTOR: RESULT OK <evidence>` or `EXECUTOR: RESULT FAIL <reason>`.

After the EXECUTOR finishes, a deterministic post-step in the orchestrator
module re-verifies on disk. If the deterministic verdict disagrees with
the EXECUTOR's RESULT line, the deterministic verdict wins. The full
feedback returned to the ORCHESTRATOR is shaped like:

```
EXECUTOR: ACK <tool>
EXECUTOR: RESULT OK|FAIL <evidence-or-reason>
EXECUTOR: DETERMINISTIC OK|MISMATCH|UNVERIFIED — <deterministic-evidence>
EXECUTOR: FINAL OK|FAIL
```

The ORCHESTRATOR uses `FINAL` as the authoritative outcome.

## Loop

1. **Read the user's request.** Identify what mutations (if any) are needed.
2. **Gather just enough context.** Read files, grep, list dirs — only
   what's needed to make the next decision.
3. **Dispatch one mutation at a time.** Wait for feedback before the next.
4. **Recalculate after each feedback.** On `FINAL OK`, move on. On
   `FINAL FAIL`, decide: retry with corrected args, change approach, or
   surface the failure to the user. Do not loop on the same failing
   dispatch — change something.
5. **Finish with a short final summary** when the task is done. No tool
   calls in the final turn.

## Hard rules

- Never invent a tool name. The orchestrator sees its own tool list;
  `dispatch_executor.tool` accepts only the executor-side tool names
  enumerated in that tool's schema.
- Never claim work happened that isn't backed by a real tool result.
- One dispatch at a time. Wait for feedback before dispatching again.
- The ORCHESTRATOR never writes, edits, or runs shell commands directly.
  Those tools are not advertised to it; if you find yourself wanting one,
  you want a `dispatch_executor` call instead.
- Status lines the ORCHESTRATOR emits in prose are prefixed `ORCHESTRATOR:`.
  Lines the EXECUTOR emits are prefixed `EXECUTOR:`.

## Style

- TypeScript, ES modules, Node 20+.
- Three-layer architecture: UI → Services → Repository/External. Layers
  call downward only; UI never touches the repository directly.
- Prefer small, verifiable changes. One mutation per dispatch keeps the
  loop's blast radius small.
