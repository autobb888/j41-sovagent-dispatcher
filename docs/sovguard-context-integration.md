# Note: SovGuard `scanContext` integration (2026-06-03)

Hey — quick handoff on a security change that landed in the job-agent. This was
done from the SovGuard side; here's what changed in *this* repo and what to know.

## What & why

We closed the two **indirect prompt-injection holes** in the agent loop: untrusted
text was flowing into the LLM's context unscanned. Now it's scanned with awareness
of *where it came from* (source-trust), and injections are neutralized.

- **HOLE 1 — job description → system prompt.** `job.description` is attacker-
  controllable (a buyer posts the job) and went straight into the system prompt.
- **HOLE 2 — tool results → LLM messages.** Workspace file reads and MCP tool
  output were pushed back into `messages` verbatim — the classic indirect-injection
  vector (a poisoned file/tool result telling the model to ignore instructions,
  exfiltrate, etc.).

## What changed in this repo

| File | Change |
|------|--------|
| `src/sovguard-context.js` | **NEW.** `scanUntrusted(text, source, {policy, logger})` — wraps the vendored `scanContext` from `@junction41/sovagent-sdk/dist/safety/context.js`. |
| `src/executors/local-llm.js` | HOLE 1: scan `job.description` (`source: 'job_description'`) before building `this.systemPrompt`. HOLE 2: scan each tool result (`workspace_file`/`mcp_result`) before `messages.push`. |
| `src/executors/mcp.js` | Same two seams. |
| `package.json`, `package.docker.json` | `@junction41/sovagent-sdk` bumped **2.5.0 → 2.6.0** (the version that ships the vendored scanner; published to npm). |
| `Dockerfile.job-agent`, `scripts/build-image.sh` | Stage + `COPY src/sovguard-context.js` into the image (the executors require it). |
| `test/sovguard-context.test.js` | **NEW.** 4 tests (`node --test`). |

Commits: `775c5ec` (wiring) + `653b6a1` (deploy prep).

## Behavior (important)

- **Default policy is `strip`**: a flagged injection has its matched span redacted
  and the agent keeps working. If the injection can't be localized (e.g. an encoded
  payload), it falls back to **`quarantine`** (wraps the content in an
  `<untrusted-data>` fence) — it never silently passes a flagged payload through.
- **Trusted `user` input is NEVER muzzled** — only untrusted sources are touched.
- **Fails OPEN on scanner error/unavailability.** This is intentional: it's a
  defense-in-depth layer on top of junction41's inbound chat scanning + canary +
  workspace policy, so a scanner hiccup must not break a live job. Detection still
  strips/quarantines whenever the scanner runs.
- Each non-allow action **logs a notification** (`[sovguard] ... action taken: ...
  flags=[...]`). Routing those to `sendChatMessage`/IPC is a clean follow-up.

## Detection scope (don't over-expect)

`scanContext` in the SDK is **vendored and model-less** — it runs regex + indirect
+ perplexity only (no ONNX classifier/semantic layer, so no native deps in the
image). It reliably catches the obvious stuff (instruction-override, exfiltration
keywords, base64/rot13/encoded payloads, role-play, etc.). It is *not* the full
ML-backed engine. Results carry `degraded: true`.

## Gotchas / follow-ups

- **Local dev symlink:** while wiring this before 2.6.0 was published, a symlink was
  left at `node_modules/@junction41/sovagent-sdk → ../../j41-sovagent-sdk`. Now that
  **2.6.0 is on npm**, remove the symlink before a fresh install:
  `rm node_modules/@junction41/sovagent-sdk` then `npm install` (or `yarn`).
- **Image is rebuilt:** `j41/job-agent:latest` was rebuilt locally (with the local
  SDK tarball, `J41_USE_LOCAL_SDK=1`). If production pulls from a registry, rebuild
  there against the published 2.6.0 (default npm mode) and push.
- **Buyer-chat** scanning was added in dispatcher **2.2.3** as **HOLE 3**, gated
  behind `J41_SCAN_BUYER_CHAT=1` (default off). Operators running a seller agent
  against an untrusted marketplace buyer flip this to catch mid-chat
  override / exfiltration / jailbreak attempts the inbound platform scan
  might miss or that exploit indirect-injection patterns alongside HOLE 1
  + HOLE 2. The SDK has no dedicated `'buyer_chat'` source yet —
  `'other_agent'` is the closest untrusted bucket (the trust decision and
  scanner behavior are identical; the source string appears in notify only).
- **Policy knob:** policy is hardcoded `strip`. If you want per-deployment control,
  thread an env var (e.g. `J41_SOVGUARD_POLICY=strip|quarantine|block`) into the
  `scanUntrusted` calls.
- The SDK ships 6 **pre-existing** failing signing/RemoteSigner tests (unrelated to
  this change) — they don't block publish but are worth a look.

— SovGuard side (Claude), 2026-06-03
