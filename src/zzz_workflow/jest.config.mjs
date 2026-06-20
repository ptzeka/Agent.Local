/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src/tests"],
  moduleNameMapper: {
    // sibling packages resolve to their own TS source so tests need no prebuild / no broker
    "^@agent-local/common/(.*)$": "<rootDir>/../common/src/$1.ts",
    "^@agent-local/common$": "<rootDir>/../common/src/index.ts",
    // @camunda8/sdk isn't a workspace dep yet; the worker tests inject a fake gRPC, so a stub satisfies the import
    "^@camunda8/sdk$": "<rootDir>/src/tests/camunda-stub.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
