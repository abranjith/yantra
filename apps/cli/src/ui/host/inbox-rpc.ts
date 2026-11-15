import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildInbox, dataDir } from '@yantra/core';
import { InboxDismissal, InboxItem } from '@yantra/protocol';
import { z } from 'zod';

import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

const listParams = z
  .object({
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().nullable().optional(),
  })
  .strict();
const listResult = z
  .object({
    items: z.array(InboxItem),
    nextCursor: z.string().nullable(),
    count: z.number().int().nonnegative(),
  })
  .strict();
const dismissParams = z.object({ item_id: z.string().min(1) }).strict();

/** Registers the bounded Inbox read model and informational dismissals. */
export function registerInbox(methods: RpcMethodRegistry): void {
  methods
    .register('inbox.list', {
      params: listParams,
      result: listResult,
      handler: ({ limit, cursor }) =>
        buildInbox({
          ...(limit === undefined ? {} : { limit }),
          ...(cursor === undefined ? {} : { cursor }),
        }),
    })
    .register('inbox.count', {
      params: z.object({}).strict(),
      result: z.object({ count: z.number().int().nonnegative() }).strict(),
      handler: async () => ({ count: (await buildInbox()).count }),
    })
    .register('inbox.dismiss', {
      params: dismissParams,
      result: z.object({ dismissed: z.literal(true) }).strict(),
      handler: async ({ item_id: itemId }) => {
        const page = await buildInbox({ limit: 200 });
        const item = page.items.find((candidate) => candidate.item_id === itemId);
        if (item === undefined) throw new RpcError('invalid_params', 'Inbox item was not found.');
        if (!item.dismissible)
          throw new RpcError('invalid_params', 'Consent items cannot be dismissed.');
        const dismissal = InboxDismissal.parse({
          item_id: itemId,
          dismissed_at: new Date().toISOString(),
        });
        const path = join(dataDir(), 'ui', 'inbox-dismissed.jsonl');
        await mkdir(join(dataDir(), 'ui'), { recursive: true, mode: 0o700 });
        await appendFile(path, `${JSON.stringify(dismissal)}\n`, 'utf8');
        return { dismissed: true };
      },
    });
}
