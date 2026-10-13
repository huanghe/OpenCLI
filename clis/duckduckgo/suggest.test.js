import { afterEach, describe, it, expect, vi } from 'vitest';

const { __test__ } = await import('./suggest.js');
const command = __test__.command;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('duckduckgo suggest', () => {

  it('rejects empty query and invalid limit before fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(command.func({ keyword: '', limit: 5 })).rejects.toMatchObject({ code: 'ARGUMENT' });
    await expect(command.func({ keyword: 'opencli', limit: 21 })).rejects.toMatchObject({ code: 'ARGUMENT' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns filtered suggestion rows from the public API payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ['open', ['opencli', '', 'open source']],
    });

    await expect(command.func({ keyword: 'open', limit: 3 })).resolves.toEqual([
      { phrase: 'opencli' },
      { phrase: 'open source' },
    ]);
  });

  it('maps fetch and malformed JSON failures to typed command errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('offline'));
    await expect(command.func({ keyword: 'open', limit: 3 })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new Error('bad json'); },
    });
    await expect(command.func({ keyword: 'open', limit: 3 })).rejects.toMatchObject({ code: 'COMMAND_EXEC' });
  });
});
