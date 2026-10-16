'use strict';

// Persistent per-install secrets. Two independent tokens:
//   captureToken  — authenticates the loopback capture API (M6)
//   protocolToken — authenticates downloadmgr:// URLs; kept separate because
//                   Windows command lines are world-readable
// Generated once on first run; rotatable without touching settings.

const { writeFileAtomic, readJsonWithBak } = require('./atomic');
const { mintToken, timingSafeEqualStr, createSecretBundle } = require('../security/tokens');

const HEX64 = /^[0-9a-f]{64}$/;

class SecretsStore {
  constructor({ file, log = null }) {
    this.file = file;
    this.log = log;
    this.values = null;
  }

  async load() {
    const res = await readJsonWithBak(this.file);
    const v = res && res.value && typeof res.value === 'object' ? res.value : null;
    const captureOk = Boolean(v && HEX64.test(v.captureToken));
    const protocolOk = Boolean(v && HEX64.test(v.protocolToken));
    if (captureOk && protocolOk) {
      this.values = { captureToken: v.captureToken, protocolToken: v.protocolToken };
      return this;
    }
    const bundle = createSecretBundle();
    this.values = {
      captureToken: captureOk ? v.captureToken : bundle.captureToken,
      protocolToken: protocolOk ? v.protocolToken : bundle.protocolToken,
    };
    await this.flush();
    if (this.log) this.log.info('secrets: initialized');
    return this;
  }

  get() {
    return { ...this.values };
  }

  verifyCapture(token) {
    return timingSafeEqualStr(token, this.values.captureToken);
  }

  verifyProtocol(token) {
    return timingSafeEqualStr(token, this.values.protocolToken);
  }

  /** @param {'capture'|'protocol'} which */
  async rotate(which) {
    const key = which === 'protocol' ? 'protocolToken' : 'captureToken';
    this.values[key] = mintToken();
    await this.flush();
    if (this.log) this.log.info(`secrets: rotated ${key}`);
    return this.get();
  }

  async flush() {
    await writeFileAtomic(this.file, JSON.stringify({ ...this.values, savedAt: Date.now() }, null, 2), {
      log: this.log,
    });
  }
}

module.exports = { SecretsStore };
