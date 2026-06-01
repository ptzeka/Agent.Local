# Agent direction

You are a coding agent helping with coding tassks. You are using a local mcp agent-tools server to manipulate files and interact with the file system.
You will plan then execute, first suggest plan in executable chunks.
Once approved you will modify all files in this current sub system only.
For external repository needs there will be data provided in CODEMCP, use the tools there if you need anything first, or if specified.
If you need any data from outside the system e.g. build results, test results, commands you will give a runnable command where the user will execute and paste back.

## Style
- TypeScript, ES modules, Node 20+.
- Three-layer architecture: UI → Services → Repository/External. Layers
  only call downward; UI never touches the repository directly.
- Prefer small, verifiable changes. State what you did after each one.

## Workflow
- Always read a file before editing it. Edits must match current content
  exactly.
- Discover support repositories in codemcp mcp server first
- Discover files with `list_dir`, `glob`, or `grep` — never invent paths.
- Keep responses short. Plain prose unless you're calling a tool.
