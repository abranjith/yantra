/**
 * Host mapping for the task-fidelity harness (FEAT-049 TASK-001).
 *
 * Every fixture site is reached at `http://<name>.yantra.test/…`, the hostname
 * production policy sees, while the bytes come from one loopback server. The
 * mapping lives entirely in the harness, on the two transports a run uses:
 *
 * - {@link mappedRequestFn} replaces `HttpFetcher`'s `requestFn`: a `yantra.test`
 *   target connects to `127.0.0.1:<port>` and keeps its `Host` header.
 * - {@link hostMappedBrowserProvider} decorates a `BrowserProvider` and appends
 *   Chrome's `--host-resolver-rules` to every launch.
 *
 * Both fail closed. Any other non-loopback host is refused — HTTP with a
 * {@link HarnessEgressError} recorded in an {@link EgressLog}, Chrome by
 * resolving every other name to "not found". The deterministic tier is
 * hermetic by construction, not by convention.
 */

import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';

import type { BrowserProvider, HttpFetcher } from '@yantra/core';

import { FIXTURE_DOMAIN } from './sites.js';

/** The `requestFn` signature `HttpFetcher` accepts. */
export type HttpRequestFn = NonNullable<
  NonNullable<ConstructorParameters<typeof HttpFetcher>[0]>['requestFn']
>;

type LaunchArgument = Parameters<BrowserProvider['launch']>[0];

/** A request the harness refused because it would have left the loopback mapping. */
export class HarnessEgressError extends Error {
  public override readonly name = 'HarnessEgressError';

  public constructor(public readonly host: string) {
    super(
      `Task-fidelity egress refused: "${host}" is neither a ${FIXTURE_DOMAIN} fixture host nor ` +
        'loopback. The deterministic tier never contacts the network.',
    );
  }
}

/** A harness precondition that failed before a scenario could run. */
export class HarnessSetupError extends Error {
  public override readonly name = 'HarnessSetupError';
}

/**
 * Hosts refused by the HTTP mapping during a run.
 *
 * The production `HttpFetcher` converts any transport throw into a generic
 * network `FetchError`, so a refusal inside a run is otherwise invisible. The
 * log is the loud half: the tier asserts it is empty.
 */
export class EgressLog {
  private readonly refused: string[] = [];

  public record(host: string): void {
    this.refused.push(host);
  }

  public hosts(): readonly string[] {
    return [...this.refused];
  }
}

/** True for `*.yantra.test` (and the bare domain). */
export function isFixtureHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === FIXTURE_DOMAIN || host.endsWith(`.${FIXTURE_DOMAIN}`);
}

/** True for a loopback name or address. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Chrome's resolver rules for one fixture port: fixture hosts map to the
 * loopback server, loopback passes through, and every other name fails to
 * resolve. Order matters — Chrome applies the first matching rule.
 */
export function hostResolverRules(port: number): string {
  return `--host-resolver-rules=EXCLUDE localhost,MAP *.${FIXTURE_DOMAIN} 127.0.0.1:${port},MAP * ~NOTFOUND`;
}

interface RequestOptionsLike {
  readonly method?: string;
  readonly headers?: Record<string, string | string[] | undefined> | null;
  readonly signal?: AbortSignal | null;
}

/**
 * An `HttpFetcher` `requestFn` that serves `*.yantra.test` from the loopback
 * fixture server and refuses every other non-loopback host.
 *
 * @param port The fixture server's loopback port.
 * @param egress Optional log that records each refused host.
 */
export function mappedRequestFn(port: number, egress?: EgressLog): HttpRequestFn {
  const requestFn = (
    target: string | URL,
    options: RequestOptionsLike = {},
  ): Promise<{
    readonly statusCode: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: IncomingMessage;
  }> => {
    const url = new URL(String(target));
    const hostname = url.hostname.toLowerCase();
    if (!isFixtureHost(hostname) && !isLoopbackHost(hostname)) {
      egress?.record(hostname);
      return Promise.reject(new HarnessEgressError(hostname));
    }
    if (url.protocol !== 'http:') {
      return Promise.reject(
        new HarnessSetupError(`Fixture hosts serve plain HTTP only; refused ${url.protocol} URL.`),
      );
    }
    const fixture = isFixtureHost(hostname);
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({
        host: fixture ? '127.0.0.1' : hostname,
        port: fixture ? port : Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: { ...headersOf(options.headers), host: url.host },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      outgoing.on('response', (response) =>
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
        }),
      );
      outgoing.on('error', reject);
      outgoing.end();
    });
  };
  // The production type is undici's overloaded `request`; `HttpFetcher` calls
  // only the `(url, { method, signal, headers, …timeouts })` form and reads
  // `statusCode`, `headers`, and an async-iterable `body`, all of which a node
  // `IncomingMessage` provides. This one cast is the whole adaptation.
  return requestFn as unknown as HttpRequestFn;
}

function headersOf(headers: RequestOptionsLike['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** Shared launch counter, so several decorated providers in one run count together. */
export class LaunchCounter {
  private launches = 0;

  public increment(): void {
    this.launches += 1;
  }

  public get count(): number {
    return this.launches;
  }
}

/** A decorated provider: the inner provider's full type plus its launch count. */
export type HostMappedBrowserProvider<T extends BrowserProvider> = T & {
  readonly launchCount: number;
};

/**
 * Decorate a browser provider so every launch maps `*.yantra.test` to the
 * fixture port and resolves nothing else.
 *
 * Every member other than `launch` is delegated unchanged (bound to the inner
 * instance, so private state keeps working), and the provider's own type is
 * preserved. Successful launches are counted outside the code under test, so
 * the harness's measurement adds no launch of its own.
 *
 * @param inner The real provider.
 * @param port The fixture server's loopback port.
 * @param counter A counter to share across providers of one run.
 */
export function hostMappedBrowserProvider<T extends BrowserProvider>(
  inner: T,
  port: number,
  counter: LaunchCounter = new LaunchCounter(),
): HostMappedBrowserProvider<T> {
  const rules = hostResolverRules(port);
  const launch = async (options: LaunchArgument): ReturnType<BrowserProvider['launch']> => {
    const session = await inner.launch({
      ...options,
      extraArgs: [...(options.extraArgs ?? []), rules],
    });
    counter.increment();
    return session;
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'launch') return launch;
      if (property === 'launchCount') return counter.count;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as HostMappedBrowserProvider<T>;
}
