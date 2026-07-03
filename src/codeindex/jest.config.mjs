/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  // native tree-sitter can't re-init in a reused worker process; 1MB recycles the worker per test file
  workerIdleMemoryLimit: "1MB",
  moduleNameMapper: {
    // resolve shared @agent-local packages to TS source so tests need no prebuild
    "^@agent-local/vectorstore$": "<rootDir>/../vectorstore/src/index.ts",
    "^@agent-local/vectorizer$": "<rootDir>/../vectorizer/src/index.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // emit CommonJS so compiled tests run under Jest's CJS runtime; isolatedModules silences the NodeNext hybrid warning
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
