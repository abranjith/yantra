/**
 * Connects the page to its host (FEAT-065 TASK-011): session exchange, the
 * RPC socket, stale-asset checks, resume-code rotation and preferences.
 */

import { takeLaunchCode } from '../boot/take-launch-code.js';
import { connectionStore, type ConnectionStore } from '../host/connection-store.js';
import { RpcClient } from '../host/rpc-client.js';
import { SessionClient, startResumeRotation, type StorageLike } from '../host/session.js';
import { StaleAssetWatcher, isTyping, pageBuildId, reloadWithCode } from '../host/stale-assets.js';
import { startPreferences } from '../prefs/apply-preferences.js';

/** The app channel version this page speaks (protocol `APP_CHANNEL_VERSION`). */
export const PAGE_CHANNEL_VERSION = 1;

/** `sessionStorage`, or null where the browser refuses it. */
function tabStorage(): StorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** What a running app holds. */
export interface AppConnection {
  readonly rpc: RpcClient;
  readonly session: SessionClient;
}

/** Opens the session and the socket; null when the session could not open. */
export async function bootstrap(
  store: ConnectionStore = connectionStore,
): Promise<AppConnection | null> {
  const session = new SessionClient({ fetch: window.fetch.bind(window), storage: tabStorage() });
  if (!(await session.open(takeLaunchCode()))) {
    store.set({ status: 'session_ended' });
    return null;
  }
  const buildId = pageBuildId(document);
  let stale: StaleAssetWatcher | null = null;
  let rotation: ReturnType<typeof startResumeRotation> | null = null;
  const rpc = new RpcClient({
    url: `ws://${window.location.host}/rpc`,
    capability: () => session.capability(),
    buildId,
    channelVersion: PAGE_CHANNEL_VERSION,
    store,
    onHello: (hello) => {
      rotation?.rotate();
      stale?.check(hello.build_id);
    },
  });
  stale = new StaleAssetWatcher({
    pageBuildId: buildId,
    rpc,
    isTyping: () => isTyping(document),
    reload: reloadWithCode,
  });
  rpc.on('host.build', (params) => {
    if (typeof params.build_id === 'string') stale?.check(params.build_id);
  });
  startPreferences(rpc, document.documentElement);
  rotation = startResumeRotation(rpc, session);
  rpc.connect();
  return { rpc, session };
}
