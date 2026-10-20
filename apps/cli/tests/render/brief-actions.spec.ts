/** @no-llm Terminal actions use shared wording and absolute capture paths. */
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { makeBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { TerminalRenderer } from '../../src/render/terminal.js';

describe('@no-llm terminal action evidence', () => {
  it('prints cited actions and an absolute local capture link', () => {
    let text = '';
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        text += chunk.toString();
        done();
      },
    });
    const path = 'screenshots/capture-1-aaaaaaaaaaaa.png';
    new TerminalRenderer().renderBrief(
      {
        ...makeBrief(),
        actions: [
          {
            id: 'A1',
            kind: 'capture',
            label: null,
            epoch: 1,
            host: 'example.test',
            call_id: 'call-1',
            artifacts: [
              {
                kind: 'screenshot',
                path,
                sha256: 'a'.repeat(64),
                mime_type: 'image/png',
                bytes: 33,
                sent_to_model: false,
              },
            ],
          },
        ],
      },
      {
        jsonPath: '/runs/one/brief.json',
        mdPath: '/runs/one/brief.md',
        htmlPath: '/runs/one/brief.html',
      },
      { json: false, debug: false, noColor: true, stream, errStream: stream },
    );
    expect(text).toContain(
      `\nActions\n- A1: captured screenshot: part 1: ${join('/runs/one', path)} (call call-1)`,
    );
  });
});
