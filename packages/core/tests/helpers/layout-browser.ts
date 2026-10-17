import type { Page as PuppeteerPage } from 'puppeteer-core';

import { AgentBrowserController } from '../../src/browser/agent-controller.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';

import { beginMigrationBrowserFixture } from './migration-browser.js';

/** An isolated, offline real-browser fixture shared by form identity suites. */
export async function layoutBrowser() {
  const fixture = await beginMigrationBrowserFixture();
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const provider = new LocalBrowserProvider({ profileStore: new LocalProfileStore(), logger });
  let page: PuppeteerPage;
  const controller = new AgentBrowserController({
    runId: 'layout-matrix',
    browserProvider: {
      detectChrome: () => provider.detectChrome(),
      launch: async (options) => {
        const session = await provider.launch({ ...options, ...fixture.launchOptions });
        const newPage = session.newPage.bind(session);
        session.newPage = async () => {
          const facade = await newPage();
          page = facade.puppeteerPage!;
          return facade;
        };
        return session;
      },
    },
  });
  try {
    await controller.navigate('about:blank');
  } catch (error) {
    await controller.teardown();
    await fixture.cleanup();
    throw error;
  }
  return {
    controller,
    page: page!,
    async close() {
      await controller.teardown();
      await fixture.cleanup();
    },
  };
}
