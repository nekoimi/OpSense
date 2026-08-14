# OpSense

OpSense is a local CLI that inspects one Linux server over SSH and generates an operations report.

## Development

```powershell
fnm use
pnpm install
pnpm check
```

Run the CLI in development mode:

```powershell
pnpm dev -- --help
```

The M0 skeleton exposes `scan`, `analyze`, `report`, and `inspect`. Their implementation starts in later milestones documented in `docs/TODO任务清单v1.0.md`.
