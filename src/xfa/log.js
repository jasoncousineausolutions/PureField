/**
 * Purefield / xfa / log.js
 *
 * Collects the XFA_* diagnostics the spec asks for. Nothing here throws:
 * stages log what they skipped or substituted and keep going.
 */

export class XfaLog {
  constructor() {
    this.entries = [];
    this._once = new Set();
  }

  /** @param {'info'|'warn'|'error'} level */
  add(level, code, message) {
    this.entries.push({ level, code, message });
  }

  info(code, message)  { this.add('info',  code, message); }
  warn(code, message)  { this.add('warn',  code, message); }
  error(code, message) { this.add('error', code, message); }

  /** Log only the first time a given key is seen (e.g. once per font face). */
  once(level, code, key, message) {
    const k = `${code}\u0000${key}`;
    if (this._once.has(k)) return;
    this._once.add(k);
    this.add(level, code, message);
  }

  /** Entries with a given code. */
  byCode(code) {
    return this.entries.filter(e => e.code === code);
  }
}
