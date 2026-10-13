import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  _extractLatestExtensionVersionFromReleases as extractLatestExtensionVersionFromReleases,
  _buildUpdateNotices as buildUpdateNotices,
  _EXTENSION_STALE_MS as EXTENSION_STALE_MS,
} from './update-check.js';

describe('extractLatestExtensionVersionFromReleases', () => {
  it('reads the extension version from a versioned asset on a normal CLI release', () => {
    expect(
      extractLatestExtensionVersionFromReleases([
        {
          tag_name: 'v1.7.3',
          assets: [
            { name: 'opencli-extension.zip' },
            { name: 'opencli-extension-v1.0.2.zip' },
          ],
        },
      ]),
    ).toBe('1.0.2');
  });

  it('falls back to ext-v tags for extension-only releases', () => {
    expect(
      extractLatestExtensionVersionFromReleases([
        {
          tag_name: 'ext-v1.1.0',
          assets: [{ name: 'opencli-extension.zip' }],
        },
      ]),
    ).toBe('1.1.0');
  });

  it('returns undefined when no extension version source exists', () => {
    expect(
      extractLatestExtensionVersionFromReleases([
        {
          tag_name: 'v1.7.3',
          assets: [{ name: 'opencli-extension.zip' }],
        },
      ]),
    ).toBeUndefined();
  });
});

describe('buildUpdateNotices', () => {
  const now = 1_700_000_000_000;

  it('returns nothing when cache is empty', () => {
    expect(buildUpdateNotices({ cliVersion: '1.0.0', cache: null, now })).toEqual({});
  });

  it('emits a CLI notice when registry version is newer', () => {
    const lines = buildUpdateNotices({
      cliVersion: '1.0.0',
      cache: { lastCheck: now, latestVersion: '1.0.1' },
      now,
    });
    expect(lines.cli).toContain('v1.0.0 → v1.0.1');
    expect(lines.extension).toBeUndefined();
  });

  it('emits an extension notice when current ext is older and cache is fresh', () => {
    const lines = buildUpdateNotices({
      cliVersion: '1.0.0',
      cache: {
        lastCheck: now,
        latestVersion: '1.0.0',
        latestExtensionVersion: '2.1.0',
        currentExtensionVersion: '2.0.0',
        extensionLastSeenAt: now - 60_000,
      },
      now,
    });
    expect(lines.cli).toBeUndefined();
    expect(lines.extension).toContain('v2.0.0 → v2.1.0');
  });

  it('skips the extension notice when lastSeenAt is older than the stale window', () => {
    const lines = buildUpdateNotices({
      cliVersion: '1.0.0',
      cache: {
        lastCheck: now,
        latestVersion: '1.0.0',
        latestExtensionVersion: '2.1.0',
        currentExtensionVersion: '2.0.0',
        extensionLastSeenAt: now - EXTENSION_STALE_MS - 1,
      },
      now,
    });
    expect(lines.extension).toBeUndefined();
  });

  it('skips the extension notice when current and latest are equal', () => {
    const lines = buildUpdateNotices({
      cliVersion: '1.0.0',
      cache: {
        lastCheck: now,
        latestVersion: '1.0.0',
        latestExtensionVersion: '2.0.0',
        currentExtensionVersion: '2.0.0',
        extensionLastSeenAt: now,
      },
      now,
    });
    expect(lines.extension).toBeUndefined();
  });

  it('does not throw when cache has only daemon-written fields and no latestVersion', () => {
    const lines = buildUpdateNotices({
      cliVersion: '1.0.0',
      cache: {
        currentExtensionVersion: '2.0.0',
        extensionLastSeenAt: now,
      },
      now,
    });
    expect(lines.cli).toBeUndefined();
    expect(lines.extension).toBeUndefined();
  });

  it('emits both notices when both are out of date', () => {
    const lines = buildUpdateNotices({
      cliVersion: '1.0.0',
      cache: {
        lastCheck: now,
        latestVersion: '1.1.0',
        latestExtensionVersion: '2.1.0',
        currentExtensionVersion: '2.0.0',
        extensionLastSeenAt: now,
      },
      now,
    });
    expect(lines.cli).toContain('v1.0.0 → v1.1.0');
    expect(lines.extension).toContain('v2.0.0 → v2.1.0');
  });
});


describe('independent update schedules', () => {
  let cacheHome: string;
  afterEach(() => {
    vi.doUnmock('node:os');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (cacheHome) fs.rmSync(cacheHome, { recursive: true, force: true });
  });

  it.each(['npm', 'github'])('retries a failed %s lookup independently of the other cache', async (failedService) => {
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencli-update-schedule-'));
    vi.doMock('node:os', () => ({ ...os, homedir: () => cacheHome }));
    vi.stubEnv('CI', '');
    vi.stubEnv('CONTINUOUS_INTEGRATION', '');
    const cacheDir = path.join(cacheHome, '.opencli');
    const cacheFile = path.join(cacheDir, 'update-check.json');
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(cacheFile, JSON.stringify({ currentExtensionVersion: '1.0.0', extensionLastSeenAt: Date.now() }));
    const read = () => JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    let fail = true;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const service = String(url).includes('github.com') ? 'github' : 'npm';
      if (service === failedService && fail) return new Response('', { status: 403 });
      return new Response(JSON.stringify(service === 'npm' ? { version: '9.0.0' }
        : [{ tag_name: 'ext-v9.0.0' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.resetModules();
    const { checkForUpdateBackground } = await import('./update-check.js');
    checkForUpdateBackground();
    const successKey = failedService === 'npm' ? 'latestExtensionVersion' : 'latestVersion';
    const failedKey = failedService === 'npm' ? 'latestVersion' : 'latestExtensionVersion';
    await vi.waitFor(() => expect(read()[successKey]).toBe('9.0.0'));
    expect(read()[failedKey]).toBeUndefined();
    expect(read().currentExtensionVersion).toBe('1.0.0');
    const successfulCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes(failedService === 'npm' ? 'github.com' : 'npmjs.org')).length;
    const callsBeforeRetry = fetchMock.mock.calls.length;
    checkForUpdateBackground();
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRetry);
    fail = false;
    // Move beyond a short retry backoff, but well inside the 24-hour success window.
    const now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now + 10 * 60 * 1000);
    vi.resetModules();
    (await import('./update-check.js')).checkForUpdateBackground();
    await vi.waitFor(() => expect(read()[failedKey]).toBe('9.0.0'));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes(failedService === 'npm' ? 'github.com' : 'npmjs.org'))).toHaveLength(successfulCalls);
  });
});
