import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Request = { url: string; method: string };
class FakeResponse {
  status: number;
  constructor(readonly body: string, options: { status?: number } = {}) {
    this.status = options.status ?? 200;
  }
}
type ProtocolHelpers = {
  APP_URL: string;
  registerAppScheme: (protocol: { registerSchemesAsPrivileged: ReturnType<typeof vi.fn> }) => void;
  registerAppProtocol: (options: unknown) => void;
};

function fixture() {
  const module = { exports: {} as ProtocolHelpers };
  vm.runInNewContext(fs.readFileSync(path.resolve('electron/rendererProtocol.cjs'), 'utf8'), {
    module, require: createRequire(import.meta.url), URL, Response: FakeResponse,
  });
  const root = path.resolve('dist');
  let handler!: (request: Request) => Promise<FakeResponse>;
  const protocol = {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn((_scheme: string, value: typeof handler) => { handler = value; }),
  };
  const net = { fetch: vi.fn().mockResolvedValue(new FakeResponse('asset')) };
  module.exports.registerAppProtocol({ protocol, net, rootDir: root });
  return { helpers: module.exports, root, protocol, net, request: (url: string, method = 'GET') => handler({ url, method }) };
}

describe('packaged renderer origin', () => {
  it('registers a standard secure origin with browser security enabled', () => {
    const { helpers, protocol } = fixture();
    helpers.registerAppScheme(protocol);
    expect(helpers.APP_URL).toBe('msds://app/index.html');
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: 'msds', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    }]);
  });

  it('serves the entry point and encoded asset names from the renderer bundle', async () => {
    const { root, net, request } = fixture();
    expect((await request('msds://app/')).status).toBe(200);
    expect(net.fetch).toHaveBeenLastCalledWith(pathToFileURL(path.join(root, 'index.html')).href, { method: 'GET' });
    await request('msds://app/assets/camera%20preview.js?version=2');
    expect(net.fetch).toHaveBeenLastCalledWith(pathToFileURL(path.join(root, 'assets', 'camera preview.js')).href, { method: 'GET' });
  });

  it.each([
    'msds://other/index.html',
    'msds://user@app/index.html',
    'msds://app/%2e%2e%2fsecret.txt',
    'msds://app/%5c..%5csecret.txt',
    'msds://app/C%3A/secret.txt',
    'msds://app/%00secret.txt',
    'msds://app/%invalid',
  ])('rejects requests outside the renderer bundle: %s', async url => {
    const { net, request } = fixture();
    expect((await request(url)).status).toBeGreaterThanOrEqual(400);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('rejects writes and returns 404 when an asset is unavailable', async () => {
    const { net, request } = fixture();
    expect((await request('msds://app/index.html', 'POST')).status).toBe(405);
    expect(net.fetch).not.toHaveBeenCalled();
    net.fetch.mockRejectedValueOnce(new Error('missing file'));
    expect((await request('msds://app/missing.js')).status).toBe(404);
  });

  it('provides an empty page for migrating saved settings before React loads', async () => {
    const { net, request } = fixture();
    expect((await request('msds://app/__storage-migration__')).status).toBe(200);
    expect(net.fetch).not.toHaveBeenCalled();
  });
});
