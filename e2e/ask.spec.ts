import { once } from 'node:events';
import { createServer } from 'node:http';
import { Writable } from 'node:stream';

import { run } from '@yantra/cli';
import type { AskCard, AskPipeline } from '@yantra/core';
import { describe, expect, it } from 'vitest';

function captureStream() {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      data += String(chunk);
      callback();
    },
  });

  return {
    stream,
    value: () => data,
  };
}

async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === '/one' || req.url === '/two' || req.url === '/three') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><main><article><p>Fixture article content.</p></article></main></html>');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not bind fixture server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

describe('@no-llm ask e2e', () => {
  it('prints three cards for a fixture query in under 5 seconds', async () => {
    const fixture = await startFixtureServer();
    const stdout = captureStream();
    const stderr = captureStream();

    const started = Date.now();
    const exitCode = await run(['ask', 'fixture topic', '--json'], {
      askRuntime: {
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        createPipeline: () => {
          const cards: AskCard[] = [
            {
              url: `${fixture.baseUrl}/one`,
              title: 'Fixture One',
              source: '127.0.0.1',
              fetchedAt: new Date().toISOString(),
              publishedAt: null,
              summary: 'Fixture summary one.',
              summaryKind: 'rule-based',
              quotedSnippet: 'Fixture snippet one.',
              tags: ['fixture'],
              notice: null,
            },
            {
              url: `${fixture.baseUrl}/two`,
              title: 'Fixture Two',
              source: '127.0.0.1',
              fetchedAt: new Date().toISOString(),
              publishedAt: null,
              summary: 'Fixture summary two.',
              summaryKind: 'rule-based',
              quotedSnippet: 'Fixture snippet two.',
              tags: ['fixture'],
              notice: null,
            },
            {
              url: `${fixture.baseUrl}/three`,
              title: 'Fixture Three',
              source: '127.0.0.1',
              fetchedAt: new Date().toISOString(),
              publishedAt: null,
              summary: 'Fixture summary three.',
              summaryKind: 'rule-based',
              quotedSnippet: 'Fixture snippet three.',
              tags: ['fixture'],
              notice: null,
            },
          ];

          return Promise.resolve({
            run: () => Promise.resolve(cards),
          } as unknown as AskPipeline);
        },
      },
    });

    const elapsed = Date.now() - started;
    const payload = JSON.parse(stdout.value()) as { cards: AskCard[] };

    expect(exitCode).toBe(0);
    expect(payload.cards).toHaveLength(3);
    expect(elapsed).toBeLessThan(5_000);

    await fixture.close();
  });
});
