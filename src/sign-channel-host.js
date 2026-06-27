'use strict';
/**
 * sign-channel-host — the dispatcher-side end of the file-channel signing
 * broker. Each job gets a dedicated channel:
 *
 *     host:        /tmp/j41-sign-<jobId>/{req,resp}/   (mode 0700)
 *     container:   /app/sign/{req,resp}/                (bind-mounted)
 *
 * The container's `SignChannelClient` writes a JSON request to `req/<id>.json`
 * and polls `resp/<id>.json` for the response. The dispatcher's
 * `SignChannelHost` watches `req/`, runs each request through the broker
 * policy with the agent's WIF (which never leaves the host), and writes the
 * response.
 *
 * Wire format:
 *   request:  { id, method: 'signBrokered' | 'signMessage', params }
 *   response: { id, ok: true,  result: {...} }
 *           | { id, ok: false, error: { code, message } }
 *
 * Writes use the rename-from-tmp pattern so the polling client never sees a
 * partial JSON file. Request files are deleted after response is written so
 * the directory can't accumulate.
 *
 * Security invariants:
 *   - WIF lives only in `SignChannelHost`'s closure; never written to a file,
 *     never sent across the channel.
 *   - The channel is pinned to one `jobId` at construction; any request whose
 *     brokered params reference a different jobId is rejected.
 *   - The watcher only reads files matching `<32hex-or-uuid>.json` to avoid
 *     accidental processing of unrelated files dropped into the dir.
 *   - The dispatcher fetches the authoritative job from the platform itself
 *     (via the `getJob` closure) — never trusts the request for fund-bearing
 *     fields.
 *   - On any unexpected error the response is { ok: false } so the container
 *     blocks rather than silently succeeds with no signature.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  signBrokeredRequest,
  signGenericMessage,
} = require('./sign-broker.js');

/** Filename pattern guarding the watcher against stray files. */
const REQ_FILENAME_RE = /^[a-f0-9-]{8,80}\.json$/i;

/** How often to scan the req/ dir for missed events (ms). fs.watch is the
 *  primary trigger; this is the belt-and-braces fallback for filesystems that
 *  don't emit reliably (some overlayfs configs). */
const POLL_INTERVAL_MS = 200;

class SignChannelHost {
  /**
   * @param {object} opts
   * @param {string} opts.channelDir   Host-side absolute path. {req,resp} are
   *                                   created inside if missing (mode 0700).
   * @param {string} opts.jobId        The job this channel is bound to. Any
   *                                   brokered request with a different jobId
   *                                   is rejected as JOB_MISMATCH.
   * @param {string} opts.wif          Agent's WIF. Held in closure; never logged
   *                                   or written to disk.
   * @param {'verus'|'verustest'} [opts.network]
   * @param {() => Promise<object>} opts.getJob  Async closure that returns the
   *                                   authoritative job record (id, jobHash,
   *                                   buyerVerusId, amount, currency). The
   *                                   dispatcher implements this against the
   *                                   platform API — NEVER trust the request
   *                                   for any of these fields.
   * @param {Record<string, (params: object, ctx: { wif: string, network: string, jobId: string, getJob: () => Promise<object> }) => Promise<object>>} [opts.executors]
   *                                   Named host-side executors for the
   *                                   `executeOnChain` channel method. The
   *                                   container can only invoke executors that
   *                                   are explicitly registered here (default-
   *                                   deny). Each executor receives the
   *                                   request `params` plus a `ctx` with the
   *                                   WIF + network + jobId + getJob lookup so
   *                                   it can build/broadcast on-chain ops
   *                                   without the container ever seeing the
   *                                   WIF. Throwing from an executor returns
   *                                   `{ ok: false, error: { code: 'EXECUTOR_ERROR', message } }`.
   * @param {(line: string) => void} [opts.log]  Structured-log sink.
   */
  constructor({ channelDir, jobId, wif, network = 'verustest', getJob, executors, log }) {
    if (!channelDir) throw new Error('SignChannelHost: channelDir required');
    if (!jobId) throw new Error('SignChannelHost: jobId required');
    if (typeof wif !== 'string' || wif.length === 0) {
      throw new Error('SignChannelHost: wif required');
    }
    if (typeof getJob !== 'function') {
      throw new Error('SignChannelHost: getJob(closure) required');
    }
    this.channelDir = channelDir;
    this.reqDir = path.join(channelDir, 'req');
    this.respDir = path.join(channelDir, 'resp');
    this.jobId = jobId;
    this._wif = wif;
    this.network = network;
    this.getJob = getJob;
    this.executors = executors || {};
    this.log = log || (() => {});
    this._watcher = null;
    this._pollTimer = null;
    this._inflight = new Set(); // request IDs currently being processed
    this._started = false;
    this._stopped = false;
  }

  /** Create the channel dir + start watching. Idempotent on second call. */
  async start() {
    if (this._started) return;
    this._started = true;

    // Audit 2026-06-02 L-DISPATCHER-auth-1: explicit mkdir + chmod on the
    // channel parent. Recursive mkdir applies mode 0o700 only to dirs it
    // CREATES — if /tmp/j41-sign-<jobId> already exists (e.g., from a
    // crashed previous instance) its mode is preserved, which may be looser
    // than 0o700. Set parent dir mode explicitly first.
    await fsp.mkdir(this.channelDir, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(this.channelDir, 0o700); } catch { /* not our dir */ }
    await fsp.mkdir(this.reqDir, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(this.reqDir, 0o700); } catch { /* not our dir */ }
    await fsp.mkdir(this.respDir, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(this.respDir, 0o700); } catch { /* not our dir */ }

    // Process anything already sitting in req/ before we started.
    await this._drainOnce().catch((e) => this.log(`[sign-channel] initial drain failed: ${e.message}`));

    // fs.watch for low-latency triggers.
    try {
      this._watcher = fs.watch(this.reqDir, { persistent: false }, (eventType, filename) => {
        if (filename) this._tryProcess(filename).catch(() => {});
      });
    } catch (e) {
      this.log(`[sign-channel] fs.watch unavailable (${e.message}); falling back to polling only`);
    }

    // Polling fallback for missed events (some overlayfs / bind-mount configs
    // don't surface inotify reliably).
    this._pollTimer = setInterval(() => {
      this._drainOnce().catch(() => {});
    }, POLL_INTERVAL_MS);
    this._pollTimer.unref();
  }

  /** Stop watching. Does NOT remove the channel directory — let the caller
   *  do that as part of container teardown. */
  async stop() {
    if (this._stopped) return;
    this._stopped = true;
    if (this._watcher) {
      try { this._watcher.close(); } catch { /* ignore */ }
      this._watcher = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Tear down the channel directory entirely. Use after `stop()` when the
   * container is gone. Best-effort — logs and continues on errors.
   */
  async destroy() {
    await this.stop();
    try {
      await fsp.rm(this.channelDir, { recursive: true, force: true });
    } catch (e) {
      this.log(`[sign-channel] failed to remove ${this.channelDir}: ${e.message}`);
    }
  }

  /** One sweep of req/ for any unprocessed files. */
  async _drainOnce() {
    if (this._stopped) return;
    let entries;
    try {
      entries = await fsp.readdir(this.reqDir);
    } catch (e) {
      if (e.code === 'ENOENT') return; // dir gone — channel destroyed
      throw e;
    }
    for (const name of entries) {
      if (!REQ_FILENAME_RE.test(name)) continue;
      // Don't await — process in parallel; _tryProcess gates by `_inflight`.
      this._tryProcess(name).catch(() => {});
    }
  }

  /** Process a single req file. Idempotent — safe to call multiple times for
   *  the same filename (the second call sees the file removed and exits). */
  async _tryProcess(filename) {
    if (this._stopped) return;
    if (!REQ_FILENAME_RE.test(filename)) return;
    if (this._inflight.has(filename)) return;
    this._inflight.add(filename);
    try {
      const reqPath = path.join(this.reqDir, filename);
      // Audit 2026-06-02 M-DISPATCHER-ddos-2: bound the per-request file size
      // BEFORE we read it. A misbehaving container can otherwise drop a
      // 100GB file into /app/sign and OOM the dispatcher. 256 KB is well
      // above any sensible sign-request payload.
      // Security (B1, 2026-06-23): open with O_NOFOLLOW so a malicious
      // container cannot plant a symlink in /app/sign/req/ that redirects to
      // a host path. ELOOP → refuse and log; ENOENT → silent return (race).
      // fstat on the fd closes the stat→read TOCTOU window.
      const MAX_SIGN_REQ_BYTES = Number(process.env.J41_SIGN_REQ_MAX_BYTES || 256 * 1024);
      let fh;
      try {
        fh = await fsp.open(reqPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch (e) {
        if (e.code === 'ELOOP') {
          this.log(`[sign-channel] refusing symlinked request ${filename}`);
          return;
        }
        if (e.code === 'ENOENT') return;
        this.log(`[sign-channel] open ${filename} failed: ${e.message}`);
        return;
      }
      let raw;
      try {
        const st = await fh.stat();
        if (st.size > MAX_SIGN_REQ_BYTES) {
          await this._writeResponse(filename.replace(/\.json$/, ''), {
            ok: false,
            error: { code: 'REQ_TOO_LARGE', message: `request exceeds ${MAX_SIGN_REQ_BYTES} bytes (${st.size})` },
          });
          await this._removeReq(reqPath);
          return;
        }
        // Security: bounded positional read — cap the read at MAX_SIGN_REQ_BYTES
        // even if the file grows between fstat and read (post-stat append).
        // fh.readFile() has no size cap and would read the full grown file.
        const buf = Buffer.alloc(Math.min(st.size, MAX_SIGN_REQ_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        raw = buf.subarray(0, bytesRead).toString('utf8');
      } catch (e) {
        // Transient FS hiccup — bail; the polling sweep will retry.
        if (e.code !== 'ENOENT') this.log(`[sign-channel] read ${filename} failed: ${e.message}`);
        return;
      } finally {
        await fh.close();
      }

      let req;
      try {
        req = JSON.parse(raw);
      } catch (e) {
        await this._writeResponse(filename.replace(/\.json$/, ''), {
          ok: false,
          error: { code: 'BAD_JSON', message: e.message },
        });
        await this._removeReq(reqPath);
        return;
      }

      // Audit 2026-06-02 H-DISPATCHER-2: validate req.id is a safe filename
      // before using it as the path component of the response file. A
      // container-controlled value otherwise enables arbitrary host-side file
      // write via path traversal (e.g. id = "../../../tmp/pwned" lands at
      // <respDir>/../../../tmp/pwned.json). Same character class as
      // REQ_FILENAME_RE, applied to the bare id (no .json suffix).
      const fallbackId = filename.replace(/\.json$/, '');
      const candidateId = (typeof req.id === 'string' && req.id.length > 0) ? req.id : fallbackId;
      const safeId = /^[a-f0-9-]{1,80}$/i.test(candidateId) ? candidateId : fallbackId;

      const response = await this._handle(req);
      await this._writeResponse(safeId, response);
      await this._removeReq(reqPath);
    } finally {
      this._inflight.delete(filename);
    }
  }

  /** Apply the broker policy to a parsed request. Pure function (no I/O
   *  besides `getJob`). */
  async _handle(req) {
    if (!req || typeof req !== 'object') {
      return { ok: false, error: { code: 'BAD_REQUEST', message: 'request must be an object' } };
    }
    const method = req.method;
    const params = req.params || {};

    if (method === 'signMessage') {
      const result = signGenericMessage({
        message: params.message,
        wif: this._wif,
        network: this.network,
      });
      if (!result.ok) return { ok: false, error: { code: result.code, message: result.reason } };
      return { ok: true, result: { signature: result.signature } };
    }

    if (method === 'executeOnChain') {
      // The container can only invoke executors that the dispatcher explicitly
      // registered at construction time (default-deny). The executor name is
      // the ONLY way the container reaches host-side code; we don't allow
      // arbitrary function names.
      const kind = params.kind;
      // Security: use own-property check so prototype-inherited names like
      // 'constructor', 'hasOwnProperty', 'toString', 'valueOf' cannot bypass
      // the default-deny registry and resolve to a callable host function.
      if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(this.executors, kind)) {
        return {
          ok: false,
          error: { code: 'UNKNOWN_EXECUTOR', message: `no executor registered for kind: ${kind}` },
        };
      }
      const ctx = {
        wif: this._wif,
        network: this.network,
        jobId: this.jobId,
        getJob: this.getJob,
      };
      try {
        const result = await this.executors[kind](params, ctx);
        return { ok: true, result: result || {} };
      } catch (e) {
        return { ok: false, error: { code: 'EXECUTOR_ERROR', message: e.message } };
      }
    }

    if (method === 'signBrokered') {
      // The broker reconstructs the message from the authoritative job —
      // we fetch it fresh per request (cheap, and ensures we have the latest
      // state for jobHash / buyer / amount).
      let job;
      try {
        job = await this.getJob();
      } catch (e) {
        return { ok: false, error: { code: 'JOB_LOOKUP_FAILED', message: e.message } };
      }
      // The channel is pinned to this.jobId; reject anything with a different
      // jobId in the request as a sanity check (sign-broker.js also checks).
      if (params.jobId && params.jobId !== this.jobId) {
        return {
          ok: false,
          error: { code: 'CHANNEL_JOB_MISMATCH', message: `channel is bound to ${this.jobId}, request asked for ${params.jobId}` },
        };
      }
      const result = signBrokeredRequest({
        job,
        request: params,
        wif: this._wif,
        network: this.network,
      });
      if (!result.ok) return { ok: false, error: { code: result.code, message: result.reason } };
      return {
        ok: true,
        result: {
          signature: result.signature,
          timestamp: result.timestamp,
          message: result.message,
        },
      };
    }

    return { ok: false, error: { code: 'BAD_METHOD', message: `unknown method: ${method}` } };
  }

  /** Atomic-rename write of resp/<id>.json — the polling client never sees a
   *  partial file. */
  async _writeResponse(id, payload) {
    const finalPath = path.join(this.respDir, `${id}.json`);
    const tmpPath = path.join(this.respDir, `.${id}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const body = JSON.stringify({ id, ...payload });
    await fsp.writeFile(tmpPath, body, { mode: 0o600 });
    await fsp.rename(tmpPath, finalPath);
  }

  /** Best-effort delete of a processed request file. */
  async _removeReq(reqPath) {
    try { await fsp.unlink(reqPath); }
    catch (e) { if (e.code !== 'ENOENT') this.log(`[sign-channel] unlink ${reqPath} failed: ${e.message}`); }
  }
}

module.exports = { SignChannelHost, REQ_FILENAME_RE, POLL_INTERVAL_MS };
