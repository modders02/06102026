'use strict';

/**
 * Safe, predictable defaults for Electron-managed Python CCTV keyword
 * detection. Only the child process inherits these settings; modifying
 * the user's global Windows environment is unnecessary.
 *
 * Explicit environment overrides remain available for diagnostics.
 * A KWS "ACCEPTED" result does NOT bypass facial/visual alert validation.
 */
const ELECTRON_KWS_DEFAULTS = Object.freeze({
  MSDS_KWS_VERIFY_ASR: '0',
  MSDS_KWS_HELP_RESCUE: '0',
  MSDS_KWS_SHORT_HELP_ASR: '0',
  MSDS_KWS_HELP_90_FAST_ACCEPT: '1',
});

function withElectronKwsDefaults(parentEnv = process.env) {
  const output = { ...parentEnv };
  for (const [key, value] of Object.entries(ELECTRON_KWS_DEFAULTS)) {
    if (output[key] === undefined || output[key] === '') {
      output[key] = value;
    }
  }
  return output;
}

module.exports = { ELECTRON_KWS_DEFAULTS, withElectronKwsDefaults };
