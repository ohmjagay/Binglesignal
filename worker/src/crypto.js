import { supabaseRequest } from './supabase.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function aesKey(raw, usages) {
  if (raw.byteLength !== 32) throw new Error('Encryption keys must contain exactly 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

function kek(env, kid) {
  if (!/^v[1-9]\d*$/.test(kid)) throw new Error('Invalid encryption key identifier');
  const value = env[`KEK_${kid.toUpperCase()}`];
  if (!value) throw new Error(`KEK_${kid.toUpperCase()} is not configured`);
  const raw = fromBase64(value);
  if (raw.byteLength !== 32) throw new Error(`KEK_${kid.toUpperCase()} must be a base64-encoded 32-byte key`);
  return raw;
}

async function databaseRows(env, path, init) {
  const response = await supabaseRequest(env, path, init);
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status}`);
  const body = await response.text();
  return body ? JSON.parse(body) : [];
}

async function unwrapUserKey(env, userId, record) {
  const wrappingKey = await aesKey(kek(env, record.kid), ['decrypt']);
  const packed = fromBase64(record.wrapped_dek);
  if (packed.byteLength <= 12) throw new Error('Stored user encryption key is invalid');
  const dek = new Uint8Array(await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: packed.slice(0, 12),
    additionalData: enc.encode(`dek|${userId}`),
  }, wrappingKey, packed.slice(12)));
  dek.kid = record.kid;
  return dek;
}

export async function getUserDek(env, userId) {
  const path = `/rest/v1/user_keys?user_id=eq.${encodeURIComponent(userId)}&select=kid,wrapped_dek&limit=1`;
  const existing = await databaseRows(env, path);
  if (existing.length) return unwrapUserKey(env, userId, existing[0]);

  const kid = env.KEK_CURRENT;
  if (!kid) throw new Error('KEK_CURRENT is not configured');
  const wrappingKey = await aesKey(kek(env, kid), ['encrypt']);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: enc.encode(`dek|${userId}`),
  }, wrappingKey, dek));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);

  await databaseRows(env, '/rest/v1/user_keys?on_conflict=user_id', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, kid, wrapped_dek: base64(packed) }),
  });
  const stored = await databaseRows(env, path);
  if (!stored.length) throw new Error('User encryption key was not created');
  return unwrapUserKey(env, userId, stored[0]);
}

export async function encryptField(dek, userId, purpose, value) {
  const key = await aesKey(dek, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: enc.encode(`${userId}|${purpose}`),
  }, key, enc.encode(value)));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  const kid = dek.kid || 'v1';
  return `v1.${kid}.${base64(packed)}`;
}

export async function decryptField(dek, userId, purpose, value) {
  const [version, kid, packedValue] = String(value).split('.');
  if (version !== 'v1' || !/^v[1-9]\d*$/.test(kid) || !packedValue) throw new Error('Encrypted field format is invalid');
  const packed = fromBase64(packedValue);
  if (packed.byteLength <= 12) throw new Error('Encrypted field is invalid');
  const key = await aesKey(dek, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: packed.slice(0, 12),
    additionalData: enc.encode(`${userId}|${purpose}`),
  }, key, packed.slice(12));
  return dec.decode(plaintext);
}

export async function decryptLegacyToken(env, value) {
  if (!env.EMAIL_TOKEN_ENCRYPTION_KEY) throw new Error('Legacy EMAIL_TOKEN_ENCRYPTION_KEY is not configured');
  const raw = fromBase64(env.EMAIL_TOKEN_ENCRYPTION_KEY);
  const key = await aesKey(raw, ['decrypt']);
  const packed = fromBase64(value);
  if (packed.byteLength <= 12) throw new Error('Legacy encrypted token is invalid');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12));
  return dec.decode(plaintext);
}
