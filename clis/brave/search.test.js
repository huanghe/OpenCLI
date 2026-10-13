import { describe, it, expect, vi } from 'vitest';

const { __test__ } = await import('./search.js');
const command = __test__.command;

function createPageMock(evaluateResult = []) {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    wait: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(evaluateResult),
  };
}

describe('brave search', () => {

  it('rejects empty query, invalid limit, and invalid offset before navigation', async () => {
    const page = createPageMock();
    await expect(command.func(page, { keyword: '', limit: 5 })).rejects.toMatchObject({ code: 'ARGUMENT' });
    await expect(command.func(page, { keyword: 'opencli', limit: 19 })).rejects.toMatchObject({ code: 'ARGUMENT' });
    await expect(command.func(page, { keyword: 'opencli', limit: 5, offset: -1 })).rejects.toMatchObject({ code: 'ARGUMENT' });
    expect(page.goto).not.toHaveBeenCalled();
  });

  it('unwraps browser envelopes and returns ranked HTTPS rows', async () => {
    const page = createPageMock({
      session: 'site:brave',
      data: [['OpenCLI', 'https://github.com/jackwener/OpenCLI', 'CLI browser tooling']],
    });

    await expect(command.func(page, { keyword: 'opencli', limit: 1, offset: 1 })).resolves.toEqual([{
      rank: 19,
      title: 'OpenCLI',
      url: 'https://github.com/jackwener/OpenCLI',
      snippet: 'CLI browser tooling',
    }]);
  });

  it('fails typed instead of silently returning [] for malformed extraction payloads', async () => {
    const page = createPageMock({ rows: [] });

    await expect(command.func(page, { keyword: 'opencli', limit: 1 })).rejects.toMatchObject({
      code: 'COMMAND_EXEC',
      message: expect.stringContaining('payload shape'),
    });
  });
});
