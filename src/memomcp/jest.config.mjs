/** @type {import("ts-jest").JestConfigWithTsJest} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src/tests"],
  moduleNameMapper: {
    // resolve sibling workspace packages to their TS sources so tests need no prebuild
    "^@agent-local/vectorstore$": "<rootDir>/../vectorstore/src/index.ts",
    "^@agent-local/vectorizer$": "<rootDir>/../vectorizer/src/index.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // emit CommonJS so compiled tests run under Jest's CJS runtime; isolatedModules silences the NodeNext hybrid warning
    "^.+\\.ts$": ["ts-jest", { tsconfig: { module: "commonjs", isolatedModules: true } }],
  },
};
