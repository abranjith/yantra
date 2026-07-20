import { Writable } from 'node:stream';

import type { DomainRankRecord, DomainRankStore } from '@yantra/core';
import { ok } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import { run } from '../index.js';

import type { SitesRuntime } from './sites.js';

const AT = '2026-07-19T00:00:00.000Z';

function record(domain: string, overrides: Partial<DomainRankRecord> = {}): DomainRankRecord {
  return {
    domain,
    rank: 1,
    positiveSignals: 1,
    negativeSignals: 0,
    origin: 'user',
    firstSeenAt: AT,
    lastSignalAt: AT,
    ...overrides,
  };
}

class FakeDomainRankStore implements DomainRankStore {
  public readonly rows = new Map<string, DomainRankRecord>();

  public applySignal() {
    return ok(undefined);
  }

  public upsertUserDomain(domain: string) {
    const existing = this.rows.get(domain);
    const next = record(domain, {
      rank: Math.min(100, (existing?.rank ?? 0) + 1),
      positiveSignals: (existing?.positiveSignals ?? 0) + 1,
      negativeSignals: existing?.negativeSignals ?? 0,
      firstSeenAt: existing?.firstSeenAt ?? AT,
    });
    this.rows.set(domain, next);
    return ok(next);
  }

  public remove(domain: string) {
    return ok(this.rows.delete(domain));
  }

  public list() {
    return ok(
      [...this.rows.values()].sort((a, b) => b.rank - a.rank || a.domain.localeCompare(b.domain)),
    );
  }
}

function writable(): { readonly stream: Writable; readonly text: () => string } {
  let output = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    }),
    text: () => output,
  };
}

function runtime(store: FakeDomainRankStore) {
  const stdout = writable();
  const stderr = writable();
  let opens = 0;
  const sitesRuntime: SitesRuntime = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    openStore: () => {
      opens += 1;
      return Promise.resolve({ store, close: () => undefined });
    },
  };
  return { sitesRuntime, stdout, stderr, opens: () => opens };
}

describe('@no-llm yantra sites', () => {
  it('lists an empty store with guidance', async () => {
    const fixture = runtime(new FakeDomainRankStore());

    const exitCode = await run(['sites', 'list'], { sitesRuntime: fixture.sitesRuntime });

    expect(exitCode).toBe(0);
    expect(fixture.stdout.text()).toContain('No ranked sites yet');
  });

  it('lists populated rows as an ordered table', async () => {
    const store = new FakeDomainRankStore();
    store.rows.set('low.example', record('low.example', { rank: -2, negativeSignals: 3 }));
    store.rows.set('high.example', record('high.example', { rank: 5, positiveSignals: 6 }));
    const fixture = runtime(store);

    const exitCode = await run(['sites', 'list'], { sitesRuntime: fixture.sitesRuntime });

    expect(exitCode).toBe(0);
    expect(fixture.stdout.text()).toContain('Domain');
    expect(fixture.stdout.text().indexOf('high.example')).toBeLessThan(
      fixture.stdout.text().indexOf('low.example'),
    );
    expect(fixture.stdout.text()).toContain('Origin');
  });

  it('emits the standard JSON envelope', async () => {
    const store = new FakeDomainRankStore();
    store.rows.set('example.com', record('example.com'));
    const fixture = runtime(store);

    const exitCode = await run(['sites', 'list', '--json'], {
      sitesRuntime: fixture.sitesRuntime,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(fixture.stdout.text())).toMatchObject({
      schemaVersion: '0.2',
      kind: 'sites',
      rows: [{ domain: 'example.com', rank: 1, origin: 'user' }],
    });
  });

  it('adds a normalized user domain with a +1 seed', async () => {
    const store = new FakeDomainRankStore();
    const fixture = runtime(store);

    const exitCode = await run(['sites', 'add', 'WWW.Example.COM'], {
      sitesRuntime: fixture.sitesRuntime,
    });

    expect(exitCode).toBe(0);
    expect(store.rows.get('example.com')).toMatchObject({
      rank: 1,
      positiveSignals: 1,
      origin: 'user',
    });
  });

  it.each(['https://x.com', 'x.com/path', 'bad_domain!'])(
    'rejects invalid add input %s before opening the store',
    async (domain) => {
      const fixture = runtime(new FakeDomainRankStore());

      const exitCode = await run(['sites', 'add', domain], {
        sitesRuntime: fixture.sitesRuntime,
      });

      expect(exitCode).toBe(1);
      expect(fixture.stderr.text()).toContain('without a scheme, path, port, or credentials');
      expect(fixture.opens()).toBe(0);
    },
  );

  it('removes an existing domain', async () => {
    const store = new FakeDomainRankStore();
    store.rows.set('example.com', record('example.com'));
    const fixture = runtime(store);

    const exitCode = await run(['sites', 'remove', 'example.com'], {
      sitesRuntime: fixture.sitesRuntime,
    });

    expect(exitCode).toBe(0);
    expect(store.rows.has('example.com')).toBe(false);
  });

  it('returns exit 1 when removing a missing domain', async () => {
    const fixture = runtime(new FakeDomainRankStore());

    const exitCode = await run(['sites', 'remove', 'missing.example'], {
      sitesRuntime: fixture.sitesRuntime,
    });

    expect(exitCode).toBe(1);
    expect(fixture.stderr.text()).toContain('not ranked');
  });
});
