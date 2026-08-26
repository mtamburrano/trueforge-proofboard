# TrueForge Proof Board

TrueForge Agent Harness Hackathon submission for verified autonomous software delivery.

TrueForge Proof Board is a small foundation for making autonomous software work understandable and trustworthy. The product thesis is:

**Plan → Execute → Prove → Approve**

- **Plan** the objective and the bounded work needed to deliver it.
- **Execute** through TrueForge with explicit ownership and controlled tools.
- **Prove** progress with concrete, inspectable evidence rather than agent claims alone.
- **Approve** consequential delivery actions with a human in control.

This repository deliberately starts with only the TypeScript/Node foundation needed for the upcoming TrueForge integration. Mission, work-item, board, evidence, and approval behavior will be added incrementally as the end-to-end delivery path is built.

## Development

Requires Node.js 22.14 or newer.

```sh
npm install
npm run check
```

`npm run check` type-checks the source, builds it into `dist/`, and runs the Node test suite.

## TrueForge smoke path

The reproducible TrueForge + GitHub MCP + Daytona validation path is documented in
[`docs/trueforge-smoke.md`](docs/trueforge-smoke.md). After configuring the local
TrueForge server, run the harmless local validation with:

```sh
npm run smoke:trueforge -- --dry-run
```

Run the live, opt-in smoke only when the external provider, GitHub MCP connector,
and Daytona sandbox are configured:

```sh
npm run smoke:trueforge
```

## Repository safety

Local credentials, environment files, MCP configuration, MCPlanner metadata, dependencies, and generated output are ignored by default. Do not commit secrets or machine-specific configuration.
