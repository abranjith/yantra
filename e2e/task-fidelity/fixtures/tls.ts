/**
 * A throwaway TLS identity for the fixture server (FEAT-049).
 *
 * Models reach for `https://` by default, and production requires it, so a
 * fixture host must answer TLS the way a real site does. The certificate is
 * generated in memory once per process — an ECDSA P-256 key and a self-signed
 * X.509 v3 certificate for `*.yantra.test`, built with `node:crypto` alone — so
 * no private key is ever committed and no new dependency is needed. The
 * harness's Chrome trusts it via `--ignore-certificate-errors`; nothing else
 * ever sees it.
 */

import { generateKeyPairSync, sign } from 'node:crypto';

import { FIXTURE_DOMAIN } from './sites.js';

/** PEM key and certificate for `https.createServer`. */
export interface TlsIdentity {
  readonly key: string;
  readonly cert: string;
}

let cached: TlsIdentity | undefined;

/** The process-wide fixture TLS identity, generated on first use. */
export function fixtureTlsIdentity(): TlsIdentity {
  cached ??= generateIdentity();
  return cached;
}

function generateIdentity(): TlsIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8(`${FIXTURE_DOMAIN} fixtures`))));
  const signatureAlgorithm = sequence(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const subjectAltName = sequence(
    sequence(
      oid('2.5.29.17'),
      octetString(
        sequence(
          tlv(0x82, Buffer.from(`*.${FIXTURE_DOMAIN}`, 'ascii')),
          tlv(0x82, Buffer.from(FIXTURE_DOMAIN, 'ascii')),
        ),
      ),
    ),
  );
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(Buffer.from([0x49])),
    signatureAlgorithm,
    name,
    sequence(utcTime('260101000000Z'), utcTime('491231235959Z')),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, subjectAltName),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certificate = sequence(
    tbs,
    signatureAlgorithm,
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const base64 = certificate
    .toString('base64')
    .replaceAll(/(.{64})/g, '$1\n')
    .trim();
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}

// --- Minimal DER encoding --------------------------------------------------

function tlv(tag: number, ...contents: readonly Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function sequence(...contents: readonly Buffer[]): Buffer {
  return tlv(0x30, ...contents);
}

function set(...contents: readonly Buffer[]): Buffer {
  return tlv(0x31, ...contents);
}

function integer(value: Buffer): Buffer {
  return tlv(0x02, value);
}

function octetString(value: Buffer): Buffer {
  return tlv(0x04, value);
}

function utf8(text: string): Buffer {
  return tlv(0x0c, Buffer.from(text, 'utf8'));
}

function utcTime(text: string): Buffer {
  return tlv(0x17, Buffer.from(text, 'ascii'));
}

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
