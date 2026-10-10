/**
 * E2E tests for management/built-in commands.
 * These commands require no external network access (except verify --smoke).
 */

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { runCli, parseJsonOutput } from './helpers.js';

describe('management commands E2E', () => {

  // ── list ──
  it('list shows all registered commands', async () => {
    const { stdout, code } = await runCli(['list', '-f', 'json']);
    expect(code).toBe(0);
    const data = parseJsonOutput(stdout);
    expect(Array.isArray(data)).toBe(true);
    // Should have 50+ commands across 18 sites
    expect(data.length).toBeGreaterThan(50);
    // Each entry should have the standard fields
    expect(data[0]).toHaveProperty('command');
    expect(data[0]).toHaveProperty('site');
    expect(data[0]).toHaveProperty('name');
    expect(data[0]).toHaveProperty('strategy');
    expect(data[0]).toHaveProperty('browser');
  });

  it('list default table format renders sites', async () => {
    const { stdout, code } = await runCli(['list']);
    expect(code).toBe(0);
    // Should contain site names
    expect(stdout).toContain('hackernews');
    expect(stdout).toContain('bilibili');
    expect(stdout).toContain('twitter');
    expect(stdout).toContain('commands across');
  });

  it('list -f yaml produces valid yaml', async () => {
    const { stdout, code } = await runCli(['list', '-f', 'yaml']);
    expect(code).toBe(0);
    expect(stdout).toContain('command:');
    expect(stdout).toContain('site:');
  });

  it('list -f csv produces valid csv', async () => {
    const { stdout, code } = await runCli(['list', '-f', 'csv']);
    expect(code).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(50);
  });

  it('list -f md produces markdown table', async () => {
    const { stdout, code } = await runCli(['list', '-f', 'md']);
    expect(code).toBe(0);
    expect(stdout).toContain('|');
    expect(stdout).toContain('command');
  });

  // ── validate ──
  it('validate passes for all built-in adapters', async () => {
    const { stdout, code } = await runCli(['validate']);
    expect(code).toBe(0);
    expect(stdout).toContain('PASS');
    expect(stdout).not.toContain('❌');
  });

  it('validate works for specific site', async () => {
    const { stdout, code } = await runCli(['validate', 'hackernews']);
    expect(code).toBe(0);
    expect(stdout).toContain('PASS');
  });

  it('validate works for specific command', async () => {
    const { stdout, code } = await runCli(['validate', 'hackernews/top']);
    expect(code).toBe(0);
    expect(stdout).toContain('PASS');
  });

  // ── verify ──
  it('verify runs validation without smoke tests', async () => {
    const { stdout, code } = await runCli(['verify']);
    expect(code).toBe(0);
    expect(stdout).toContain('PASS');
  });

  // ── version ──
  it('--version shows version number', async () => {
    const { stdout, code } = await runCli(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // ── help ──
  it('--help shows usage', async () => {
    const { stdout, code } = await runCli(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('opencli');
    expect(stdout).toContain('list');
    expect(stdout).toContain('validate');
  });

  // ── unknown command ──
  it('unknown command shows error', async () => {
    const { stderr, code } = await runCli(['nonexistent-command-xyz']);
    expect(code).toBe(2);
  });
});

// Run removal checks against a legacy config in an isolated home directory.
describe('removed integrations E2E', () => {
  const removedSites = [
    'cursor', 'codex', 'chatwise', 'discord-app', 'doubao-app',
    'antigravity', 'chatgpt-app', 'qoder', 'trae-solo', 'trae-cn',
  ];
  let home: string;
  let env: Record<string, string>;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'opencli-removed-integrations-'));
    env = { HOME: home, USERPROFILE: home, CI: '1' };
    mkdirSync(join(home, '.opencli'), { recursive: true });
    writeFileSync(join(home, '.opencli', 'external-clis.yaml'), '- name: legacy-cli\n  binary: echo\n');
    writeFileSync(join(home, '.opencli', 'apps.yaml'), 'apps:\n  legacy-app:\n    port: 9229\n    processName: Legacy\n');
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('excludes removed adapters from discovery and fast completions', async () => {
    const listed = await runCli(['list', '-f', 'json'], { env });
    expect(listed.code).toBe(0);
    const sites = parseJsonOutput(listed.stdout).map((entry: { site: string }) => entry.site);
    expect(sites).toContain('hackernews');
    for (const site of removedSites) expect(sites).not.toContain(site);

    const completed = await runCli(['--get-completions', '--cursor', '0'], { env });
    expect(completed.code).toBe(0);
    const candidates = completed.stdout.trim().split('\n');
    expect(candidates).toContain('hackernews');
    for (const name of [...removedSites, 'external', 'legacy-cli', 'legacy-app']) {
      expect(candidates).not.toContain(name);
    }
  });

  it('lists browser skills without sitemap guidance', async () => {
    const result = await runCli(['skills', 'list', '-f', 'json'], { env });
    expect(result.code).toBe(0);
    const names = parseJsonOutput(result.stdout).map((entry: { name: string }) => entry.name);
    expect(names).toContain('opencli-browser');
    expect(names).not.toContain('opencli-browser-sitemap');
    expect(names).not.toContain('opencli-sitemap-author');
  });

  it('publishes only website adapters in structured root help', async () => {
    const result = await runCli(['--help', '-f', 'json'], { env });
    expect(result.code).toBe(0);
    const help = parseJsonOutput(result.stdout);
    expect(help.site_adapters.sites).toContain('hackernews');
    expect(help).not.toHaveProperty('app_adapters');
    expect(help).not.toHaveProperty('external_clis');
    expect(help.commands.map((entry: { name: string }) => entry.name)).not.toContain('external');
  });

  it('clears removed official overrides during upgrade and preserves custom sites', () => {
    const configDir = join(home, '.opencli');
    const oldFiles = [...removedSites.map(site => `${site}/status.js`), '_shared/desktop-commands.js'];
    for (const file of oldFiles) {
      const target = join(configDir, 'clis', file);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, '// Old official adapter');
    }
    const customDir = join(configDir, 'clis', 'my-custom-site');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'hello.js'), '// User-created adapter');
    writeFileSync(join(configDir, 'adapter-manifest.json'), JSON.stringify({
      version: '0.0.0', files: oldFiles, hashes: {},
    }));

    execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/fetch-adapters.js', import.meta.url))], {
      env: { ...process.env, ...env, CI: '', CONTINUOUS_INTEGRATION: '', OPENCLI_FETCH: '1' },
    });

    for (const file of oldFiles) expect(existsSync(join(configDir, 'clis', file))).toBe(false);
    expect(readFileSync(join(customDir, 'hello.js'), 'utf8')).toBe('// User-created adapter');
    const manifest = JSON.parse(readFileSync(join(configDir, 'adapter-manifest.json'), 'utf8'));
    for (const file of oldFiles) expect(manifest.files).not.toContain(file);
  });

  it.each([...removedSites, 'external', 'gh', 'docker', 'legacy-cli', 'legacy-app', 'sitemap'])(
    'rejects the removed or legacy command %s', async (name) => {
      const result = await runCli([name], { env });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(`unknown command '${name}'`);
    },
  );
});
