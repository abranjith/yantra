// Spike S2 (FEAT-064 TASK-001): detached worker and recovery on Windows, macOS and Linux.
// Throwaway evidence harness — not product code. Requires `@yantra/core` to be built.
//
//   node e2e/spikes/s2-worker-recovery/run-spike.mjs [--only 1,3] [--out results.json]
//        [--summary summary.md] [--chrome <executable>]
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EventLog,
  allocateAddress,
  connectRaw,
  socketsRoot,
  startRunServer,
} from './lib/channel.mjs';
import { encodeJson, encodeRaw } from './lib/frame.mjs';
import {
  IS_WIN,
  atomicReplace,
  exclusivePublish,
  hardKill,
  isAlive,
  now,
  percentile,
  pidsWithMarker,
  readCompleteLines,
  readJson,
  sleep,
  treeKill,
  waitFor,
} from './lib/util.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const actors = join(here, 'actors');
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1];
};
const only = arg('--only')?.split(',') ?? null;
process.env.S2_ENV_PROBE = 'inherited';
const work = mkdtempSync(join(tmpdir(), 'yantra-s2-'));
const yantraHome = join(work, 'home');
mkdirSync(yantraHome, { recursive: true });
const results = [];
const leftovers = new Set();

function record(scenario, name, { expected = null, actual, pass = null, details = {} }) {
  results.push({ scenario, name, expected, actual, pass, details });
  const mark = pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${scenario} ${name}: ${JSON.stringify(actual)}`);
}

function check(scenario, name, expected, actual, details = {}) {
  record(scenario, name, { expected, actual, pass: expected === actual, details });
}

let runCounter = 0;
function newRun(options = {}) {
  runCounter += 1;
  const runId = `run-${runCounter}-${randomBytes(3).toString('hex')}`;
  const runDir = join(yantraHome, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  const launchFile = join(yantraHome, 'launch', `${runId}.launch.json`);
  mkdirSync(dirname(launchFile), { recursive: true });
  writeFileSync(
    launchFile,
    JSON.stringify({ runId, runDir, yantraHome, events: 300, intervalMs: 10, ...options }),
    { mode: 0o600, flag: 'wx' },
  );
  return { runId, runDir, launchFile, out: join(runDir, 'pids.json') };
}

function spawnNode(script, args, options = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: 'ignore',
    windowsHide: true,
    ...options,
  });
  leftovers.add(child.pid);
  return child;
}

async function launch(run, { via = 'direct', stay = false } = {}) {
  const args = ['--launch', run.launchFile, '--out', run.out, '--via', via];
  if (stay) args.push('--stay');
  const launcher = spawnNode(join(actors, 'launcher.mjs'), args);
  const pids = await waitFor(() => readJson(run.out), 30_000);
  if (pids?.workerPid) leftovers.add(pids.workerPid);
  return { launcher, pids };
}

const waitDone = (run, ms = 60_000) =>
  waitFor(() => readJson(join(run.runDir, 'done.json')), ms, 50);

async function waitDead(pid, ms) {
  return (await waitFor(() => !isAlive(pid), ms, 50)) === true;
}

// ---------------------------------------------------------------------------------------------
// Scenario 1 — detached spawn survival.
// ---------------------------------------------------------------------------------------------
async function scenario1() {
  {
    const run = newRun();
    const { pids } = await launch(run);
    const done = await waitDone(run);
    check('1a', 'worker survives the parent exiting normally', true, done !== null, {
      pids,
      inheritedEnv: readJson(join(run.runDir, 'worker-ready.json'))?.inheritedEnv,
    });
  }
  {
    const run = newRun();
    const { launcher, pids } = await launch(run, { stay: true });
    hardKill(launcher.pid);
    const launcherDead = await waitDead(launcher.pid, 5_000);
    const done = await waitDone(run);
    check(
      '1b',
      `worker survives a hard kill of the parent (${IS_WIN ? 'taskkill /F' : 'SIGKILL'})`,
      true,
      launcherDead && done !== null,
      {
        launcherDead,
        pids,
      },
    );
  }
  await scenario1Terminal();
  for (const via of ['direct', 'trampoline']) {
    const run = newRun();
    const { launcher } = await launch(run, { stay: true, via });
    const pids = await waitFor(() => readJson(run.out), 15_000);
    if (pids?.workerPid) leftovers.add(pids.workerPid);
    await waitFor(() => existsSync(join(run.runDir, 'worker-ready.json')), 30_000);
    treeKill(launcher.pid);
    await sleep(1_000);
    const workerAlive = isAlive(pids?.workerPid);
    const done = await waitDone(run, 30_000);
    record(
      '1d',
      `tree kill of a live parent (${IS_WIN ? 'taskkill /T /F' : 'kill -<pgid>'}), spawn ${via}`,
      {
        expected: via === 'trampoline' || !IS_WIN ? 'survives' : null,
        actual: done !== null ? 'survives' : 'killed',
        pass: via === 'trampoline' || !IS_WIN ? done !== null : null,
        details: { workerAliveAfter1s: workerAlive },
      },
    );
  }
  if (IS_WIN) await scenario1Jobs();
}

async function scenario1Terminal() {
  const run = newRun();
  const launcherArgs = [
    join(actors, 'launcher.mjs'),
    '--launch',
    run.launchFile,
    '--out',
    run.out,
    '--stay',
  ];
  if (process.platform === 'linux' || process.platform === 'darwin') {
    const quoted = [process.execPath, ...launcherArgs]
      .map((s) => `'${s.replace(/'/g, "'\\''")}'`)
      .join(' ');
    const scriptArgs =
      process.platform === 'linux'
        ? ['-qfec', quoted, '/dev/null']
        : ['-q', '/dev/null', process.execPath, ...launcherArgs];
    const term = spawn('script', scriptArgs, {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
    leftovers.add(term.pid);
    const pids = await waitFor(() => readJson(run.out), 30_000);
    if (!pids) {
      record('1c', 'worker survives closing the launching terminal (pty hang-up)', {
        actual: 'not simulated: launcher did not start under script(1)',
      });
      return;
    }
    leftovers.add(pids.workerPid);
    hardKill(term.pid); // The terminal goes away: the pty master closes and the session gets SIGHUP.
    const launcherDead = await waitDead(pids.launcherPid, 5_000);
    const done = await waitDone(run);
    record('1c', 'worker survives closing the launching terminal (pty hang-up)', {
      expected: true,
      actual: done !== null,
      pass: launcherDead ? done !== null : null,
      details: { launcherDiedFromHangup: launcherDead },
    });
    return;
  }
  // Windows: a new console window via `start`, closed with WM_CLOSE to its console host exactly
  // as clicking its X does. Where Windows Terminal is the default terminal (Windows 11 desktops)
  // the console is delegated and the launcher does not die, so the row is reported "info".
  const q = (s) => `"${s}"`;
  const command = `/d /s /c "start "s2" /min ${[process.execPath, ...launcherArgs].map(q).join(' ')}"`;
  spawn('cmd.exe', [command], {
    windowsVerbatimArguments: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  const pids = await waitFor(() => readJson(run.out), 30_000);
  if (!pids) {
    record('1c', 'worker survives closing the launching console window', {
      actual: 'not simulated: start failed',
    });
    return;
  }
  leftovers.add(pids.workerPid);
  leftovers.add(pids.launcherPid);
  await sleep(500);
  const consoleHosts = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pids.launcherPid}" | Where-Object { $_.Name -match 'conhost|OpenConsole' } | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .split(/\r?\n/)
    .map(Number)
    .filter((n) => n > 0);
  let posted = 0;
  for (const hostPid of consoleHosts) {
    posted += Number(
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(actors, 'job.ps1'),
          '-Mode',
          'close-window',
          '-WindowPid',
          String(hostPid),
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim(),
    );
  }
  let method = `WM_CLOSE to ${posted} window(s) of ${consoleHosts.length} console host(s)`;
  let launcherDead = await waitDead(pids.launcherPid, 10_000);
  if (!launcherDead) {
    method += '; then console host killed';
    for (const hostPid of consoleHosts) hardKill(hostPid);
    launcherDead = await waitDead(pids.launcherPid, 10_000);
  }
  const done = await waitDone(run);
  record('1c', 'worker survives closing the launching console window', {
    expected: true,
    actual: done !== null,
    pass: launcherDead ? done !== null : null,
    details: { method, launcherDiedWithConsole: launcherDead },
  });
}

async function scenario1Jobs() {
  const probe = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(actors, 'job.ps1'),
      '-Mode',
      'probe',
    ],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
  const parsed = JSON.parse(probe);
  record('1e', 'environment: is this harness inside a Job object?', {
    actual: parsed,
    details: {
      killOnClose: parsed.limitFlags !== undefined ? (parsed.limitFlags & 0x2000) !== 0 : null,
      breakawayOk: parsed.limitFlags !== undefined ? (parsed.limitFlags & 0x800) !== 0 : null,
      silentBreakawayOk:
        parsed.limitFlags !== undefined ? (parsed.limitFlags & 0x1000) !== 0 : null,
    },
  });
  const cases = [
    { label: 'KILL_ON_JOB_CLOSE, direct spawn', flags: 0x2000, via: 'direct', expected: null },
    {
      label: 'KILL_ON_JOB_CLOSE + BREAKAWAY_OK, direct spawn',
      flags: 0x2000 | 0x800,
      via: 'direct',
      expected: null,
    },
    {
      label: 'KILL_ON_JOB_CLOSE + SILENT_BREAKAWAY_OK, direct spawn',
      flags: 0x2000 | 0x1000,
      via: 'direct',
      expected: 'survives',
    },
    {
      label: 'KILL_ON_JOB_CLOSE, WMI Win32_Process.Create spawn',
      flags: 0x2000,
      via: 'wmi',
      expected: null,
    },
  ];
  for (const c of cases) {
    const run = newRun();
    const output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(actors, 'job.ps1'),
        '-Mode',
        'run',
        '-Flags',
        String(c.flags),
        '-Node',
        process.execPath,
        '-Launcher',
        join(actors, 'launcher.mjs'),
        '-LaunchFile',
        run.launchFile,
        '-Out',
        run.out,
        '-Via',
        c.via,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
    ).trim();
    const pids = readJson(run.out);
    if (pids?.workerPid) leftovers.add(pids.workerPid);
    const done = await waitDone(run, 30_000);
    record('1e', `worker inside a job: ${c.label}`, {
      expected: c.expected,
      actual: done !== null ? 'survives' : 'killed',
      pass: c.expected === null ? null : (done !== null) === (c.expected === 'survives'),
      details: {
        harness: output.split(/\r?\n/).pop(),
        worker: readJson(join(run.runDir, 'worker-ready.json')),
      },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Scenario 2 — run socket: placement, auth and framing.
// ---------------------------------------------------------------------------------------------
async function scenario2() {
  if (IS_WIN) await scenario2Pipes();
  else await scenario2UnixPaths();
  await scenario2Auth();
}

function tryListen(address) {
  return new Promise((resolve) => {
    const server = createServer((c) => c.end());
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(address, () => resolve({ ok: true, server }));
  });
}

async function scenario2UnixPaths() {
  const base = mkdtempSync(join('/tmp', 's2p-'));
  const outcomes = [];
  for (let length = 96; length <= 112; length += 1) {
    const pad = length - Buffer.byteLength(base) - '/.sock'.length;
    const address = join(base, `${'x'.repeat(pad)}.sock`);
    const listened = await tryListen(address);
    let connected = false;
    let exact = false;
    if (listened.ok) {
      exact = existsSync(address);
      connected = await connectRaw(address)
        .then((s) => (s.conn.destroy(), true))
        .catch(() => false);
      listened.server.close();
    }
    outcomes.push({
      length: Buffer.byteLength(address),
      listen: listened.ok ? 'ok' : listened.code,
      exactPath: exact,
      connected,
    });
  }
  const working = outcomes
    .filter((o) => o.listen === 'ok' && o.exactPath && o.connected)
    .map((o) => o.length);
  const silentTruncation = outcomes.some((o) => o.listen === 'ok' && !o.exactPath);
  record('2a', 'max usable Unix socket path length (bytes)', {
    actual: working.length > 0 ? Math.max(...working) : null,
    details: { silentTruncation, outcomes },
  });
  check(
    '2a',
    'an over-limit socket path fails loudly, never truncated silently',
    false,
    silentTruncation,
  );

  const deepHome = join(work, 'd'.repeat(Math.max(1, 90 - Buffer.byteLength(work))));
  mkdirSync(deepHome, { recursive: true });
  const fallbackRoot = socketsRoot(deepHome);
  const fallbackAddress = join(fallbackRoot, `${'f'.repeat(24)}.sock`);
  const fellBack = !fallbackRoot.startsWith(deepHome);
  const listened = await tryListen(fallbackAddress);
  if (listened.ok) listened.server.close();
  check(
    '2a',
    'deep YANTRA_HOME falls back to <tmpdir>/yantra-<uid> and the socket binds',
    true,
    fellBack && listened.ok,
    {
      homeBytes: Buffer.byteLength(deepHome),
      fallbackRoot,
      fallbackAddressBytes: Buffer.byteLength(fallbackAddress),
      tmpdir: tmpdir(),
    },
  );
  const shortHome = join(work, 'h');
  const normalRoot = socketsRoot(shortHome);
  record('2a', 'normal socket address length under the default home', {
    actual: Buffer.byteLength(join(normalRoot, `${'a'.repeat(24)}.sock`)),
    details: { normalRoot },
  });

  const loose = join(work, 'loose');
  mkdirSync(join(loose, 'run'), { recursive: true, mode: 0o750 });
  execFileSync('chmod', ['750', join(loose, 'run')]);
  const looseRefused = (() => {
    try {
      socketsRoot(loose);
      return false;
    } catch {
      return true;
    }
  })();
  check('2a', 'socket directory with group bits is refused', true, looseRefused);
  const linked = join(work, 'linked');
  mkdirSync(linked, { recursive: true });
  mkdirSync(join(work, 'elsewhere'), { recursive: true, mode: 0o700 });
  symlinkSync(join(work, 'elsewhere'), join(linked, 'run'));
  const symlinkRefused = (() => {
    try {
      socketsRoot(linked);
      return false;
    } catch {
      return true;
    }
  })();
  check('2a', 'symlinked socket directory is refused', true, symlinkRefused);
  rmSync(base, { recursive: true, force: true });
}

async function scenario2Pipes() {
  const address = allocateAddress(yantraHome);
  const started = now();
  const listened = await tryListen(address.address);
  const listenMs = now() - started;
  const connectStarted = now();
  const connected = listened.ok
    ? await connectRaw(address.address)
        .then((s) => (s.conn.destroy(), true))
        .catch(() => false)
    : false;
  const second = listened.ok ? await tryListen(address.address) : { ok: false };
  if (second.ok) second.server.close();
  if (listened.ok) listened.server.close();
  check('2b', 'random named pipe listens and accepts', true, listened.ok && connected, {
    address: address.address.replace(/[0-9a-f]{32}$/, '<32 hex>'),
    listenMs,
    connectMs: now() - connectStarted,
  });
  check('2b', 'a second listener on the same pipe name is refused', false, second.ok, {
    code: second.code,
  });
}

async function scenario2Auth() {
  const dir = join(work, 'auth');
  mkdirSync(dir, { recursive: true });
  const log = new EventLog(join(dir, 'run-events.jsonl'));
  for (let i = 0; i < 20; i += 1) log.append({ type: 'progress', n: i });
  const token = randomBytes(32).toString('base64url');
  const socket = allocateAddress(join(work, 'h'));
  const { server, stats } = await startRunServer({ socket, token, log, helloDeadlineMs: 500 });

  const attempt = async (label, act) => {
    const state = await connectRaw(socket.address);
    const started = now();
    await act(state);
    await waitFor(() => state.closed, 3_000);
    check(
      '2c',
      `unauthenticated client gets 0 bytes: ${label}`,
      '0 bytes, closed',
      `${state.bytes} bytes, ${state.closed ? 'closed' : 'open'}`,
      {
        closeMs: now() - started,
      },
    );
  };
  await attempt('no hello within the deadline', () => Promise.resolve());
  await attempt('wrong token (same length)', async (s) =>
    s.conn.write(
      encodeJson({
        type: 'hello',
        token: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
        channel_version: 1,
      }),
    ),
  );
  await attempt('token of a different length', async (s) =>
    s.conn.write(encodeJson({ type: 'hello', token: 'short', channel_version: 1 })),
  );
  await attempt('non-hello first frame', async (s) =>
    s.conn.write(encodeJson({ type: 'subscribe', from_seq: 1 })),
  );
  await attempt('17 KiB first frame header', async (s) => {
    const header = Buffer.alloc(5);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(17 * 1024, 1);
    s.conn.write(header);
  });
  await attempt('garbage type byte', async (s) => s.conn.write(encodeRaw(0x7f, Buffer.from('{}'))));

  // Fragmented hello (one byte at a time), then three coalesced frames in one write.
  const state = await connectRaw(socket.address);
  const hello = encodeJson({ type: 'hello', token, channel_version: 1, capabilities: ['events'] });
  for (const byte of hello) {
    state.conn.write(Buffer.from([byte]));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await waitFor(() => state.frames.some((f) => f.message?.type === 'hello_ok'), 3_000);
  state.conn.write(
    Buffer.concat([
      encodeJson({ type: 'subscribe', from_seq: 1 }),
      encodeJson({ type: 'ping' }),
      encodeJson({ type: 'ping' }),
    ]),
  );
  await waitFor(() => state.frames.filter((f) => f.message?.type === 'event').length >= 20, 3_000);
  await waitFor(() => state.frames.filter((f) => f.message?.type === 'pong').length >= 2, 3_000);
  const seqs = state.frames.filter((f) => f.message?.type === 'event').map((f) => f.message.seq);
  check(
    '2d',
    'hello delivered one byte at a time is decoded',
    true,
    state.frames[0]?.message?.type === 'hello_ok',
  );
  check(
    '2d',
    'three coalesced frames each answered (20 events, 2 pongs)',
    '20/2',
    `${seqs.length}/${state.frames.filter((f) => f.message?.type === 'pong').length}`,
  );
  const unsupported = await (async () => {
    state.conn.write(encodeJson({ type: 'intervention.answer', id: 'x' }));
    await waitFor(() => state.frames.some((f) => f.message?.type === 'error'), 2_000);
    return state.frames.find((f) => f.message?.type === 'error')?.message?.code;
  })();
  check(
    '2d',
    'unknown message type gets error{unsupported} and the connection survives',
    'unsupported/open',
    `${unsupported}/${state.closed ? 'closed' : 'open'}`,
  );
  state.conn.destroy();
  record('2c', 'server rejection counters', { actual: stats.rejected });
  server.close();
  log.close();
}

// ---------------------------------------------------------------------------------------------
// Scenarios 3 and 4 — host death and reattach; approval across reconnect.
// ---------------------------------------------------------------------------------------------
async function scenario3and4() {
  await reattachRun({ drainOnExit: true });
  await reattachRun({ drainOnExit: false });
}

async function reattachRun({ drainOnExit }) {
  const run = newRun({ events: 600, intervalMs: 10, approval: true, drainOnExit });
  const { pids } = await launch(run);
  await waitFor(() => readJson(join(run.runDir, 'lease.json')), 30_000);
  const h1Record = join(run.runDir, 'host1.seqs');
  const host1 = spawnNode(join(actors, 'host.mjs'), [
    '--run-dir',
    run.runDir,
    '--from',
    '1',
    '--record',
    h1Record,
  ]);
  await waitFor(() => readCompleteLines(h1Record).length >= 150, 30_000);
  hardKill(host1.pid);
  await waitDead(host1.pid, 5_000);
  const h1 = readCompleteLines(h1Record).map(Number);
  const from = (h1.at(-1) ?? 0) + 1;
  await sleep(1_500); // Let a backlog build, so the replay runs while the worker keeps emitting.
  const fileSeqAtReattach = readCompleteLines(join(run.runDir, 'run-events.jsonl')).length;

  const h2Record = join(run.runDir, 'host2.seqs');
  const answersOut = join(run.runDir, 'host2.answers.json');
  const host2 = spawnNode(join(actors, 'host.mjs'), [
    '--run-dir',
    run.runDir,
    '--from',
    String(from),
    '--record',
    h2Record,
    '--answer',
    '--answers-out',
    answersOut,
  ]);
  const host2Exit = new Promise((resolve) => host2.once('exit', resolve));

  // A third client answers the same item after host2 did: it must get already_decided.
  await waitFor(() => readCompleteLines(h2Record).length >= 20, 30_000);
  await sleep(200);
  const lease = readJson(join(run.runDir, 'lease.json'));
  let thirdResult = null;
  if (lease) {
    const third = await connectRaw(lease.socket.address);
    third.conn.write(encodeJson({ type: 'hello', token: lease.run_token, channel_version: 1 }));
    await waitFor(() => third.frames.some((f) => f.message?.type === 'hello_ok'), 3_000);
    third.conn.write(encodeJson({ type: 'answer', id: 'c1', decision: 'deny' }));
    await waitFor(() => third.frames.some((f) => f.message?.type === 'answer_result'), 3_000);
    thirdResult =
      third.frames.find((f) => f.message?.type === 'answer_result')?.message?.result ?? null;
    third.conn.destroy();
  }

  const exitCode = await Promise.race([host2Exit, sleep(60_000).then(() => 'timeout')]);
  const h2 = readCompleteLines(h2Record).map(Number);
  const fileEvents = readCompleteLines(join(run.runDir, 'run-events.jsonl')).map((l) =>
    JSON.parse(l),
  );
  const combined = [...h1, ...h2];
  const contiguous = combined.every((seq, i) => seq === i + 1);
  const seen = new Set(combined);
  const missing = fileEvents.filter((e) => !seen.has(e.seq)).map((e) => `${e.seq}:${e.type}`);
  const host2Report = readJson(answersOut);
  if (!drainOnExit) {
    record(
      '3',
      'owner exits without draining its sockets: does the live client get the terminal event?',
      {
        actual: seen.has(fileEvents.at(-1)?.seq)
          ? 'delivered'
          : 'lost (present only in run-events.jsonl)',
        details: { host2Exit: exitCode, missing },
      },
    );
    return;
  }
  check(
    '3',
    'reattached host replays from from_seq while the worker keeps emitting: no gap, no duplicate',
    true,
    contiguous && combined.length === fileEvents.length && exitCode === 0,
    {
      host1Received: h1.length,
      host2From: from,
      fileSeqAtReattach,
      replayedWhileEmitting: fileSeqAtReattach - from + 1,
      host2Received: h2.length,
      host2Exit: exitCode,
      missing: missing.slice(0, 10),
      fileEvents: fileEvents.length,
      lastEvent: fileEvents.at(-1)?.type,
      host2Anomalies: host2Report?.anomalies,
      reattachFirstEventMs: host2Report?.firstEventMs,
      workerPid: pids?.workerPid,
    },
  );
  check(
    '3',
    'lease removed only after the terminal event (completion evidence first)',
    true,
    !existsSync(join(run.runDir, 'lease.json')) && fileEvents.at(-1)?.type === 'run_outcome',
  );
  const results2 = (host2Report?.answers ?? []).map((a) => a.result).join(',');
  check(
    '4',
    'answer after reconnect is accepted; repeat on the same connection is already_decided',
    'accepted,already_decided',
    results2,
  );
  check(
    '4',
    'a different client answering later gets already_decided',
    'already_decided',
    thirdResult,
  );
  check(
    '4',
    'exactly one decision persisted',
    1,
    fileEvents.filter((e) => e.type === 'intervention_decided').length,
  );
}

// ---------------------------------------------------------------------------------------------
// Scenario 5 — orphaned Chrome reaping by creation identity.
// ---------------------------------------------------------------------------------------------
function findChrome() {
  const candidates = [
    arg('--chrome'),
    process.env.YANTRA_TEST_BROWSER_PATH,
    ...(IS_WIN
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']),
  ];
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

async function reapOwnedBrowsers(runDir, core, calls) {
  const lease = readJson(join(runDir, 'lease.json'));
  const probe = new core.NodeProcessLivenessProbe();
  const terminator = new core.NodeProcessTreeTerminator();
  const kept = [];
  const verdicts = [];
  for (const entry of lease?.owned_browsers ?? []) {
    const identity = { pid: entry.pid, startToken: entry.start_token };
    const verdict = await probe.check(identity);
    verdicts.push({ pid: entry.pid, verdict });
    if (verdict === 'unknown') {
      kept.push(entry);
      continue;
    }
    if (verdict === 'dead') continue;
    if ((await probe.check(identity)) !== 'alive') continue; // Re-check immediately before acting.
    calls.push(entry.pid);
    await terminator.terminate(entry.pid);
    const confirmed = await waitFor(
      async () => (await probe.check(identity)) === 'dead',
      10_000,
      100,
    );
    if (!confirmed) kept.push(entry);
  }
  return { verdicts, kept };
}

async function scenario5() {
  const chrome = findChrome();
  if (!chrome) {
    record('5', 'orphan cleanup with a real Chrome', { actual: 'skipped: no Chrome found' });
    return;
  }
  const core = await import('@yantra/core');
  for (const mode of ['hard', 'tree', 'live']) {
    const marker = `s2chrome${randomBytes(4).toString('hex')}`;
    const run = newRun({
      events: 1_000_000,
      intervalMs: 50,
      maxLifetimeMs: 600_000,
      chrome: { executablePath: chrome, userDataDir: join(work, marker) },
    });
    const { pids } = await launch(run);
    const chromeInfo = await waitFor(() => readJson(join(run.runDir, 'chrome.json')), 60_000);
    if (!chromeInfo) {
      record('5', `Chrome launch under the worker (${mode})`, {
        actual: 'failed to launch',
        pass: false,
      });
      continue;
    }
    leftovers.add(chromeInfo.pid);
    const before = pidsWithMarker(marker).length;
    if (mode === 'live') {
      // Exercises the reaper's alive → re-verify → terminate → confirm-dead branch on a running
      // Chrome (as when the owner hung or Chrome outlives it), then retires the worker.
      const calls = [];
      const reaped = await reapOwnedBrowsers(run.runDir, core, calls);
      await sleep(3_000);
      const remaining = pidsWithMarker(marker);
      check(
        '5',
        'reaper terminates a live owned Chrome and confirms its exit by identity',
        '1 terminate, 0 left',
        `${calls.length} terminate, ${remaining.length} left`,
        {
          verdicts: reaped.verdicts,
          chromeProcessesBefore: before,
        },
      );
      hardKill(pids.workerPid);
      continue;
    }
    const killedAt = now();
    if (mode === 'hard') hardKill(pids.workerPid);
    else treeKill(pids.workerPid);
    await waitDead(pids.workerPid, 5_000);
    const selfExit = await waitFor(() => !isAlive(chromeInfo.pid), 10_000, 100);
    const survived = selfExit === null;
    const killLabel =
      mode === 'hard'
        ? IS_WIN
          ? 'taskkill /F (no /T)'
          : 'SIGKILL of the worker'
        : IS_WIN
          ? 'taskkill /T /F'
          : 'SIGKILL of the worker process group';
    record('5', `Chrome after the owning worker dies: ${killLabel}`, {
      expected: mode === 'tree' && IS_WIN ? 'gone' : null,
      actual: survived ? 'survives (orphan)' : 'gone',
      pass: mode === 'tree' && IS_WIN ? !survived : null,
      details: {
        selfExitMs: survived ? null : now() - killedAt,
        chromeProcessesBefore: before,
        chromeLaunchMs: chromeInfo.chromeMs,
        recordedToken: chromeInfo.startToken,
      },
    });
    const calls = [];
    const reaped = await reapOwnedBrowsers(run.runDir, core, calls);
    await sleep(3_000);
    const remaining = pidsWithMarker(marker);
    check('5', `reaper leaves no process of that Chrome profile (${mode})`, 0, remaining.length, {
      verdicts: reaped.verdicts,
      terminateCalls: calls.length,
    });
  }

  // Forged identities: a live unrelated process with a wrong start token, and one with `unknown`.
  const sleeper = spawnNode(join(actors, 'sleeper.mjs'), []);
  await sleep(500);
  const real = await core.identifyProcess(sleeper.pid);
  const forgedDir = join(work, 'forged');
  mkdirSync(forgedDir, { recursive: true });
  for (const [label, token] of [
    ['reused PID (wrong start token)', `${real?.startToken ?? 'x'}-forged`],
    ['unknown start token', 'unknown'],
  ]) {
    writeFileSync(
      join(forgedDir, 'lease.json'),
      JSON.stringify({
        owned_browsers: [
          { pid: sleeper.pid, start_token: token, recorded_at: new Date().toISOString() },
        ],
      }),
    );
    const calls = [];
    const reaped = await reapOwnedBrowsers(forgedDir, core, calls);
    check(
      '5',
      `forged entry never signalled: ${label}`,
      'not signalled, process alive',
      `${calls.length === 0 ? 'not signalled' : 'SIGNALLED'}, process ${isAlive(sleeper.pid) ? 'alive' : 'DEAD'}`,
      {
        verdicts: reaped.verdicts,
        keptEntries: reaped.kept.length,
      },
    );
  }
  hardKill(sleeper.pid);
}

// ---------------------------------------------------------------------------------------------
// Scenario 6 — identity cost and lease write contention.
// ---------------------------------------------------------------------------------------------
async function scenario6() {
  const core = await import('@yantra/core');
  const sequential = [];
  for (let i = 0; i < 10; i += 1) {
    const started = now();
    await core.identifyProcess(process.pid);
    sequential.push(now() - started);
  }
  const parallelStarted = now();
  await Promise.all(Array.from({ length: 8 }, () => core.identifyProcess(process.pid)));
  record('6', 'identifyProcess latency (ms)', {
    actual: {
      p50: percentile(sequential, 50),
      p95: percentile(sequential, 95),
      max: Math.max(...sequential),
    },
    details: { sequential, parallel8WallMs: now() - parallelStarted },
  });
  const runsDir = join(yantraHome, 'runs');
  const readies = (existsSync(runsDir) ? readdirSync(runsDir) : [])
    .map((name) => readJson(join(runsDir, name, 'worker-ready.json')))
    .filter((ready) => ready !== null);
  if (readies.length > 0) {
    record(
      '6',
      'worker startup: import @yantra/core, first currentProcessIdentity(), lease claimed (ms)',
      {
        actual: {
          importP50: percentile(
            readies.map((r) => r.importMs),
            50,
          ),
          identityP50: percentile(
            readies.map((r) => r.identityMs),
            50,
          ),
          identityMax: Math.max(...readies.map((r) => r.identityMs)),
          claimP50: percentile(
            readies.map((r) => r.claimMs),
            50,
          ),
        },
        details: { samples: readies.length },
      },
    );
  }

  const dir = join(work, 'contention');
  mkdirSync(dir, { recursive: true });
  const lease = join(dir, 'lease.json');
  writeFileSync(lease, JSON.stringify({ n: 0 }));
  const utilUrl = pathToFileURL(join(here, 'lib', 'util.mjs')).href;

  const contend = async (label, readerCode, iterations = 300) => {
    const reader = spawn(process.execPath, ['--input-type=module', '-e', readerCode], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let readerOut = '';
    reader.stdout.on('data', (c) => (readerOut += c));
    await sleep(500);
    const codes = {};
    let failures = 0;
    let retried = 0;
    for (let i = 0; i < iterations; i += 1) {
      try {
        const r = atomicReplace(
          lease,
          { n: i, pad: 'x'.repeat(400) },
          { onRetry: (code) => (codes[code] = (codes[code] ?? 0) + 1) },
        );
        if (r > 0) retried += 1;
      } catch (error) {
        failures += 1;
        codes[`final:${error.code}`] = (codes[`final:${error.code}`] ?? 0) + 1;
      }
    }
    reader.kill();
    await new Promise((resolve) => reader.once('exit', resolve));
    return { label, iterations, failures, retried, codes, reader: readerOut.trim() };
  };

  const loopReader = `import { readFileSync } from 'node:fs';
let reads = 0, partial = 0, missing = 0; const end = Date.now() + 60000;
process.on('SIGTERM', () => { console.log(JSON.stringify({ reads, partial, missing })); process.exit(0); });
const tick = () => { for (let i = 0; i < 200; i++) { try { JSON.parse(readFileSync(${JSON.stringify(lease)}, 'utf8')); reads++; } catch (e) { if (e.code === 'ENOENT') missing++; else if (e.code) {} else partial++; } } if (Date.now() < end) setImmediate(tick); };
tick();`;
  const a = await contend('Node reader polling readFileSync', loopReader);
  check(
    '6',
    'temp-then-rename vs a polling Node reader: no failed update after bounded retry',
    0,
    a.failures,
    a,
  );

  const heldReader = `import { openSync } from 'node:fs'; const fd = openSync(${JSON.stringify(lease)}, 'r'); setInterval(() => {}, 1000); void fd;`;
  const b = await contend('Node reader holding an fd open', heldReader);
  check('6', 'temp-then-rename vs a Node reader holding the file open', 0, b.failures, b);

  if (IS_WIN) {
    for (const share of ['Read', 'ReadWrite, Delete']) {
      const ps = `$f = [System.IO.File]::Open('${lease}', 'Open', 'Read', [System.IO.FileShare]'${share}'); Start-Sleep -Seconds 30; $f.Close()`;
      const holder = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await sleep(2_500);
      const codes = {};
      let failures = 0;
      for (let i = 0; i < 20; i += 1) {
        try {
          atomicReplace(
            lease,
            { n: i },
            { onRetry: (code) => (codes[code] = (codes[code] ?? 0) + 1) },
          );
        } catch (error) {
          failures += 1;
          codes[`final:${error.code}`] = (codes[`final:${error.code}`] ?? 0) + 1;
        }
      }
      holder.kill();
      await sleep(300);
      record('6', `temp-then-rename while a .NET reader holds the lease with FileShare.${share}`, {
        actual: `${failures}/20 updates failed after bounded retry`,
        details: { codes },
      });
    }
  }

  // Alternative for mutable ownership state: an append-only sidecar never needs a rename.
  const sidecar = join(dir, 'owned-browsers.jsonl');
  writeFileSync(sidecar, '');
  const appendWhileHeld = async (label, holderCommand, holderArgs) => {
    const holder = spawn(holderCommand, holderArgs, { stdio: 'ignore', windowsHide: true });
    await sleep(IS_WIN && holderCommand === 'powershell' ? 2_500 : 500);
    let failures = 0;
    const codes = {};
    for (let i = 0; i < 100; i += 1) {
      try {
        appendFileSync(sidecar, `${JSON.stringify({ op: 'spawned', pid: i })}\n`);
      } catch (error) {
        failures += 1;
        codes[error.code] = (codes[error.code] ?? 0) + 1;
      }
    }
    holder.kill();
    await sleep(300);
    check('6', `append-only sidecar while ${label}: failed appends`, 0, failures, { codes });
  };
  await appendWhileHeld('a Node reader holds it open', process.execPath, [
    '--input-type=module',
    '-e',
    `import { openSync } from 'node:fs'; openSync(${JSON.stringify(sidecar)}, 'r'); setInterval(() => undefined, 1000);`,
  ]);
  if (IS_WIN) {
    await appendWhileHeld('a .NET reader holds it with FileShare.ReadWrite', 'powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$f = [System.IO.File]::Open('${sidecar}', 'Open', 'Read', [System.IO.FileShare]'ReadWrite'); Start-Sleep -Seconds 30; $f.Close()`,
    ]);
  }

  // Exclusive claim race: 8 processes link() the same lease; exactly one may win per round.
  const winners = [];
  for (let round = 0; round < 10; round += 1) {
    const target = join(dir, `claim-${round}.json`);
    const code = `import { exclusivePublish } from ${JSON.stringify(utilUrl)};
const at = ${Date.now() + 700}; while (Date.now() < at) {}
try { exclusivePublish(${JSON.stringify(target)}, { pid: process.pid }); console.log('won'); } catch (e) { console.log(e.code); }`;
    const outs = await Promise.all(
      Array.from(
        { length: 8 },
        () =>
          new Promise((resolve) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
              stdio: ['ignore', 'pipe', 'ignore'],
              windowsHide: true,
            });
            let out = '';
            child.stdout.on('data', (c) => (out += c));
            child.once('exit', () => resolve(out.trim()));
          }),
      ),
    );
    winners.push(outs.filter((o) => o === 'won').length);
    const losers = outs.filter((o) => o !== 'won');
    if (losers.some((o) => o !== 'EEXIST')) winners.push(`unexpected:${losers.join('|')}`);
  }
  check(
    '6',
    'link()-based exclusive claim: exactly one winner in each of 10 rounds of 8 racers',
    '1,1,1,1,1,1,1,1,1,1',
    winners.join(','),
  );
  const linkProbe = join(dir, 'probe');
  writeFileSync(`${linkProbe}.a`, 'x');
  let linkSupported = true;
  try {
    linkSync(`${linkProbe}.a`, `${linkProbe}.b`);
  } catch {
    linkSupported = false;
  }
  record('6', 'hard links supported in the data directory filesystem', {
    actual: linkSupported,
    details: { dir },
  });
  // A reader polling during a claim never sees a partial lease.
  const claimTarget = join(dir, 'claimed.json');
  const pollCode = `import { readFileSync } from 'node:fs'; let partial = 0, ok = 0; const end = Date.now() + 1500;
while (Date.now() < end) { try { const raw = readFileSync(${JSON.stringify(claimTarget)}, 'utf8'); JSON.parse(raw); ok++; } catch (e) { if (!e.code) partial++; } }
console.log(JSON.stringify({ ok, partial }));`;
  const poller = spawn(process.execPath, ['--input-type=module', '-e', pollCode], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let pollOut = '';
  poller.stdout.on('data', (c) => (pollOut += c));
  await sleep(300);
  for (let i = 0; i < 50; i += 1) {
    exclusivePublish(claimTarget, { pid: process.pid, i, pad: 'y'.repeat(2_000) });
    rmSync(claimTarget);
  }
  exclusivePublish(claimTarget, { pid: process.pid, final: true });
  await new Promise((resolve) => poller.once('exit', resolve));
  const polled = JSON.parse(pollOut || '{"ok":0,"partial":-1}');
  check(
    '6',
    'reader polling during 50 claims never sees a partial lease',
    0,
    polled.partial,
    polled,
  );
}

// ---------------------------------------------------------------------------------------------
const scenarios = { 1: scenario1, 2: scenario2, 3: scenario3and4, 5: scenario5, 6: scenario6 };
const environment = {
  platform: process.platform,
  arch: process.arch,
  release: (await import('node:os')).release(),
  node: process.version,
  ci: process.env.GITHUB_ACTIONS === 'true',
  runnerOs: process.env.RUNNER_OS ?? null,
  tmpdir: tmpdir(),
  startedAt: new Date().toISOString(),
};
console.log(
  `Spike S2 on ${environment.platform} ${environment.release}, Node ${environment.node}; work dir ${work}`,
);
for (const [id, fn] of Object.entries(scenarios)) {
  if (only && !only.includes(id)) continue;
  const started = now();
  try {
    await Promise.race([
      fn(),
      sleep(240_000).then(() => {
        throw new Error('scenario timed out after 240 s');
      }),
    ]);
  } catch (error) {
    record(id, 'scenario raised', { actual: String(error?.stack ?? error), pass: false });
  }
  console.log(`-- scenario ${id} took ${now() - started} ms`);
}
for (const pid of leftovers) if (isAlive(pid)) hardKill(pid);

const summary = [
  `### Spike S2 — ${environment.platform} (${environment.release}), Node ${environment.node}`,
  '',
  '| Scenario | Check | Expected | Actual | Result |',
  '| --- | --- | --- | --- | --- |',
  ...results.map((r) => {
    const cell = (v) => (v === null ? '—' : JSON.stringify(v).replace(/\|/g, '\\|'));
    return `| ${r.scenario} | ${r.name} | ${cell(r.expected)} | ${cell(r.actual)} | ${r.pass === null ? 'info' : r.pass ? 'pass' : '**FAIL**'} |`;
  }),
  '',
].join('\n');
const out = arg('--out');
if (out) writeFileSync(out, JSON.stringify({ environment, results }, null, 2));
const summaryPath = arg('--summary');
if (summaryPath) writeFileSync(summaryPath, summary, { flag: 'a' });
console.log(`\n${summary}`);
try {
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
} catch {
  console.log(`(could not remove ${work})`);
}
const failed = results.filter((r) => r.pass === false).length;
console.log(`${results.length} checks, ${failed} failed`);
// Evidence harness: a failed check is a finding for the report, not a broken build.
process.exit(0);
