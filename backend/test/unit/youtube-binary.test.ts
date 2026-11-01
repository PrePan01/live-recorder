import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const filesystem = vi.hoisted(() => ({ exists: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: filesystem.exists,
}));
import { youtubeBinary } from '../../src/platform/youtube/runtime.js';

const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const bundled = path.join(path.dirname(process.execPath), binaryName);
const development = fileURLToPath(new URL(`../../../frontend/src-tauri/.bundle/${binaryName}`, import.meta.url));
const bundledDirectory = path.join(path.dirname(process.execPath), 'youtube-runtime', 'yt-dlp_macos');
const developmentDirectory = fileURLToPath(new URL('../../../frontend/src-tauri/.bundle/youtube-runtime/yt-dlp_macos', import.meta.url));

beforeEach(() => {
  filesystem.exists.mockReset().mockReturnValue(false);
  vi.stubEnv('LR_YTDLP_PATH', undefined);
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('YouTube extractor location after platform reorganization', () => {
  it('honors an explicit executable without probing packaged resources', () => {
    vi.stubEnv('LR_YTDLP_PATH', '/custom/yt-dlp');
    expect(youtubeBinary()).toBe('/custom/yt-dlp');
    expect(filesystem.exists).not.toHaveBeenCalled();
  });

  it('finds the flat executable next to the bundled node runtime', () => {
    filesystem.exists.mockImplementation(candidate => candidate === bundled);
    expect(youtubeBinary()).toBe(bundled);
  });

  it('still finds the development executable in frontend/src-tauri/.bundle', () => {
    filesystem.exists.mockImplementation(candidate => candidate === development);
    expect(youtubeBinary()).toBe(development);
  });

  it.skipIf(process.platform !== 'darwin')('still finds the macOS development runtime directory', () => {
    filesystem.exists.mockImplementation(candidate => candidate === developmentDirectory);
    expect(youtubeBinary()).toBe(developmentDirectory);
  });

  it.skipIf(process.platform !== 'darwin')('prefers the packaged macOS runtime directory to development resources', () => {
    filesystem.exists.mockImplementation(candidate => [bundledDirectory, developmentDirectory].includes(candidate));
    expect(youtubeBinary()).toBe(bundledDirectory);
  });
});
