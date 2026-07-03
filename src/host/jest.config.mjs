/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  // tests live under src/tests (excluded from the tsc build via tsconfig); scanning src finds them anywhere
  roots: ["<rootDir>/src"],
  moduleNameMapper: {
    // jose is ESM-only, unloadable under the CJS test runtime; the agent package's stub fails every crypto op,
    // so only verification-failure paths are testable here (the positive path is covered live)
    "^jose$": "<rootDir>/../agent/tests/stubs/jose.ts",
    // resolve the shared workspace package to its TS source so tests need no prebuild
    "^@agent-local/common$": "<rootDir>/../common/src/index.ts",
    "^@agent-local/common/(.*)$": "<rootDir>/../common/src/$1.ts",
    // self-reference the package to its own TS source so tests need no prebuild
    "^@agent-local/host$": "<rootDir>/src/index.ts",
    "^@agent-local/host/(.*)$": "<rootDir>/src/$1.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // emit CommonJS so compiled tests run under Jest's CJS runtime; isolatedModules silences the NodeNext hybrid warning
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
