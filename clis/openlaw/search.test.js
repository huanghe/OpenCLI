import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './search.js';

describe('openlaw search command', () => {
    const command = getRegistry().get('openlaw/search');

    it('registers as a public browser command', () => {
        expect(command).toBeDefined();
        expect(command.site).toBe('openlaw');
        expect(command.strategy).toBe('public');
        expect(command.browser).toBe(true);
    });

    it('exposes documented columns', () => {
        expect(command.columns).toEqual(
            expect.arrayContaining(['rank', 'title', 'case_no', 'court', 'judgment_date', 'cause', 'url'])
        );
    });

    it('rejects empty queries before browser navigation', async () => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn() };
        await expect(command.func(page, { query: '   ' })).rejects.toMatchObject({
            name: 'ArgumentError',
            code: 'ARGUMENT',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });
});
