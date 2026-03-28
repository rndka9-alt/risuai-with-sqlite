/**
 * Self-auth module for with-sqlite.
 *
 * On startup, generates an ES256 keypair and registers it with risuai
 * via POST /api/login. After registration, can issue JWTs for internal
 * requests to risuai (hydration, .meta reads, etc.).
 *
 * Also provides verifyClientAuth() to validate incoming client tokens
 * by forwarding to risuai's GET /api/test_auth.
 */

import crypto from 'crypto';
import fs from 'fs';
import { UPSTREAM, RISU_AUTH_HEADER, RISUAI_SAVE_MOUNT } from './config';
import * as log from './logger';

const PASSWORD_PATH = `${RISUAI_SAVE_MOUNT}/__password`;
const JWT_LIFETIME_S = 300; // 5 minutes

let privateKey: crypto.webcrypto.CryptoKey | null = null;
let publicKeyJwk: crypto.webcrypto.JsonWebKey | null = null;
let registered = false;

/**
 * Generate ES256 keypair and register with risuai.
 * Retries until successful (risuai might not be ready yet).
 */
export async function initAuth(): Promise<void> {
  let password: string;
  try {
    password = fs.readFileSync(PASSWORD_PATH, 'utf-8').trim();
  } catch {
    log.warn('Cannot read risuai password file — self-auth disabled', { path: PASSWORD_PATH });
    return;
  }

  if (!password) {
    log.warn('risuai password file is empty — self-auth disabled');
    return;
  }

  const kp = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  privateKey = kp.privateKey;
  publicKeyJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);

  await registerWithRetry(password);
}

async function registerOnce(password: string): Promise<boolean> {
  try {
    const body = JSON.stringify({
      password,
      publicKey: publicKeyJwk,
    });

    const resp = await fetch(`${UPSTREAM.protocol}//${UPSTREAM.host}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    if (resp.ok) {
      registered = true;
      log.info('Self-auth registered with risuai');
      return true;
    }

    const errBody = await resp.text();
    log.warn('Self-auth registration failed', { status: resp.status, body: errBody });
  } catch (err) {
    log.warn('Self-auth registration error (risuai not ready?)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return false;
}

async function registerWithRetry(password: string): Promise<void> {
  const maxRetries = 10;
  const retryDelay = 3000;

  for (let i = 0; i < maxRetries; i++) {
    if (await registerOnce(password)) return;
    log.warn('Self-auth retry', { attempt: i + 1 });
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }

  log.error('Self-auth registration exhausted retries');
}

/**
 * Issue a JWT signed with our registered keypair.
 * Used for internal requests to risuai.
 */
export async function issueInternalToken(): Promise<string | null> {
  if (!registered || !privateKey || !publicKeyJwk) return null;

  const header = { alg: 'ES256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + JWT_LIFETIME_S,
    pub: publicKeyJwk,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    Buffer.from(signingInput),
  );

  const signatureB64 = Buffer.from(signature).toString('base64url');
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Check if self-auth is ready (registered with risuai).
 */
export function isAuthReady(): boolean {
  return registered;
}

/**
 * Re-attempt self-auth registration once.
 * Useful when initial startup registration failed but risuai is now available.
 */
export async function retryAuth(): Promise<void> {
  if (registered) return;

  let password: string;
  try {
    password = fs.readFileSync(PASSWORD_PATH, 'utf-8').trim();
  } catch {
    log.warn('retryAuth: cannot read password file', { path: PASSWORD_PATH });
    return;
  }
  if (!password) return;

  // 키페어가 아직 없으면 생성 (첫 initAuth가 패스워드 읽기 전에 실패한 경우)
  if (!privateKey || !publicKeyJwk) {
    const kp = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    privateKey = kp.privateKey;
    publicKeyJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  }

  await registerOnce(password);
}

/**
 * Verify a client's risu-auth token by forwarding to risuai's /api/test_auth.
 * Returns true if risuai considers the token valid.
 */
export async function verifyClientAuth(authHeader: string): Promise<boolean> {
  try {
    const resp = await fetch(`${UPSTREAM.protocol}//${UPSTREAM.host}/api/test_auth`, {
      method: 'GET',
      headers: { [RISU_AUTH_HEADER]: authHeader },
    });

    if (!resp.ok) return false;
    const body: { status?: string } = await resp.json();
    return body.status === 'success';
  } catch {
    return false;
  }
}
