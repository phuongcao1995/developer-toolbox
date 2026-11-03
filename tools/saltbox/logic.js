// Pure crypto/encoding logic ported from the standalone Saltbox project (no DOM access).
// The lib/*.js files are plain scripts that attach to a shared `Saltbox` global, so importing
// them for side effects works in both the browser and Node 20+ (Web Crypto is built in).
import './lib/core.js';
import './lib/encoding.js';
import './lib/md5.js';
import './lib/hash.js';
import './lib/generator.js';
import './lib/password.js';
import './lib/encryption.js';
import './lib/keycipher.js';

export const S = globalThis.Saltbox;
export const { core, encoding, hash, generator, password, encryption, keycipher } = S;
