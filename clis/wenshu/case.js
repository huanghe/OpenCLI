import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { requireNonEmptyQuery } from '../_shared/common.js';

/**
 * 中国裁判文书网按案号精确检索：
 *   opencli wenshu case "(2020)京民申1858号"
 *
 * 适用场景：已知具体案号（例如来自类案检索报告或律师同业转引），
 *           直接拉取裁判文书网上的对应文书条目并返回 URL 与基础元数据。
 */
cli({
    site: 'wenshu',
    name: 'case',
    description: '裁判文书网按案号精确检索（需先在浏览器中登录）',
    domain: 'wenshu.court.gov.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'caseNo', positional: true, required: true, help: '案号，例如 "(2020)京民申1858号"' },
    ],
    columns: ['rank', 'title', 'case_no', 'court', 'judgment_date', 'url'],
    navigateBefore: false,
    func: async (page, kwargs) => {
        const caseNo = requireNonEmptyQuery(kwargs.caseNo, 'caseNo');

        await page.goto('https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html');
        await page.wait(4);

        const loggedIn = await page.evaluate(`
      (() => /login|user\\/login/i.test(location.href || '') ? false : true)()
    `);
        if (!loggedIn) {
            throw new CliError(
                'NOT_LOGGED_IN',
                '裁判文书网未登录，无法按案号检索。',
                '请先在 Chrome 中打开 https://wenshu.court.gov.cn 完成登录后再运行本命令。'
            );
        }

        const encoded = JSON.stringify(caseNo);
        await page.evaluate(`
      (async () => {
        // 打开高级检索抽屉，输入案号
        const adv = document.querySelector('a[href*="advanceSearch"], .advanced-search, .high-search');
        if (adv) { adv.click(); await new Promise(r => setTimeout(r, 600)); }
        const input = document.querySelector('input[placeholder*="案号"], input[name="ah"]');
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, ${encoded});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const btn = document.querySelector('.search-btn, button.searchBtn, input[type="submit"][value*="搜索"]');
        if (btn) btn.click();
        else {
          const form = document.querySelector('form#cpws-new-searchForm, form.search-form, form');
          if (form) form.submit();
        }
      })()
    `);

        await page.wait(8);

        const data = await page.evaluate(`
      (async () => {
        const normalize = v => (v || '').replace(/\\s+/g, ' ').trim();
        for (let i = 0; i < 60; i++) {
          if (document.querySelectorAll('.LM_list, .item-list .item, .list-content .item, .resultList .item').length > 0) break;
          await new Promise(r => setTimeout(r, 500));
        }
        const items = document.querySelectorAll('.LM_list, .item-list .item, .list-content .item, .resultList .item');
        const results = [];
        for (const el of items) {
          const titleA = el.querySelector('a.caseName, .case-name a, h4 a, .title a, a[href*="paper"]');
          const title = normalize(titleA?.textContent);
          if (!title) continue;
          let url = titleA?.getAttribute('href') || '';
          if (url && !url.startsWith('http')) {
            url = url.startsWith('/') ? 'https://wenshu.court.gov.cn' + url : 'https://wenshu.court.gov.cn/' + url;
          }
          const text = normalize(el.textContent);
          const caseNoMatch = text.match(/[（(]\\s*\\d{4}\\s*[）)][^，。\\s]{0,40}号/);
          const cn = caseNoMatch ? caseNoMatch[0] : '';
          const dateMatch = text.match(/\\d{4}-\\d{2}-\\d{2}/);
          const judgmentDate = dateMatch ? dateMatch[0] : '';
          const courtNode = el.querySelector('.court, .fy, span[class*="court"]');
          let court = normalize(courtNode?.textContent);
          if (!court) {
            const m2 = text.match(/[\\u4e00-\\u9fa5]{2,30}人民法院/);
            if (m2) court = m2[0];
          }
          results.push({
            rank: results.length + 1,
            title,
            case_no: cn,
            court,
            judgment_date: judgmentDate,
            url,
          });
        }
        return results;
      })()
    `);
        if (!Array.isArray(data) || data.length === 0) {
            throw new CliError(
                'NO_RESULTS',
                '该案号在裁判文书网上未检索到任何记录。',
                '可能原因：(1) 该案文书未公开或已下架；(2) 案号格式存在差异（请改用半角括号尝试）。'
            );
        }
        return data;
    },
});
