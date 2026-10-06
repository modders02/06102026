"""Exercise the installed Electron renderer origin against a synthetic camera.

Run from the repository root with:
  local-server/.venv/Scripts/python.exe -m unittest discover -s local-server/tests -p test_electron_playback.py -v

No physical camera, user profile or visible desktop window is used.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_live_bridge import live_fixture, resolve_exe


ROOT = Path(__file__).resolve().parents[2]
ELECTRON = ROOT / "node_modules" / "electron" / "dist" / (
    "electron.exe" if os.name == "nt" else "electron"
)

MAIN = r"""
const { app, BrowserWindow, protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { registerAppScheme, registerAppProtocol } = require(APP_PROTOCOL_HELPER);
registerAppScheme(protocol);
let stage = 'Electron startup';
const finish = result => {
  fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result));
  app.exit(result.error ? 1 : 0);
};
process.on('uncaughtException', error => finish({ error: error.message }));
process.on('unhandledRejection', error => finish({ error: String(error) }));
fs.mkdirSync(path.join(__dirname, 'profile'), { recursive: true });
app.setPath('userData', path.join(__dirname, 'profile'));
setTimeout(() => finish({ error: `Electron playback probe timed out during ${stage}` }), 45000);
app.whenReady().then(async () => {
  registerAppProtocol({ protocol, net, rootDir: __dirname });
  const window = new BrowserWindow({
    show: false, width: 640, height: 360,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message);
  });
  try {
    stage = 'renderer page load';
    await window.loadURL('msds://app/playback.html');
    stage = 'WebRTC and HLS playback';
    const result = await window.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, 'probe.js'), 'utf8'));
    finish(result);
  } catch (error) {
    finish({ error: error.message });
  }
});
"""

PROBE = r"""
(async () => {
  const endpoints = ENDPOINTS;
  const video = document.querySelector('video');
  const results = { origin: location.origin };
  let client = null;
  let hls = null;
  const measure = async name => {
    const deadline = Date.now() + 12000;
    while (video.readyState < 2) {
      if (Date.now() > deadline) throw new Error(name + ': no first video frame');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await video.play();
    const counter = CameraPlayback.createPlaybackFrameCounter(video);
    await new Promise(resolve => setTimeout(resolve, 2000));
    const sample = counter.sample();
    const quality = video.getVideoPlaybackQuality();
    results[name] = { ...sample, decoded: quality.totalVideoFrames, width: video.videoWidth };
    if (!sample.advanced || sample.fps < 5) throw new Error(name + ': video stopped advancing: ' + JSON.stringify(results[name]));
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebRTC did not provide camera tracks')), 12000);
      client = CameraPlayback.openCameraWebRtc(endpoints.whep, {
        onStream: stream => { clearTimeout(timer); video.srcObject = stream; resolve(); },
        onError: error => { clearTimeout(timer); reject(error); },
      });
    });
    await measure('webrtc');
    client.close(); client = null;
    video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load();
    if (!CameraPlayback.Hls.isSupported()) throw new Error('HLS unsupported');
    hls = new CameraPlayback.Hls({ lowLatencyMode: true, maxBufferLength: 6, backBufferLength: 0 });
    hls.on(CameraPlayback.Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) results.hlsError = data.details;
    });
    hls.loadSource(endpoints.hls); hls.attachMedia(video);
    await measure('hls');
    return results;
  } catch (error) {
    return { ...results, error: error.message };
  } finally {
    client?.close(); hls?.destroy(); video.pause();
  }
})()
"""


@unittest.skipUnless(
    ELECTRON.is_file() and resolve_exe("ffmpeg", "FFMPEG_EXE") and resolve_exe("mediamtx", "MEDIAMTX_EXE"),
    "Install Node dependencies and local-server binaries for Electron playback integration",
)
class ElectronPlaybackTests(unittest.TestCase):
    def test_installed_app_origin_decodes_webrtc_and_hls_and_measures_fps(self):
        with live_fixture(timestamped=True) as live, tempfile.TemporaryDirectory(prefix="msds_electron_playback_") as folder:
            work = Path(folder)
            imports = "\n".join([
                f"export {{ openCameraWebRtc }} from {json.dumps((ROOT / 'src/lib/cameraWebRtc.ts').as_posix())};",
                f"export {{ createPlaybackFrameCounter }} from {json.dumps((ROOT / 'src/lib/cameraPlayback.ts').as_posix())};",
                f"export {{ default as Hls }} from {json.dumps((ROOT / 'node_modules/hls.js/dist/hls.mjs').as_posix())};",
            ])
            (work / "entry.ts").write_text(imports, encoding="utf8")
            build = subprocess.run(
                ["node", "-e", "require('esbuild').buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,format:'iife',globalName:'CameraPlayback',platform:'browser'})",
                 str(work / "entry.ts"), str(work / "playback.js")],
                cwd=ROOT, capture_output=True, text=True, timeout=20,
            )
            self.assertEqual(build.returncode, 0, build.stderr)
            (work / "main.cjs").write_text(
                MAIN.replace("APP_PROTOCOL_HELPER", json.dumps(str(ROOT / "electron/rendererProtocol.cjs"))),
                encoding="utf8",
            )
            (work / "playback.html").write_text(
                '<!doctype html><video muted autoplay playsinline crossorigin="anonymous"></video><script src="playback.js"></script>',
                encoding="utf8",
            )
            endpoints = {"whep": live["whep"], "hls": live["hls"]}
            (work / "probe.js").write_text(PROBE.replace("ENDPOINTS", json.dumps(endpoints)), encoding="utf8")
            env = os.environ.copy()
            env.pop("ELECTRON_RUN_AS_NODE", None)
            # Chromium descendants may inherit standard handles. Files prevent
            # communicate() from waiting for orphaned PIPE readers on timeout.
            with (work / "electron.log").open("wb") as log:
                process = subprocess.Popen(
                    [str(ELECTRON), str(work / "main.cjs")],
                    cwd=ROOT, env=env, stdout=log, stderr=log,
                )
                try:
                    process.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                    else:
                        process.kill()
                    process.wait(timeout=10)
                    self.fail("Electron did not finish the playback probe")
            result_path = work / "result.json"
            self.assertTrue(result_path.is_file(), (work / "electron.log").read_text(errors="replace")[-2000:])
            result = json.loads(result_path.read_text(encoding="utf8"))
            self.assertNotIn("error", result, {
                **result, "electron_log": (work / "electron.log").read_text(errors="replace")[-2000:],
            })
            self.assertEqual(process.returncode, 0, result)
            self.assertEqual(result["origin"], "msds://app")
            print("Electron installed-origin playback:", json.dumps(result), flush=True)


if __name__ == "__main__":
    unittest.main()
