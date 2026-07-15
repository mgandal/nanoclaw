# The IPC wire contract lives as two physical copies kept in lockstep by test, not a shared package

The file-based IPC wire has two ends — MCP tools in `container/agent-runner/`
(a separate npm package, built into the container image) and IpcHandlers in
`src/ipc/`. The shared knowledge (queue dir names, the type→results-dir map)
is declared once per side: canonical at
`container/agent-runner/src/wire-contract.ts`, mirrored at
`src/ipc/wire-contract.ts`. `src/ipc/wire-contract.test.ts` deep-compares the
exports and pins every registered result-kind handler to the table, so drift
in either direction is a red test.

## Rejected: a single shared module both sides import

The obvious "define it once" is a shared package imported by both. It was
rejected because the host `tsc` build cannot reach across the container image
build context (the agent-runner is COPY'd into the image with its own
`node_modules` and `tsconfig`), and introducing a third published package to
bridge two files is more machinery than the ~30-line contract warrants —
against the project's "small enough to understand, no abstraction sprawl"
philosophy (REQUIREMENTS.md). Two copies + a lockstep test is the smaller
seam. Do not re-propose the shared-module version without first solving the
cross-build-context import.

## Constraint the test guards

Compiled `.js`/`.d.ts` artifacts must never sit beside the sources: vitest (and
tsc) resolve a literal `.js` import before the `.ts`, which silently pins the
parity test to a stale build. `.gitignore` and `container/.dockerignore`
exclude `agent-runner/src/*.{js,js.map,d.ts,d.ts.map}` for this reason.
