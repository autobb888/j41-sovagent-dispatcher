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
 * requests to `/app/sign/req/<id>.json` and polls for `/app/sign/resp/<id>.json`.
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
const crypto = require('node:crypto');

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
   */
  constructor({ channelDir = '/app/sign', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.channelDir = channelDir;
    this.reqDir = path.join(channelDir, 'req');
    this.respDir = path.join(channelDir, 'resp');
    this.timeoutMs = timeoutMs;
  }

  /** RemoteSigner.signMessage — sign an arbitrary message. */
  async signMessage(message) {
    const res = await this._send('signMessage', { message });
    if (typeof res.signature !== 'string' || !res.signature) {
      throw new SignChannelError('BAD_RESPONSE', 'broker returned no signature');
    }
    return res.signature;
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

    const id = crypto.randomUUID().replace(/-/g, ''); // 32 hex chars
    const reqPath = path.join(this.reqDir, `${id}.json`);
    const respPath = path.join(this.respDir, `${id}.json`);

    // Atomic write so the dispatcher's reader never sees a partial file.
    const tmpPath = path.join(this.reqDir, `.${id}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    const body = JSON.stringify({ id, method, params });
    await fsp.writeFile(tmpPath, body, { mode: 0o600 });
    await fsp.rename(tmpPath, reqPath);

    const deadline = Date.now() + this.timeoutMs;
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
}

module.exports = { SignChannelClient, SignChannelError, RESP_POLL_INTERVAL_MS, DEFAULT_TIMEOUT_MS };
