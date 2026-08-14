'use strict';
/**
 * Execution harness for the dispatcher's `start` action.
 *
 * ── Why this exists ──
 *
 * `start` is a ~1700-line closure inside `program.command('start').action(...)`.
 * Nothing could call it, so every test that claimed to cover it was a
 * source-text grep — and a grep for an identifier passes against `if (false)`.
 * Across five review rounds of 2.29.0 the defects that survived all of them were
 * in exactly this code, and they fell in a single pass to a reviewer who built a
 * throwaway harness and ran the real thing. This is that harness, kept.
 *
 * ── What is real and what is stubbed ──
 *
 *   REAL: the whole `start` action, commander parsing, the control plane, the
 *         health document, the egress proxy (bound on 127.0.0.1), every src/
 *         module, the on-disk `~/.j41` layout, the marker files.
 *   STUB: the SDK (see sdk-stub.js — audited), `@junction41/secure-setup`,
 *         dockerode, and the one `docker network inspect` shell-out that
 *         `isolatedGatewayIp()` makes.
 *   FAKE: time (see virtual-clock.js) and the chain (see fake-chain.js).
 *
 * The stub boundary is drawn at the process edge — network, containers, shell,
 * clock. Everything the dispatcher itself decides is executed for real.
 *
 * ── Order matters ──
 *
 * `src/cli.js` captures `os.homedir()` into module-level constants at load time,
 * and so do `src/config.js` and `src/config-loader.js`. The homedir override and
 * the module interception must BOTH be in place before the first require, and
 * the module cache must be dropped between scenarios or the second one silently
 * writes into the first one's temp dir. `harness.run()` handles both; do not
 * require cli.js yourself.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const Module = require('module');

const { installVirtualClock } = require('./virtual-clock');
const { createSdkStub } = require('./sdk-stub');

const REPO_SRC = path.resolve(__dirname, '..', '..', 'src');

// Captured before any scenario virtualises the timer globals — the harness's own
// polling must run on real event-loop turns, not on the fake clock it installs.
const setImmediateReal = global.setImmediate;

/** Reserve a free localhost port by binding and immediately releasing it. */
function reservePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function makeDockerStub(audit) {
  const container = new Proxy({}, {
    get: (_t, prop) => async (...args) => {
      audit.push({ call: `docker.container.${String(prop)}`, args });
      if (prop === 'inspect') return { State: { Running: false, ExitCode: 0 } };
      return null;
    },
  });
  const docker = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'getContainer') return () => container;
      if (prop === 'getImage') return () => container;
      if (prop === 'modem') return { followProgress: (_s, cb) => cb(null, []) };
      return async (...args) => {
        audit.push({ call: `docker.${String(prop)}`, args });
        if (prop === 'listContainers') return [];
        if (prop === 'listImages') return [];
        return null;
      };
    },
  });
  function Docker() { return docker; }
  return Docker;
}

/**
 * Build a `~/.j41` fixture.
 * @param {string} home
 * @param {object} opts
 * @param {Array<object>} opts.agents
 * @param {object} opts.ports
 * @param {object} [opts.configOverrides]  extra [runtime]/[platform] toml values
 * @param {object|null} [opts.shutdownMarker]  contents of shutdown-deactivated.json
 */
function writeFixture(home, opts) {
  const dispatcherDir = path.join(home, '.j41', 'dispatcher');
  const agentsDir = path.join(dispatcherDir, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true, mode: 0o700 });

  for (const a of opts.agents) {
    const dir = path.join(agentsDir, a.id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify({
      identity: a.identity,
      iAddress: a.iAddress,
      address: a.address || `R${a.id}addressplaceholder`,
      wif: a.wif || 'UwifPlaceholderNotUsedByTheStub',
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'finalize-state.json'), JSON.stringify({ stage: 'ready' }), { mode: 0o600 });
  }

  const cfg = [
    '[platform]',
    'api_url = "http://127.0.0.1:1/stub"',
    'network = "verustest"',
    '',
    '[runtime]',
    `health_port = ${opts.ports.health}`,
    `control_api_port = ${opts.ports.controlApi}`,
    'require_finalize = false',
    'skip_status_check = false',
    ...(opts.configLines || []),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dispatcherDir, 'config.toml'), cfg, { mode: 0o600 });

  // Skip the first-run security wizard — it is not what any of these scenarios
  // are about, and it shells out to sudo.
  fs.writeFileSync(path.join(home, '.j41', 'dispatcher-security-initialized'), 'harness');

  if (opts.shutdownMarker) {
    fs.writeFileSync(
      path.join(dispatcherDir, 'shutdown-deactivated.json'),
      JSON.stringify(opts.shutdownMarker),
      { mode: 0o600 },
    );
  }
  return { dispatcherDir, agentsDir };
}

class ExitCalled extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.name = 'ExitCalled';
    this.exitCode = code;
  }
}

/**
 * Run the real `start` action against a scenario.
 *
 * @param {object} scenario
 * @param {Array<object>} scenario.agents           [{ id, identity, iAddress, chainStatus, platformStatus }]
 * @param {object|null}   [scenario.shutdownMarker] shutdown-deactivated.json contents
 * @param {object}        [scenario.env]            extra process.env for the run
 * @param {Array<string>} [scenario.argv]           extra `start` flags
 * @param {object}        [scenario.sdk]            passed through to createSdkStub
 * @param {number}        [scenario.timeoutMs=20000] REAL-time budget for startup
 * @param {boolean}       [scenario.quiet=true]     swallow the dispatcher's stdout
 * @returns {Promise<object>} result — see the returned object's fields
 */
async function runStart(scenario = {}) {
  // `scenario.home` re-runs against a home a previous scenario left behind —
  // that is how "the repair failed; does the NEXT start retry it?" is expressed.
  // Marker files, seen-jobs and refund ledgers all carry over, exactly as they
  // would across a real restart.
  const reusing = !!scenario.home;
  const home = scenario.home || fs.mkdtempSync(path.join(os.tmpdir(), 'j41-harness-'));
  const ports = {
    health: await reservePort(),
    controlApi: await reservePort(),
    egress: await reservePort(),
  };
  if (!reusing) {
    writeFixture(home, {
      agents: scenario.agents,
      ports,
      configLines: scenario.configLines,
      shutdownMarker: scenario.shutdownMarker,
    });
  }

  const sideEffects = [];

  // ── Save everything we are about to replace ──
  const realHomedir = os.homedir;
  const realExit = process.exit;
  const realLoad = Module._load;
  const realEnv = { ...process.env };
  const sigListeners = {
    SIGINT: process.listeners('SIGINT').slice(),
    SIGTERM: process.listeners('SIGTERM').slice(),
  };
  const realConsole = { log: console.log, warn: console.warn, error: console.error };

  const output = [];
  const capture = (stream) => (...args) => {
    output.push({ stream, text: args.map(String).join(' ') });
    if (scenario.quiet === false) realConsole[stream](...args);
  };

  const exits = [];
  let clock = null;
  let cli = null;
  let sdk = null;
  let startError = null;
  let tornDown = false;

  function restoreConsole() {
    console.log = realConsole.log;
    console.warn = realConsole.warn;
    console.error = realConsole.error;
  }

  function restore() {
    if (clock) clock.uninstall();
    Module._load = realLoad;
    os.homedir = realHomedir;
    process.exit = realExit;
    restoreConsole();
    for (const sig of ['SIGINT', 'SIGTERM']) {
      for (const fn of process.listeners(sig)) {
        if (!sigListeners[sig].includes(fn)) process.removeListener(sig, fn);
      }
    }
    for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
    Object.assign(process.env, realEnv);
  }

  try {
    os.homedir = () => home;
    process.env.NODE_ENV = 'test';
    process.env.J41_EGRESS_PROXY_PORT = String(ports.egress);
    // Nothing in these scenarios should reach a real chat socket or a real node.
    process.env.J41_SIGNING_BROKER = process.env.J41_SIGNING_BROKER || '0';
    Object.assign(process.env, scenario.env || {});

    const realSdkIndex = require('@junction41/sovagent-sdk/dist/index.js');
    const DockerStub = makeDockerStub(sideEffects);

    console.log = capture('log');
    console.warn = capture('warn');
    console.error = capture('error');

    process.exit = (code) => {
      exits.push(code ?? 0);
      throw new ExitCalled(code ?? 0);
    };

    // KEEP THE PROCESS KILLABLE.
    //
    // The swallow is real and was reproduced under review; the chain is subtler
    // than "the handler calls process.exit and we made that throw":
    //
    //   SIGTERM → the action's handler → gracefulShutdown's no-active-jobs
    //   `process.exit(0)` throws ExitCalled inside an ASYNC body → the rejection
    //   lands in `.catch(onShutdownFailed)` → onShutdownFailed calls
    //   `process.exit(1)` → a SECOND ExitCalled, now inside the catch callback →
    //   unhandled rejection → cli.js's own handler logs it as "non-fatal".
    //
    // So neither the paused clock nor the timer-error absorber is required: the
    // exit override plus cli's rejection plumbing is sufficient on its own. The
    // vulnerable window is from where the action registers its signal handlers
    // (just before `startupComplete`) until teardown — milliseconds in a passing
    // test, but precisely where a post-startup hang parks the process, which is
    // how a mutation run sat unkillable holding a mutated source file.
    //
    // These listeners bypass the override entirely and call the REAL exit.
    // `restore()` drops them, because it removes every listener that was not
    // present in the snapshot taken above.
    const hardKill = (sig) => () => {
      try { restoreConsole(); } catch {}
      realExit(sig === 'SIGINT' ? 130 : 143);
    };
    process.on('SIGINT', hardKill('SIGINT'));
    process.on('SIGTERM', hardKill('SIGTERM'));

    // Install the clock BEFORE the stub is built: the fake chain stamps its
    // seeded pending writes from the first `Date.now()` it sees, and that must
    // be virtual time, not the wall clock of whoever ran the suite.
    clock = installVirtualClock({
      idleTicks: scenario.idleTicks ?? 3,
      onError: (e) => { sideEffects.push({ call: 'timerThrew', error: e.message }); },
    });
    sdk = createSdkStub({ agents: scenario.agents, ...(scenario.sdk || {}) });

    Module._load = function patchedLoad(rawRequest, parent, isMain) {
      // NORMALISE THE `node:` PREFIX BEFORE MATCHING.
      //
      // src/egress-proxy.js requires `node:child_process`, which this patch did
      // not match — so `isolatedGatewayIp()` shelled out to the REAL docker
      // daemon in every scenario and the egress proxy then bound on the host's
      // actual bridge (observed: 172.18.0.1). The suite silently depended on a
      // live docker daemon, a wedged one would cost 10s per scenario and blow the
      // real-time budget as a bogus "timedOut", and this file's own header
      // claimed that shell-out was stubbed. Builtins are requirable under both
      // spellings, so both must be matched.
      const request = typeof rawRequest === 'string' && rawRequest.startsWith('node:')
        ? rawRequest.slice(5)
        : rawRequest;
      if (request === '@junction41/sovagent-sdk/dist/index.js' || request === '@junction41/sovagent-sdk') {
        // Keep every real export (VDXF_KEYS, decodeContentMultimap, the message
        // builders) and replace only the two network-facing classes. A stub that
        // reimplemented the pure helpers would drift from the SDK silently.
        return { ...realSdkIndex, ...sdk.modules };
      }
      if (request === '@junction41/secure-setup') {
        return {
          setup: async () => ({ ok: true }),
          quickCheck: async () => ({ passed: true, score: 10, mode: 'harness', checks: [] }),
        };
      }
      if (request === '@junction41/sovagent-sdk/dist/chat/client.js') {
        // The real one opens a WebSocket. `start` calls `chat.connect()` in poll
        // mode too, as a supplement — so without this every scenario reaches the
        // network. (That is how the floating-promise crash in `start` was found.)
        return {
          ChatClient: class StubChatClient {
            constructor(cfg) { this.config = cfg || {}; sideEffects.push({ call: 'chat.new', args: [] }); }
            onJobStatusChanged() {}
            async connect() { sideEffects.push({ call: 'chat.connect', args: [] }); }
            async disconnect() {}
          },
        };
      }
      if (request === 'dockerode') return DockerStub;
      if (request === 'child_process') {
        const real = realLoad.call(this, request, parent, isMain);
        return new Proxy(real, {
          get(t, prop) {
            if (prop === 'execFileSync') {
              return (file, args) => {
                sideEffects.push({ call: 'execFileSync', args: [file, args] });
                if (file === 'docker' && Array.isArray(args) && args.includes('network')) return '127.0.0.1\n';
                throw new Error(`harness: unexpected execFileSync ${file}`);
              };
            }
            if (prop === 'spawn') {
              return (...a) => {
                sideEffects.push({ call: 'spawn', args: a });
                const { EventEmitter } = require('events');
                const child = new EventEmitter();
                child.stdout = new EventEmitter();
                child.stderr = new EventEmitter();
                child.kill = () => {};
                child.pid = 0;
                return child;
              };
            }
            return t[prop];
          },
        });
      }
      // Pass the ORIGINAL specifier through for anything we do not intercept, so
      // normalisation never changes resolution for a module we are not stubbing.
      return realLoad.call(this, rawRequest, parent, isMain);
    };

    // Drop any previously loaded copy of the dispatcher so this scenario's
    // homedir is the one its module-level constants capture.
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(REPO_SRC + path.sep)) delete require.cache[key];
    }
    cli = require(path.join(REPO_SRC, 'cli.js'));

    if (!cli.program || !cli.__getState) {
      throw new Error(
        'src/cli.js does not export `program` / `__getState` under NODE_ENV=test — the harness cannot drive the start action.',
      );
    }

    const argv = ['node', 'j41-dispatcher', 'start', ...(scenario.argv || [])];
    // The action never resolves: it ends in `await new Promise(() => {})`. We
    // watch for startupComplete instead, and only surface a rejection.
    cli.program.parseAsync(argv).catch((e) => {
      if (!(e instanceof ExitCalled)) startError = e;
    });

    // REAL-time budget. `Date.now()` is virtual from here on, so the only honest
    // wall-clock source left is performance.now().
    // 10s is ~30x the observed startup cost of a nine-agent scenario. Keep it
    // tight: when a change breaks startup, every scenario pays this budget, and
    // a suite that takes minutes to report a failure stops being run.
    const deadline = performance.now() + (scenario.timeoutMs ?? 10000);
    let state = null;
    let seeded = false;
    const macrotask = () => new Promise((r) => setImmediateReal(r));

    /**
     * Catch the state object the instant it exists.
     *
     * This MUST sweep at microtask granularity, and the reason is worth keeping:
     * a single-agent fleet hits none of the per-agent timer staggers (`if (i > 0)`),
     * and every stubbed SDK call resolves immediately — so the entire action, from
     * the state literal through the activation loop to `startupComplete`, can run
     * in one uninterrupted microtask drain. A `setImmediate` poll never gets a turn
     * inside that window, and `onStateReady` fired AFTER activation, silently
     * overwriting what the run had produced instead of seeding what it consumed.
     *
     * Yielding with `await Promise.resolve()` interleaves this loop with the
     * action's own awaits, which is the only way in from outside.
     */
    const seedIfReady = async () => {
      for (let i = 0; i < 512 && !seeded; i++) {
        const s = cli.__getState();
        if (s) {
          seeded = true;
          // FAIL LOUDLY IF WE ARRIVED TOO LATE. The 512-turn budget is the only
          // thing standing between this and the bug it was written to fix: if the
          // pre-state phase ever costs more turns than that, the sweep exhausts,
          // control yields a macrotask, and on a no-stagger fleet the state
          // literal AND the whole activation loop run inside that single gap —
          // so the seed lands after the code that was supposed to consume it and
          // the scenario quietly tests nothing. Today's gate scenarios use ~30-60
          // turns; more agents or more awaits before the state literal erode it.
          if (s.startupComplete === true && scenario.onStateReady) {
            throw new Error(
              'harness: onStateReady arrived after startup completed — raise the microtask sweep budget',
            );
          }
          if (scenario.onStateReady) scenario.onStateReady(s);
          return;
        }
        await Promise.resolve();
      }
    };

    await seedIfReady();
    while (performance.now() < deadline) {
      await seedIfReady();
      state = cli.__getState();
      if (state && state.startupComplete === true) break;
      if (exits.length || startError) break;
      await macrotask();
    }
    state = cli.__getState();
    // Freeze virtual time the moment startup settles. Otherwise the 60s poll and
    // status intervals keep firing through teardown, and assertions read a state
    // that has drifted minutes past the thing under test.
    clock.pause();

    const timedOut = !(state && state.startupComplete === true) && !exits.length && !startError;

    return {
      home,
      ports,
      state,
      sdk,
      chain: sdk.chain,
      clock,
      exits,
      startError,
      timedOut,
      sideEffects,
      output: output.map((o) => o.text),
      stdout: output.filter((o) => o.stream === 'log').map((o) => o.text).join('\n'),
      stderr: output.filter((o) => o.stream !== 'log').map((o) => o.text).join('\n'),
      /**
       * Substring search across everything the dispatcher printed UP TO the point
       * `runStart` returned. `output` above is a point-in-time copy, so anything
       * logged later — shutdown paths, late timer output — is invisible to it.
       * This one reads the live buffer so post-return output is searchable.
       */
      logged: (needle) => output.some((o) => o.text.includes(needle)),
      /** Contents of shutdown-deactivated.json after the run, or null. */
      shutdownMarker() {
        const p = path.join(home, '.j41', 'dispatcher', 'shutdown-deactivated.json');
        try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
      },
      /** The real health document, built by the real read-model builder. */
      health() {
        if (!state) return null;
        const control = require(path.join(REPO_SRC, 'control.js'));
        return control.buildHealthDocument(state, state.startedAt);
      },
      /**
       * Shut down servers, restore globals, delete the temp home.
       *
       * IDEMPOTENT, deliberately. A scenario that is torn down manually mid-test
       * must also be safe to register with `t.after`, because an assertion that
       * throws between the two would otherwise skip teardown entirely — leaving
       * the virtual clock installed and PAUSED, plus console/process.exit/
       * Module._load still patched. Every subsequent test in the file then hangs
       * on a clock that never advances, and the run has to be SIGKILLed. That
       * turns one honest assertion failure into an unreadable suite, which is
       * how a mutation-testing pass burned 100s and reported nothing.
       */
      async teardown() {
        if (tornDown) return;
        tornDown = true;
        try {
          const control = require(path.join(REPO_SRC, 'control.js'));
          if (state && state._controlServer) control.stopControlServer(state._controlServer);
        } catch { /* nothing bound */ }
        try {
          const api = require(path.join(REPO_SRC, 'control-api.js'));
          if (state && state._controlApi) api.stopControlApi(state._controlApi);
        } catch { /* nothing bound */ }
        try { if (state && state.egressProxy) state.egressProxy.stop(); } catch { /* not started */ }
        restore();
        if (!scenario.keepHome) {
          try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
        }
      },
    };
  } catch (e) {
    restore();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

module.exports = { runStart, reservePort, ExitCalled };
