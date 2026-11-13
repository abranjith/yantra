// @no-llm
/**
 * The app ↔ host JSON-RPC 2.0 envelopes (FEAT-065 TASK-004).
 */

import { describe, expect, it } from 'vitest';

import {
  AppRpcAuth,
  AppRpcErrorCode,
  HostHelloParams,
  HostHelloResult,
  JsonRpcRequest,
  JsonRpcResponse,
  SessionGrantResponse,
} from '../src/index.js';

describe('AppRpcErrorCode', () => {
  it('pins the standard and app codes', () => {
    expect(AppRpcErrorCode).toEqual({
      parse_error: -32700,
      invalid_request: -32600,
      method_not_found: -32601,
      invalid_params: -32602,
      internal_error: -32603,
      unauthorized: -32001,
      busy: -32002,
      not_allowed: -32003,
      not_found: -32004,
      too_large: -32005,
      needs_confirmation: -32006,
    });
  });

  it('has no duplicate code', () => {
    const codes = Object.values(AppRpcErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('JsonRpcRequest', () => {
  it.each([
    [{ jsonrpc: '2.0', method: 'read.list', params: { limit: 5 }, id: 1 }],
    [{ jsonrpc: '2.0', method: 'read.list', id: 'abc' }],
    [{ jsonrpc: '2.0', method: 'runs.subscribe', params: {} }],
    [{ jsonrpc: '2.0', method: 'x', id: null }],
  ])('accepts %j', (value) => {
    expect(JsonRpcRequest.safeParse(value).success).toBe(true);
  });

  it.each([
    [{ jsonrpc: '1.0', method: 'x', id: 1 }],
    [{ jsonrpc: '2.0', id: 1 }],
    [{ jsonrpc: '2.0', method: '', id: 1 }],
    [{ jsonrpc: '2.0', method: 'x', id: {} }],
    [{ jsonrpc: '2.0', method: 'x', params: 'p' }],
    [{ jsonrpc: '2.0', method: 'x', extra: true }],
  ])('refuses %j', (value) => {
    expect(JsonRpcRequest.safeParse(value).success).toBe(false);
  });
});

describe('JsonRpcResponse', () => {
  it('accepts a result or an error, never both', () => {
    const error = {
      code: -32004,
      message: 'No run.',
      data: { code: 'not_found', message: 'No run.' },
    };
    expect(JsonRpcResponse.safeParse({ jsonrpc: '2.0', id: 1, result: null }).success).toBe(true);
    expect(JsonRpcResponse.safeParse({ jsonrpc: '2.0', id: 1, error }).success).toBe(true);
    expect(JsonRpcResponse.safeParse({ jsonrpc: '2.0', id: 1, result: 1, error }).success).toBe(
      false,
    );
  });

  it('requires error data to say what happened', () => {
    const error = { code: -32603, message: 'x', data: { code: 'internal_error' } };
    expect(JsonRpcResponse.safeParse({ jsonrpc: '2.0', id: 1, error }).success).toBe(false);
  });
});

describe('AppRpcAuth', () => {
  it('accepts exactly the auth message', () => {
    const auth = { jsonrpc: '2.0', method: 'auth', params: { window_capability: 'c' } };
    expect(AppRpcAuth.parse(auth)).toEqual(auth);
  });

  it.each([
    [{ jsonrpc: '2.0', method: 'auth', params: {} }],
    [{ jsonrpc: '2.0', method: 'auth', params: { window_capability: '' } }],
    [{ jsonrpc: '2.0', method: 'auth', params: { window_capability: 'c' }, id: 1 }],
    [{ jsonrpc: '2.0', method: 'host.hello', params: { window_capability: 'c' } }],
    [{ jsonrpc: '2.0', method: 'auth', params: { window_capability: 'c'.repeat(129) } }],
  ])('refuses %j', (value) => {
    expect(AppRpcAuth.safeParse(value).success).toBe(false);
  });
});

describe('host.hello and the session grant', () => {
  it('round-trip', () => {
    const params = { build_id: 'b', channel_version: 1 };
    const result = {
      build_id: 'b',
      channel_version: 1,
      yantra_version: '0.0.1',
      server_time: '2026-11-11T10:00:00.000Z',
    };
    const grant = {
      window_id: 'w',
      window_capability: 'c',
      build_id: 'b',
      absolute_expiry: '2026-11-11T22:00:00.000Z',
    };
    expect(HostHelloParams.parse(params)).toEqual(params);
    expect(HostHelloResult.parse(result)).toEqual(result);
    expect(SessionGrantResponse.parse(grant)).toEqual(grant);
  });
});
