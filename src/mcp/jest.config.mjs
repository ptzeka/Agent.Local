/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src/tests"],
  moduleNameMapper: {
    // resolve this package and its common dependency to TS source so tests need no prebuild
    "^@agent-local/mcp$": "<rootDir>/src/index.ts",
    "^@agent-local/mcp/(.*)$": "<rootDir>/src/$1.ts",
    "^@agent-local/common$": "<rootDir>/../common/src/index.ts",
    "^@agent-local/common/(.*)$": "<rootDir>/../common/src/$1.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // emit CommonJS so compiled tests run under Jest's CJS runtime; isolatedModules silences the NodeNext hybrid warning
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
