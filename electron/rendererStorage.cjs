/** Move legacy file:// state before the application mounts on its new origin. */
const STORAGE_URL = 'msds://app/__storage-migration__';
const MIGRATION_KEY = 'msds-renderer-storage-migrated-v1';

/**
 * Both pages are inert: never load the React application during migration.
 * Chromium shares file:// localStorage across paths in the same session, so
 * the bundled blank HTML can read state from the former dist/index.html page.
 * The caller loads the application entry after this function settles.
 */
async function migrateRendererStorage(window, legacyFilePath, appUrl = STORAGE_URL) {
  try {
    await window.loadURL(appUrl);
    const completed = await window.webContents.executeJavaScript(
      `localStorage.getItem(${JSON.stringify(MIGRATION_KEY)}) === '1'`
    );
    if (completed) return { migrated: false, copied: 0 };

    await window.loadFile(legacyFilePath);
    const legacy = await window.webContents.executeJavaScript(`(() => {
      const saved = Object.create(null);
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key !== null) saved[key] = localStorage.getItem(key);
      }
      return saved;
    })()`);
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
      throw new Error('Could not read legacy application storage.');
    }

    await window.loadURL(appUrl);
    // Encode the record as a JSON string, then parse it in the destination.
    // Storage keys and values must stay data, including quotes and newlines.
    const copied = await window.webContents.executeJavaScript(`(() => {
      const marker = ${JSON.stringify(MIGRATION_KEY)};
      if (localStorage.getItem(marker) === '1') return 0;
      const saved = JSON.parse(${JSON.stringify(JSON.stringify(legacy))});
      let copied = 0;
      for (const [key, value] of Object.entries(saved)) {
        if (key !== marker && typeof value === 'string' && localStorage.getItem(key) === null) {
          localStorage.setItem(key, value);
          copied++;
        }
      }
      // An empty source still completes migration. After logout, old auth
      // tokens must not be copied back into this origin on the next launch.
      localStorage.setItem(marker, '1');
      return copied;
    })()`);
    return { migrated: true, copied };
  } catch {
    // Storage may be disabled, full, or unavailable while a window closes.
    // Leave completion unmarked so a later launch can finish missing keys.
    console.warn('[msds:storage-migration] Could not migrate legacy application storage.');
    return { migrated: false, copied: 0 };
  }
}

module.exports = { STORAGE_URL, migrateRendererStorage };
