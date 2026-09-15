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
import { ConfigBrowserSelectionReader } from './config-selection.js';
import { DRIVER_COMPATIBILITY } from './driver-compatibility.js';
import type { InstallOfferGateway } from './install-offer-gateway.js';
import type {
  BrowserRuntimeServices,
  BrowserSelectionReader,
  DriverCompatibilityDescriptor,
} from './installation-types.js';
import { LocalBrowserInventoryService } from './inventory.js';
import { LocalStableResolutionService } from './managed-availability.js';
import { LocalManagedCoordinator } from './managed-coordination.js';
import type { ManagedInstallService } from './managed-install-types.js';
import { LocalManagedInstallService } from './managed-install.js';
import { LocalManagedStateReader } from './managed-state.js';
import type { ManagedUpdateService } from './managed-update-types.js';
import { LocalManagedUpdateService } from './managed-update.js';
import { LocalProfileStore } from './profile-store.js';
import type { Logger, ProfileStore } from './types.js';

export interface LocalBrowserRuntimeServicesDeps {
  /**
   * Persisted selection. Defaults to the validated `config.yaml` adapter, so
   * every launch-capable caller honors `yantra browser use` without opting in.
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

  const selectionReader = deps.selectionReader ?? new ConfigBrowserSelectionReader();
  const resolver = new LocalBrowserResolver({
    selectionReader,
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
  let updateService: ManagedUpdateService | undefined;
  return {
    resolver,
    compatibility,
    coordinator,
    managedState,
    inventory: new LocalBrowserInventoryService({
      resolver,
      managedState,
      compatibility,
      selectionReader,
      descriptor,
    }),
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
    // Also lazy, for the same reason and one more: building this must not
    // resolve Stable, spawn the metadata helper, or touch the network. Only
    // `yantra browser update` ever calls a method on it.
    get updateService() {
      updateService ??= new LocalManagedUpdateService({
        state: managedState,
        coordinator,
        acquisition: this.installService as LocalManagedInstallService,
        availability: new LocalStableResolutionService(
          deps.logger ? { logger: deps.logger } : undefined,
        ),
        selectionReader,
        descriptor,
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
      return updateService;
    },
    ...(deps.installOfferGateway === undefined
      ? {}
      : { installOfferGateway: deps.installOfferGateway }),
  };
}
