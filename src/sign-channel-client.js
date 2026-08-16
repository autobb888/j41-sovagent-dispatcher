'use strict';
/**
 * sign-channel-client — the container-side end of the file-channel signing
 * broker. Implements the SDK's `RemoteSigner` shape:
 *
 *   { signMessage(message): Promise<string>,
 *     signBrokered(req): Promise<{ signature, timestamp, message }> }
 *
 * so a job-container's `J41Agent` constructed with `{ signer: client }`
 * routes every signing path to the dispatcher's host-side broker.
 *
 * The container has NO access to the agent's WIF — it only writes JSON
 * *into* a host-created `/app/sign/req/<id>.json` placeholder (`O_WRONLY`,
 * no create) and polls for `/app/sign/resp/<id>.json`. Names the host did
 * not pre-create are ignored host-side.
 *
 * Failure modes that callers should expect:
 *   - timeout (`SIGN_TIMEOUT`): the dispatcher didn't respond within `timeoutMs`.
 *   - policy reject (e.g. `JOB_MISMATCH`, `BAD_DELIVERY_HASH`,
 *     `PROTOCOL_SHAPED`, `MESSAGE_TOO_LARGE`): the broker refused.
 *   - transport (`CHANNEL_DOWN`): channel directory is missing — usually
 *     means the dispatcher tore down the container's channel mid-job.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** How often the client polls resp/ for its response (ms). The dispatcher
 *  responds within ~POLL_INTERVAL_MS (host-side poll) + signing latency
 *  (sub-ms), so 50ms here keeps tail latency near 250ms while avoiding a
 *  hot loop. */
const RESP_POLL_INTERVAL_MS = 50;

/** Default end-to-end timeout per sign request. */
const DEFAULT_TIMEOUT_MS = 10_000;

class SignChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'SignChannelError';
  }
}

class SignChannelClient {
  /**
   * @param {object} opts
   * @param {string} [opts.channelDir]  Container-side channel root. Defaults
   *                                    to `/app/sign` (the bind-mount path).
   * @param {number} [opts.timeoutMs]   Per-request timeout. Default 10s.
   * @param {string} [opts.reqPrefix]   If set (or `J41_SIGN_REQ_PREFIX` in
   *                                    env), only write into host slots whose
   *                                    filename starts with this prefix.
   */
  constructor({ channelDir = '/app/sign', timeoutMs = DEFAULT_TIMEOUT_MS, reqPrefix } = {}) {
    this.channelDir = channelDir;
    this.reqDir = path.join(channelDir, 'req');
    this.respDir = path.join(channelDir, 'resp');
    this.timeoutMs = timeoutMs;
    this.reqPrefix = reqPrefix || process.env.J41_SIGN_REQ_PREFIX || '';
  }

  /** RemoteSigner.signMessage — sign an arbitrary message. */
  async signMessage(message) {
    const res = await this._send('signMessage', { message });
    if (typeof res.signature !== 'string' || !res.signature) {
      throw new SignChannelError('BAD_RESPONSE', 'broker returned no signature');
    }
    return res.signature;
  }

  /**
   * Ask the dispatcher to perform a named on-chain action host-side. Used for
   * operations that need the WIF inline with tx-building (e.g. building +
   * broadcasting an `updateidentity` tx) — the container never sees the WIF.
   *
   * The dispatcher registers a finite set of executors (e.g.
   * `jobCompletionUpdate`) at channel construction time; any other `kind` is
   * rejected as `UNKNOWN_EXECUTOR`. The container has no way to invoke an
   * arbitrary host-side function — only the explicitly-listed kinds.
   *
   * @param {string} kind     The executor name (must be registered host-side).
   * @param {object} [params] Executor-specific parameters.
   * @returns {Promise<object>} The executor's result object (kind-specific).
   */
  async executeOnChain(kind, params = {}) {
    if (typeof kind !== 'string' || !kind) {
      throw new SignChannelError('BAD_REQUEST', 'executeOnChain: kind required');
    }
    const res = await this._send('executeOnChain', { kind, ...params });
    return res;
  }

  /** RemoteSigner.signBrokered — request the broker to sign a structured
   *  protocol message (accept/deliver/dispute_respond). */
  async signBrokered(req) {
    if (!req || typeof req !== 'object' || typeof req.type !== 'string') {
      throw new SignChannelError('BAD_REQUEST', 'signBrokered requires {type, ...}');
    }
    const res = await this._send('signBrokered', req);
    if (
      typeof res.signature !== 'string' || !res.signature ||
      typeof res.timestamp !== 'number' ||
      typeof res.message !== 'string'
    ) {
      throw new SignChannelError('BAD_RESPONSE', 'broker returned malformed brokered response');
    }
    return { signature: res.signature, timestamp: res.timestamp, message: res.message };
  }

  /**
   * Wire-level send: write req, poll for resp, parse, unwrap. Throws
   * `SignChannelError` on any failure including broker-side policy rejections
   * (so callers see the broker's `code` propagated as `err.code`).
   */
  async _send(method, params) {
    // Verify the channel exists — gives a clearer error than ENOENT-on-write.
    if (!fs.existsSync(this.reqDir) || !fs.existsSync(this.respDir)) {
      throw new SignChannelError(
        'CHANNEL_DOWN',
        `signing channel missing at ${this.channelDir} (req=${fs.existsSync(this.reqDir)}, resp=${fs.existsSync(this.respDir)})`,
      );
    }

    // Write *into* a host-created placeholder (O_WRONLY|O_TRUNC, no O_CREAT).
    // Creating a new name would be ignored by the host (`_ours`).
    const deadline = Date.now() + this.timeoutMs;
    const claimed = await this._claimAndWrite(method, params, deadline);
    const { id, reqPath, respPath } = claimed;

    let responseRaw = null;
    while (Date.now() < deadline) {
      try {
        responseRaw = await fsp.readFile(respPath, 'utf8');
        break;
      } catch (e) {
        if (e.code !== 'ENOENT') {
          throw new SignChannelError('READ_ERROR', e.message);
        }
        await new Promise((r) => setTimeout(r, RESP_POLL_INTERVAL_MS));
      }
    }

    if (responseRaw == null) {
      // Best-effort cleanup so a leaked req file doesn't sit around forever.
      fsp.unlink(reqPath).catch(() => {});
      throw new SignChannelError(
        'SIGN_TIMEOUT',
        `no response in ${this.timeoutMs}ms (req=${id}, method=${method})`,
      );
    }

    // Got a response — consume it.
    await fsp.unlink(respPath).catch(() => {});

    let response;
    try {
      response = JSON.parse(responseRaw);
    } catch (e) {
      throw new SignChannelError('BAD_JSON', `malformed broker response: ${e.message}`);
    }
    if (!response || typeof response !== 'object') {
      throw new SignChannelError('BAD_JSON', 'broker response not an object');
    }
    if (response.id !== id) {
      throw new SignChannelError('ID_MISMATCH', `expected id ${id}, got ${response.id}`);
    }
    if (response.ok === false) {
      const code = response.error?.code || 'BROKER_REJECTED';
      const message = response.error?.message || 'broker rejected the request';
      throw new SignChannelError(code, message);
    }
    if (response.ok !== true || !response.result) {
      throw new SignChannelError('BAD_RESPONSE', 'broker response missing result');
    }
    return response.result;
  }

  /**
   * Find an empty host-created slot and write the request in-place.
   * Never creates a new name (O_CREAT is not set). Claim is exclusive:
   * `link(req, req.claim)` is atomic (EEXIST → that slot is taken).
   */
  async _claimAndWrite(method, params, deadline) {
    while (Date.now() < deadline) {
      const slots = await this._listEmptySlots();
      for (const slot of slots) {
        const taken = await this._tryExclusiveWrite(slot, method, params);
        if (taken) return taken;
      }
      await new Promise((r) => setTimeout(r, RESP_POLL_INTERVAL_MS));
    }
    throw new SignChannelError(
      'SIGN_TIMEOUT',
      `no host-created request slot in ${this.timeoutMs}ms (method=${method})`,
    );
  }

  async _listEmptySlots() {
    let names;
    try {
      names = await fsp.readdir(this.reqDir);
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new SignChannelError(
          'CHANNEL_DOWN',
          `signing channel missing at ${this.channelDir}`,
        );
      }
      throw e;
    }
    const prefix = this.reqPrefix;
    const slots = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{8,80}\.json$/i.test(name)) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      const reqPath = path.join(this.reqDir, name);
      try {
        const st = await fsp.lstat(reqPath);
        if (!st.isFile() || st.size !== 0) continue;
      } catch {
        continue;
      }
      slots.push({
        id: name.replace(/\.json$/i, ''),
        reqPath,
        respPath: path.join(this.respDir, name),
      });
    }
    return slots;
  }

  /**
   * Atomically claim `slot` via a hardlink sibling, then write in-place.
   * Returns the slot on success, null if another claimer got there first.
   */
  async _tryExclusiveWrite(slot, method, params) {
    const claimPath = `${slot.reqPath}.claim`;
    try {
      await fsp.link(slot.reqPath, claimPath);
    } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'ENOENT') return null;
      throw new SignChannelError('WRITE_ERROR', e.message);
    }
    try {
      let st;
      try {
        st = await fsp.lstat(slot.reqPath);
      } catch {
        return null;
      }
      if (!st.isFile() || st.size !== 0) return null;
      const body = JSON.stringify({ id: slot.id, method, params });
      const fh = await fsp.open(
        slot.reqPath,
        fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      );
      try {
        await fh.writeFile(body, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      return slot;
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ELOOP') return null;
      throw new SignChannelError('WRITE_ERROR', e.message);
    } finally {
      await fsp.unlink(claimPath).catch(() => {});
    }
  }
}

module.exports = { SignChannelClient, SignChannelError, RESP_POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS };
