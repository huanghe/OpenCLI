import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@jackwener/opencli/registry';
import './search.js';
import './case.js';

describe('wenshu search command', () => {
    const command = getRegistry().get('wenshu/search');

    it('registers as a cookie-based browser command', () => {
        expect(command).toBeDefined();
        expect(command.site).toBe('wenshu');
        expect(command.strategy).toBe('cookie');
        expect(command.browser).toBe(true);
    });

    it('exposes documented columns', () => {
        expect(command.columns).toEqual(
            expect.arrayContaining(['rank', 'title', 'case_no', 'court', 'judgment_date', 'url'])
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

describe('wenshu case command', () => {
    const command = getRegistry().get('wenshu/case');

    it('registers as a cookie-based browser command', () => {
        expect(command).toBeDefined();
        expect(command.site).toBe('wenshu');
        expect(command.name).toBe('case');
        expect(command.strategy).toBe('cookie');
    });

    it('rejects empty caseNo before browser navigation', async () => {
        const page = { goto: vi.fn(), wait: vi.fn(), evaluate: vi.fn() };
        await expect(command.func(page, { caseNo: '   ' })).rejects.toMatchObject({
            name: 'ArgumentError',
            code: 'ARGUMENT',
        });
        expect(page.goto).not.toHaveBeenCalled();
    });
});
