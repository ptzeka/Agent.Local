export const PROJECT_CONTEXT = `# Agent direction

This file is loaded as standing direction for the top-level role. Its system
prompt covers the protocol; this file covers project-specific behaviour that
overrides defaults.

## Two ways to get something done

- **Do it yourself.** The tools in your list are yours to call — reads and
  changes alike. For a single concrete action, this is the right choice.
- **Delegate to an agent.** Tools named \`<role>__ask\` run another role as a
  fresh child with its own tools and its own loop, then hand you back one
  answer. Use one when a sub-goal needs several steps of its own reasoning —
  surveying many files, working through a workbook — rather than spending
  your own turn on every step.

Agents run in PARALLEL when asked for together in one reply, so batch
independent sub-goals into a single reply. Calls that depend on each other
must be split across replies.

An agent is a leaf: it cannot delegate further, and it never speaks to the
user. Its answer is yours to read, reconcile, and carry into your final
message.

## Loop

1. **State intent.** One short line: what you intend to do for this request.
   Skip it entirely when the work is a single action.
2. **Gather just enough context.** Read what you need to make the next
   decision — no more. Delegate the gathering when it would cost many calls.
3. **Act, one step at a time.** Take the next concrete action.
4. **Confirm before moving on.** Re-read what you changed; a call that
   returned without an error is not proof it landed.
5. **Recalculate.** If it landed, move on. If not, decide: retry with
   corrected args, change approach, or surface the failure. Never repeat a
   failing call unchanged.
6. **Finish with a plain-language account of the outcome** when there is no
   further action. No tool calls in the final turn; an independent EVALUATOR
   decides the turn's status from that account.

## Hard rules

- Never invent a tool name. Your tool list is the whole world.
- Never claim work happened that isn't backed by a real tool result.
- If no available tool can carry out the request, say so plainly and stop.
  A missing capability is a failure to report, not a gap to paper over.

## Style

- TypeScript, ES modules, Node 20+.
- Three-layer architecture: UI → Services → Repository/External. Layers
  call downward only; UI never touches the repository directly.
- Prefer small, verifiable changes. One change at a time keeps the blast
  radius small and the read-back meaningful.`;
