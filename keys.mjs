// API keys, one per provider. The desktop app encrypts each one with the operating system (Electron safeStorage:
// Windows DPAPI, macOS Keychain) before it touches disk; without a folder (npm run web) keys live in memory only.
// A provider with no saved key falls back to its environment variable, which `npm run web` loads from .env.
// Keys never leave this module except to the server's calls to that provider.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';

export const KEY_ENV = { tripo: 'TRIPO_API_KEY', '3daistudio': 'THREE_D_AI_STUDIO_KEY', anthropic: 'ANTHROPIC_API_KEY' }; // anthropic: the car material inference's vision model
const LEGACY = { tripo: 'tripo-key.bin' }; // where v0.3 and earlier kept the Tripo key

/**
 * dir: the app's data folder (Electron userData), or nothing for memory only.
 * encrypt(string) → Buffer and decrypt(Buffer) → string: safeStorage in the app, anything reversible in tests.
 */
export function createKeyStore({ dir, encrypt, decrypt, canEncrypt = () => true, env = {} } = {}) {
  const keys = {}; // provider → saved key, decrypted once
  const file = (provider) => path.join(dir, 'keys', `${provider}.bin`);
  const legacy = (provider) => LEGACY[provider] && path.join(dir, LEGACY[provider]);
  const known = (provider) => { if (!Object.hasOwn(KEY_ENV, provider)) throw new Error(`Unknown provider: ${provider}`); };
  const decryptFile = (f) => {
    if (!f || !existsSync(f)) return undefined;
    try { return decrypt(readFileSync(f)) || undefined; } catch { return undefined; } // unreadable (another user or OS): ask again
  };
  function write(provider, key) {
    if (!canEncrypt()) throw new Error('This system cannot store the key securely');
    mkdirSync(path.dirname(file(provider)), { recursive: true });
    const tmp = `${file(provider)}.tmp`;
    writeFileSync(tmp, encrypt(key));
    renameSync(tmp, file(provider));
  }

  if (dir) {
    for (const provider of Object.keys(KEY_ENV)) {
      keys[provider] = decryptFile(file(provider));
      // Migration: a key saved by an older version is copied into the new store. The old file is kept (and still
      // read if the copy can't be written), so the key is never lost and an older Flatform still finds it.
      if (!keys[provider] && (keys[provider] = decryptFile(legacy(provider)))) {
        try { write(provider, keys[provider]); } catch (e) { console.error(`Could not move the saved ${provider} key: ${e.message}`); }
      }
    }
  }

  return {
    get(provider) { known(provider); return keys[provider] || env[KEY_ENV[provider]] || undefined; },
    // 'saved' (encrypted on this computer, or in memory for npm run web), 'env' or 'none'. Never the key itself.
    source(provider) { known(provider); return keys[provider] ? 'saved' : env[KEY_ENV[provider]] ? 'env' : 'none'; },
    set(provider, key) {
      known(provider);
      if (dir) write(provider, key);
      keys[provider] = key;
    },
    remove(provider) {
      known(provider);
      delete keys[provider];
      if (dir) for (const f of [file(provider), legacy(provider)]) if (f) rmSync(f, { force: true }); // or the old key comes back
    },
  };
}
