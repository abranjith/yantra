import type { ElementHandle } from 'puppeteer-core';
import { HitTargetInterceptedError } from './errors.js';
import type { HitTargetCheckResult, InjectedScriptHost } from './types.js';

/**
 * Node-side HitTargetInterceptor.
 *
 * Wraps the injected hit-target check via the InjectedScriptHost.
 * Call this before any synthesized click. If an overlay intercepts,
 * throws HitTargetInterceptedError so the executor can retry or fail cleanly.
 */
export class HitTargetInterceptorImpl {
  constructor(private readonly host: InjectedScriptHost) {}

  /**
   * Verifies a synthesized click at the element's center will land on the element.
   *
   * @param _elementHandle - The element to check (unused in the CDP call — element is in the slot)
   * @param frameId - Frame to run the check in
   * @param chainName - Chain name for error context
   * @returns Hit-target check result
   * @throws {HitTargetInterceptedError} when an overlay intercepts the click target
   */
  async check(
    _elementHandle: ElementHandle,
    frameId: string,
    _chainName: string,
  ): Promise<HitTargetCheckResult> {
    const result = await this.host.call<HitTargetCheckResult>(frameId, 'checkHitTarget', []);
    return result;
  }

  /**
   * Like check() but throws HitTargetInterceptedError when the hit is intercepted.
   * Use this in the executor's click flow.
   */
  async checkOrThrow(
    elementHandle: ElementHandle,
    frameId: string,
    chainName: string,
  ): Promise<void> {
    const result = await this.check(elementHandle, frameId, chainName);

    if (result.kind === 'intercepted') {
      throw new HitTargetInterceptedError({
        chainName,
        interceptor: result.interceptor,
        coords: result.coordinates,
      });
    }
  }
}
