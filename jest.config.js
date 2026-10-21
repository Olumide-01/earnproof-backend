module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testRegex: ".*\\.spec\\.ts$",
  // The integration suite has its own config (jest.integration.config.js): it
  // needs a real PostgreSQL server, and the unit suite must stay runnable
  // without one. Ignored explicitly rather than relying on the `.int-spec.ts`
  // suffix, so a file named `*.spec.ts` under test/integration cannot quietly
  // start requiring a database here.
  //
  // Same reasoning for /test/performance/: its own config
  // (jest.performance.config.js) owns the `.perf-spec.ts` suffix, which
  // still matches the `.spec.ts$` regex above and would otherwise run here
  // too, minus the global setup that seeds and connects to its database.
  testPathIgnorePatterns: ["/node_modules/", "/test/integration/", "/test/performance/"],
  transform: {
    "^.+\\.(t|j)s$": [
      "ts-jest",
      {
        diagnostics: false,
      },
    ],
  },
  collectCoverageFrom: ["src/**/*.(t|j)s"],
  coverageDirectory: "./coverage",
  testEnvironment: "node"
};
