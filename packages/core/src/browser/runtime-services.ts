/**
 * The one place browser runtime services are composed.
 *
 * Every launch-capable caller — the CLI runtime, the agent orchestrator, the
 * recorder, doctor — takes {@link BrowserRuntimeServices} rather than reaching
 * for a resolver or a coordinator of its own. That is what makes "the same
 * selection everywhere" a structural property instead of a convention.
 */

import { LocalBrowserResolver } from './browser-resolver.js';
import { CompatibilityCache } from './compatibility-cache.js';
import { LocalBrowserCompatibilityService } from './compatibility.js';
import { DRIVER_COMPATIBILITY } from './driver-compatibility.js';
import type { InstallOfferGateway } from './install-offer-gateway.js';
import type {
  BrowserRuntimeServices,
  BrowserSelectionReader,
  DriverCompatibilityDescriptor,
} from './installation-types.js';
import { LocalManagedCoordinator } from './managed-coordination.js';
import type { ManagedInstallService } from './managed-install-types.js';
import { LocalManagedInstallService } from './managed-install.js';
import { LocalManagedStateReader } from './managed-state.js';
import { LocalProfileStore } from './profile-store.js';
import type { Logger, ProfileStore } from './types.js';

export interface LocalBrowserRuntimeServicesDeps {
  /**
   * Persisted selection. FEAT-045 supplies the validated config adapter; until
   * then the default reports "no configured selection" and `auto` applies.
   */
  readonly selectionReader?: BrowserSelectionReader;
  readonly profileStore?: ProfileStore;
  readonly logger?: Logger;
  readonly descriptor?: DriverCompatibilityDescriptor;
  readonly installService?: ManagedInstallService;
  readonly installOfferGateway?: InstallOfferGateway | null;
}

/**
 * Builds the local services with safe defaults.
 *
 * Construction is inert: it opens no browser, reads no network, and takes no
 * lock. Nothing here can trigger a download or an update check.
 */
export function createLocalBrowserRuntimeServices(
  deps: LocalBrowserRuntimeServicesDeps = {},
): BrowserRuntimeServices {
  const descriptor = deps.descriptor ?? DRIVER_COMPATIBILITY;
  const profileStore = deps.profileStore ?? new LocalProfileStore();

  // The coordinator supplies the live-mutation lookup the inventory needs, so
  // an orphan under construction is distinguishable from an abandoned one.
  const coordinator = new LocalManagedCoordinator({ managedState: new LocalManagedStateReader() });
  const managedState = new LocalManagedStateReader({
    liveMutationCandidate: coordinator.liveMutationCandidate,
  });

  const resolver = new LocalBrowserResolver({
    ...(deps.selectionReader ? { selectionReader: deps.selectionReader } : {}),
    managedState,
    supportedHost: (platform, arch) => descriptor.isSupportedHost(platform, arch),
  });

  const compatibility = new LocalBrowserCompatibilityService({
    descriptor,
    cache: new CompatibilityCache({ descriptor }),
    profileStore,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });

  let installService = deps.installService;
  return {
    resolver,
    compatibility,
    coordinator,
    managedState,
    // Doctor and other read-only consumers must not construct the acquisition
    // graph merely by asking for browser resolution services.
    get installService() {
      installService ??= new LocalManagedInstallService({
        state: managedState,
        coordinator,
        compatibility,
        candidateProbe: compatibility,
      });
      return installService;
    },
    ...(deps.installOfferGateway === undefined
      ? {}
      : { installOfferGateway: deps.installOfferGateway }),
  };
}
