# Jailbox (legacy "workspace") — PARKED

**Decision (2026-06-12):** the "agent works inside the buyer's environment"
sandbox — the **jailbox** (the dispatcher's `workspace.*` code) — is **parked**
in favour of **deliver-and-review**. It is **default-OFF**, **not deleted**, and
**re-enablable** behind one feature flag.

Rationale lives in `docs/superpowers/specs/2026-06-12-vdxf-v2-schema-design.md`
§3b ("jailbox.* PARKED") in the junction41 repo. In short: admitting an unknown
agent into the buyer's trust boundary is the one capability pulling against the
rest of the trust stack — the safest access is no access. Default execution is
now deliver-and-review: the agent delivers a verifiable artifact the buyer
reviews in their own trust domain (SovGuard scans buyer-side), never an agent
admitted into the buyer's machine.

## How it is parked

A single config flag gates **only the session entry point** — no jailbox
internals were refactored.

- **Config:** `jailbox.enabled` in `src/config-loader.js`, **default `false`**.
- **Env:** `JAILBOX_ENABLED=1` re-enables it (`bool1` coercion, same as
  `J41_DEBUG_CHAT`). Or set `[jailbox] enabled = true` in `config.toml`.
- **Dispatcher gate:** `checkWorkspaceCapability()` in `src/cli.js` — the single
  choke point every `workspace_ready` forward passes through — returns `false`
  with a clear `[JAILBOX]` log when the flag is off, so no jailbox session is
  started.
- **In-container gate:** `connectWorkspace()` in `src/job-agent.js` — the single
  funnel every start path (IPC `workspace_ready`, the Docker status poller,
  re-entry) routes through — refuses to connect unless `process.env.JAILBOX_ENABLED
  === '1'`. The dispatcher forwards the flag into the container env via
  `buildContainerEnv()` (Docker is the container's only env channel, and its
  poller talks to the platform directly, bypassing the dispatcher-side gate).

When the flag is **on**, behaviour is **unchanged**.

## What is retained (NOT touched)

The **audit-log / attestation machinery is kept fully intact** — the
hash-chained, party-signed session log is repurposed as **proof-of-process** for
any work session. Nothing in the workspace attestation path
(`workspaceAttestation` building at job completion in `src/job-agent.js`, the
on-chain `record` additions, the migration-034 audit log on the backend) was
changed. Only the *entry point* that starts a jailbox session is gated.

## Re-enabling

```sh
JAILBOX_ENABLED=1 j41-dispatcher start
```

or in `~/.j41/dispatcher/config.toml`:

```toml
[jailbox]
enabled = true
```
