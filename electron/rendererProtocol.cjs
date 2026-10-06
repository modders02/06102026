const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_SCHEME = 'msds';
const APP_URL = 'msds://app/index.html';
const STORAGE_URL = 'msds://app/__storage-migration__';

// MediaMTX rejects opaque file:// origins on WHEP POST requests. Give the
// packaged renderer a standard origin while keeping its files local.
function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

function registerAppProtocol({ protocol, net, rootDir }) {
  const root = path.resolve(rootDir);
  protocol.handle(APP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    let url;
    let pathname;
    try {
      url = new URL(request.url);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response('Invalid app URL', { status: 400 });
    }
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== 'app' || url.username || url.password) {
      return new Response('Not found', { status: 404 });
    }
    if (url.pathname === '/__storage-migration__') {
      return new Response('<!doctype html><title>MSDS</title>', {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    // Decoding before checking also catches encoded slashes and Windows paths.
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.includes(':')) {
      return new Response('Invalid asset path', { status: 400 });
    }
    const asset = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const relative = path.relative(root, asset);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return new Response('Invalid asset path', { status: 400 });
    }
    try {
      return await net.fetch(pathToFileURL(asset).href, { method: request.method });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

module.exports = { APP_URL, STORAGE_URL, registerAppScheme, registerAppProtocol };
