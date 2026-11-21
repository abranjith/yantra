// @no-llm
/**
 * REV-002: one intervention wiring for every run owner. A live consent is
 * answered over the real run socket through the owner's authority, exactly
 * once; attendance from the host reaches the authority; and gateways can be
 * bound to the run they answer for.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfirmationRequest, RunEvent } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InteractiveConfirmationGateway } from '../../src/discovery/interactive-confirmation-gateway.js';
import { AuthorityConnectorConfirmationGateway } from '../../src/interventions/authority-connector-gateway.js';
import {
  INTERVENTIONS_CAPABILITY,
  RunInterventions,
  isRunBindable,
  type InterventionChannelHost,
} from '../../src/interventions/run-interventions.js';
import { RunChannelServer } from '../../src/run-channel/server.js';
import {
  RawPeer,
  TOKEN,
  cleanupSandbox,
  makeRunDir,
  sandboxHome,
  silentLogger,
  until,
} from '../run-channel/support.js';

const RUN_ID = 'run-rev-002';

function request(id = '01J00000000000000000000001'): ConfirmationRequest {
  return {
    confirmation_id: id,
    run_id: RUN_ID,
    step_id: 'step-1',
    action_kind: 'click',
    host: 'shop.example',
    description: 'Place the order',
    expected_cost: null,
    consequence: 'irreversible',
    requested_at: new Date().toISOString(),
    timeout_ms: 60_000,
  };
}

let root: string;
const servers: RunChannelServer[] = [];
const peers: RawPeer[] = [];

beforeEach(() => {
  sandboxHome();
  root = join(makeRunDir(), 'runs');
  mkdirSync(join(root, RUN_ID), { recursive: true });
});

afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close(0)));
  cleanupSandbox();
});

async function socket(runs: RunInterventions) {
  const server = await RunChannelServer.listen({
    runId: RUN_ID,
    token: TOKEN,
    logger: silentLogger,
  });
  servers.push(server);
  runs.attachRun(RUN_ID, {
    channel: {
      registerChannelHandler: (type, capability, handler) =>
        server.register(type, capability, handler),
    },
  });
  const peer = await RawPeer.open(server.address);
  peers.push(peer);
  peer.hello({ capabilities: ['events', INTERVENTIONS_CAPABILITY] });
  await peer.waitForFrames(1);
  return peer;
}

const typed = (peer: RawPeer, type: string) =>
  peer.messages().filter((message) => (message as { type?: string }).type === type) as Record<
    string,
    unknown
  >[];

describe('a live consent answered over the run socket', () => {
  it('is decided by the owner authority with the answering surface recorded', async () => {
    const runs = new RunInterventions({ initialAttendance: 0, runsRoot: () => root });
    const peer = await socket(runs);
    const waiting = runs.authorityFor(RUN_ID).raise(request());

    peer.sendJson({
      type: 'intervention.answer',
      intervention_id: request().confirmation_id,
      decision: 'granted',
      decided_by: 'user_app',
    });

    await expect(waiting).resolves.toMatchObject({ decision: 'granted', decided_by: 'user_app' });
    await until(() => typed(peer, 'intervention.response').length === 1);
    expect(typed(peer, 'intervention.response')[0]).toMatchObject({
      intervention_id: request().confirmation_id,
      response: { status: 'accepted' },
    });
  });

  it('is decided exactly once when the app and yantra confirm both answer', async () => {
    const runs = new RunInterventions({ initialAttendance: 0, runsRoot: () => root });
    const peer = await socket(runs);
    const waiting = runs.authorityFor(RUN_ID).raise(request());

    peer.sendJson({
      type: 'intervention.answer',
      intervention_id: request().confirmation_id,
      decision: 'denied',
      decided_by: 'user_cli_confirm',
    });
    peer.sendJson({
      type: 'intervention.answer',
      intervention_id: request().confirmation_id,
      decision: 'granted',
      decided_by: 'user_app',
    });

    await expect(waiting).resolves.toMatchObject({ decision: 'denied' });
    await until(() => typed(peer, 'intervention.response').length === 2);
    const statuses = typed(peer, 'intervention.response').map(
      (message) => (message.response as { status: string }).status,
    );
    expect(statuses.sort()).toEqual(['accepted', 'already_decided']);
  });

  it('answers an unknown id as stale and leaves the pending request waiting', async () => {
    const runs = new RunInterventions({ initialAttendance: 0, runsRoot: () => root });
    const peer = await socket(runs);
    const waiting = runs.authorityFor(RUN_ID).raise(request());
    let settled = false;
    void waiting.then(() => (settled = true));

    peer.sendJson({
      type: 'intervention.answer',
      intervention_id: '01J000000000000000000000ZZ',
      decision: 'granted',
      decided_by: 'user_app',
    });

    await until(() => typed(peer, 'intervention.response').length === 1);
    expect(typed(peer, 'intervention.response')[0]).toMatchObject({
      response: { status: 'stale' },
    });
    expect(settled).toBe(false);
    await runs.authorityFor(RUN_ID).close();
  });

  it.each([
    [{ intervention_id: 7, decision: 'granted', decided_by: 'user_app' }],
    [{ intervention_id: 'x', decision: 'maybe', decided_by: 'user_app' }],
    [{ intervention_id: 'x', decision: 'granted', decided_by: 'someone_else' }],
  ])('rejects a malformed answer %j as bad_request', async (fields) => {
    const runs = new RunInterventions({ initialAttendance: 0, runsRoot: () => root });
    const peer = await socket(runs);

    peer.sendJson({ type: 'intervention.answer', ...fields });

    await until(() => typed(peer, 'error').length === 1);
    expect(typed(peer, 'error')[0]).toMatchObject({
      code: 'bad_request',
      message: 'intervention.answer',
    });
  });
});

describe('attendance from the host', () => {
  it('reaches the owner authority, from the initial count onward', async () => {
    const runs = new RunInterventions({ initialAttendance: 0, runsRoot: () => root });
    const peer = await socket(runs);
    const authority = runs.authorityFor(RUN_ID);
    expect(authority.attendance()).toBe(0);

    peer.sendJson({ type: 'attendance', count: 2 });
    await until(() => authority.attendance() === 2);

    peer.sendJson({ type: 'attendance', count: 0 });
    await until(() => authority.attendance() === 0);
  });

  it.each([[-1], [1.5], ['2'], [null]])('rejects count %j as bad_request', async (count) => {
    const runs = new RunInterventions({ initialAttendance: 1, runsRoot: () => root });
    const peer = await socket(runs);

    peer.sendJson({ type: 'attendance', count });

    await until(() => typed(peer, 'error').length === 1);
    expect(typed(peer, 'error')[0]).toMatchObject({ code: 'bad_request', message: 'attendance' });
    expect(runs.authorityFor(RUN_ID).attendance()).toBe(1);
  });
});

describe('RunInterventions', () => {
  function countingHost() {
    const registered: string[] = [];
    const host: InterventionChannelHost = {
      registerChannelHandler: (type) => registered.push(type),
    };
    return { host, registered };
  }

  it('keeps one authority per run and calls onAuthority once for it', () => {
    const onAuthority = vi.fn();
    const runs = new RunInterventions({ initialAttendance: 0, onAuthority, runsRoot: () => root });

    const first = runs.authorityFor(RUN_ID);
    expect(runs.authorityFor(RUN_ID)).toBe(first);
    expect(runs.authorityFor('another-run')).not.toBe(first);
    expect(onAuthority).toHaveBeenCalledTimes(2);
    expect(onAuthority).toHaveBeenNthCalledWith(1, first, RUN_ID);
  });

  it('registers the socket handlers once however often the run is bound', () => {
    const runs = new RunInterventions({ initialAttendance: 0, runsRoot: () => root });
    const { host, registered } = countingHost();

    runs.attachRun(RUN_ID, { channel: host });
    runs.attachRun(RUN_ID, { channel: host });

    expect(registered).toEqual(['attendance', 'intervention.answer']);
  });

  it('publishes authority events to the run log only once it is bound', async () => {
    const runs = new RunInterventions({ initialAttendance: 1, runsRoot: () => root });
    const authority = runs.authorityFor(RUN_ID);
    const published: RunEvent[] = [];
    const flush = vi.fn(() => Promise.resolve());

    await authority.setAttendance(0);
    expect(published).toEqual([]);

    runs.attachRun(RUN_ID, { events: { publish: (event) => published.push(event), flush } });
    await authority.setAttendance(1);

    expect(published).toEqual([expect.objectContaining({ kind: 'attendance_changed', count: 1 })]);
    expect(flush).toHaveBeenCalled();
  });
});

describe('bindable gateways', () => {
  it('the connector gateway forwards attachRun to its runs, and is a no-op without them', () => {
    const runs = new RunInterventions({ initialAttendance: 0, runsRoot: () => root });
    const registered: string[] = [];
    const channel: InterventionChannelHost = {
      registerChannelHandler: (type) => registered.push(type),
    };
    const bound = new AuthorityConnectorConfirmationGateway({
      authority: (r) => runs.authorityFor(r.run_id),
      answer: () => Promise.resolve('denied'),
      runs,
    });
    const unbound = new AuthorityConnectorConfirmationGateway({
      authority: runs.authorityFor(RUN_ID),
      answer: () => Promise.resolve('denied'),
    });

    expect(isRunBindable(bound)).toBe(true);
    unbound.attachRun(RUN_ID, { channel });
    expect(registered).toEqual([]);
    bound.attachRun(RUN_ID, { channel });
    expect(registered).toEqual(['attendance', 'intervention.answer']);
  });

  it('the terminal gateway binds its own authority but never a supplied one', () => {
    const registered: string[] = [];
    const channel: InterventionChannelHost = {
      registerChannelHandler: (type) => registered.push(type),
    };
    const own = new InteractiveConfirmationGateway({ sink: { write: () => undefined } });
    const supplied = new InteractiveConfirmationGateway({
      sink: { write: () => undefined },
      authority: new RunInterventions({ initialAttendance: 1, runsRoot: () => root }).authorityFor(
        RUN_ID,
      ),
    });

    supplied.attachRun(RUN_ID, { channel });
    expect(registered).toEqual([]);
    own.attachRun(RUN_ID, { channel });
    expect(registered).toEqual(['attendance', 'intervention.answer']);
  });

  it.each([[null], [undefined], [{}], [{ attachRun: 'no' }]])(
    'isRunBindable(%j) is false',
    (value) => {
      expect(isRunBindable(value)).toBe(false);
    },
  );
});
