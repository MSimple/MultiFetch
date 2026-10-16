'use strict';

// Error taxonomy: stable machine codes + retryability. Task records store
// {code, message}; the UI localizes by code (M4).

class EngineError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{retryable?: boolean, status?: number}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryable = opts.retryable === true;
    this.status = opts.status;
  }
}

/** HTTP status -> EngineError classification. */
function classifyHttp(status, detail = '') {
  const message = `HTTP ${status}${detail ? ' (' + detail + ')' : ''}`;
  if (status === 408 || status === 429 || status >= 500) {
    return new EngineError(`HTTP_${status}`, message, { retryable: true, status });
  }
  return new EngineError(`HTTP_${status}`, message, { retryable: false, status });
}

function abortedError() {
  return new EngineError('ABORTED', 'operation aborted', { retryable: false });
}

module.exports = { EngineError, classifyHttp, abortedError };
