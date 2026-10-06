/** The designated recording folder belongs to the main process, never the renderer. */
const fs = require('node:fs/promises');
const path = require('node:path');

function createClipStorage({ getConfigPath, pickDirectory }) {
  let selectedFolder;

  async function getFolder() {
    if (selectedFolder !== undefined) return selectedFolder;
    try {
      const config = JSON.parse(await fs.readFile(getConfigPath(), 'utf8'));
      selectedFolder = typeof config.folder === 'string' && path.isAbsolute(config.folder) ? config.folder : null;
    } catch {
      selectedFolder = null;
    }
    return selectedFolder;
  }

  return {
    async getClipFolder() {
      return { selected: Boolean(await getFolder()) };
    },
    async pickClipFolder() {
      try {
        const folder = await pickDirectory();
        if (!folder) return { selected: Boolean(await getFolder()), cancelled: true };
        const configPath = getConfigPath();
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, JSON.stringify({ folder }), 'utf8');
        selectedFolder = folder;
        return { selected: true };
      } catch {
        return { selected: Boolean(await getFolder()), error: 'Could not select a folder.' };
      }
    },
    async forgetClipFolder() {
      selectedFolder = null;
      await fs.rm(getConfigPath(), { force: true });
    },
    async saveClip(filename, bytes) {
      const folder = await getFolder();
      if (!folder) return { ok: false, error: 'No folder selected.' };
      if (typeof filename !== 'string' || !filename || filename !== path.basename(filename)
          || /[<>:"/\\|?*\u0000-\u001F]/.test(filename) || !/\.(webm|mp4)$/i.test(filename)
          || !(bytes instanceof Uint8Array || bytes instanceof ArrayBuffer)) {
        return { ok: false, error: 'Invalid clip data.' };
      }
      try {
        // Exclusive creation also prevents following an existing file's symlink.
        await fs.writeFile(path.join(folder, filename), Buffer.from(bytes), { flag: 'wx' });
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not save the clip to the selected folder.' };
      }
    },
  };
}

module.exports = { createClipStorage };
