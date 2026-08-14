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

Run a read-only M3/M4/M5 system, service, and targeted directory scan with SSH Agent authentication:

```powershell
pnpm dev -- scan --host server.example.com --user ops --accept-new-host-key
```

Or use a private key file:

```powershell
pnpm dev -- scan --host server.example.com --user ops --identity C:\Users\me\.ssh\id_ed25519 --accept-new-host-key
```

For trusted internal environments, a plaintext password can be supplied for the current process:

```powershell
pnpm dev -- scan --host server.example.com --user ops --password '<password>' --accept-new-host-key
```

Command-line passwords may be visible in shell history and process listings. OpSense does not write the password to its config, audit log, snapshot, or report files. The command writes `snapshot.json`, `meta.json`, and `audit.jsonl` under the local OpSense workspace. `analyze`, `report`, and `inspect` remain milestone placeholders.

M3 collection detects Debian, RHEL, Alpine, or an unknown Linux family from `/etc/os-release`. Logical probes use audited read-only fallback commands when JSON output, command options, or utilities are unavailable, and every attempted variant remains traceable in the snapshot evidence.

M4 adds systemd units, processes, listening sockets, Docker containers, and Compose projects. Process environment values are not read, Docker environment values are reduced to key names, and direct PID/container/socket ownership is preserved for later service normalization.

M5 derives path seeds from M4 runtime evidence and scans only those absolute paths. Directory reads are depth-, count-, output-, timeout-, and filesystem-bounded; pseudo filesystems, caches, source-control metadata, dependency trees, database internals, and container overlay layers are excluded. Small JSON, YAML, TOML, and INI files produce key-only structural summaries, while `.env` values are never read.
