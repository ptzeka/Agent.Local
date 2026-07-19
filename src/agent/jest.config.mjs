/**
 * Jest config for this NodeNext TypeScript package.
 *
 * ts-jest compiles the TypeScript sources to CommonJS for the test run, so Jest
 * needs no `--experimental-vm-modules` launch flag. The one non-default piece is
 * the moduleNameMapper: NodeNext source imports carry explicit `.js` specifiers
 * (e.g. `./session.js`), but on disk those are `.ts` files, so the mapper strips
 * the extension and lets the resolver find the source.
 */
/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  moduleNameMapper: {
    // jose is ESM-only, unloadable under the CJS test runtime; the stub rejects every crypto operation, so
    // token-verification tests can only assert the failure path (the positive path is covered live)
    "^jose$": "<rootDir>/tests/stubs/jose.ts",
    // resolve the sibling-repo package to its TS source so tests need no prebuild
    "^@agent-local/common$": "<rootDir>/../../../Agent.Common/src/index.ts",
    "^@agent-local/common/(.*)$": "<rootDir>/../../../Agent.Common/src/$1.ts",
    "^@agent-local/mcp$": "<rootDir>/../mcp/src/index.ts",
    "^@agent-local/mcp/(.*)$": "<rootDir>/../mcp/src/$1.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // isolatedModules: transpile each file independently (Jest already isolates
    // files) — this silences ts-jest's hybrid-module (NodeNext) warning.
    // The tsconfig override emits CommonJS so the compiled tests run under
    // Jest's CJS runtime; the project's NodeNext setting would emit ESM.
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
