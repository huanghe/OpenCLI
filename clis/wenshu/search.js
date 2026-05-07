import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { clampInt, requireNonEmptyQuery } from '../_shared/common.js';

/**
 * 中国裁判文书网（wenshu.court.gov.cn）全文检索适配器。
 *
 * 实现说明：
 * - 裁判文书网自 2024 年起对全部检索功能强制登录。本适配器使用 COOKIE
 *   策略，复用浏览器中已登录的会话；用户在自己的 Chrome 中预先登录后再
 *   调用本命令即可。
 * - 主搜索表单 #cpws-new-searchForm 使用 POST 方式，仅靠 URL 参数无法触发
 *   过滤，因此本适配器在页面加载后通过 DOM 注入关键字并提交表单。
 * - 检索结果列表 .article-list / .list-content 内每条文书包含标题、案号、
 *   法院、裁判日期等字段；本适配器对页面 DOM 做了一次健壮性兜底。
 * - 由于网站反爬较严，结果数量上限保留为 20，超过后请通过其他过滤条件
 *   （案由、法院、时间区间）继续缩小范围。
 */
cli({
    site: 'wenshu',
    name: 'search',
    description: '中国裁判文书网全文检索（需先在浏览器中登录）',
    domain: 'wenshu.court.gov.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'query', positional: true, required: true, help: '全文检索关键词，多个词以空格分隔' },
        { name: 'limit', type: 'int', default: 10, help: '返回结果数量 (max 20)' },
        { name: 'court', type: 'str', default: '', help: '法院名称过滤，例如 "北京市第一中级人民法院"' },
        { name: 'cause', type: 'str', default: '', help: '案由过滤，例如 "合同纠纷"' },
        { name: 'start', type: 'str', default: '', help: '裁判日期起 (YYYY-MM-DD)' },
        { name: 'end', type: 'str', default: '', help: '裁判日期止 (YYYY-MM-DD)' },
    ],
    columns: ['rank', 'title', 'case_no', 'court', 'judgment_date', 'url'],
    navigateBefore: false,
    func: async (page, kwargs) => {
        const limit = clampInt(kwargs.limit, 10, 1, 20);
        const query = requireNonEmptyQuery(kwargs.query);
        const court = String(kwargs.court || '').trim();
        const cause = String(kwargs.cause || '').trim();
        const start = String(kwargs.start || '').trim();
        const end = String(kwargs.end || '').trim();

        await page.goto('https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html');
        await page.wait(4);

        // 登录态检查 —— 未登录会被跳转到 /website/wenshu/.../login 页面
        const loggedIn = await page.evaluate(`
      (() => {
        const url = location.href || '';
        if (/login|user\\/login/i.test(url)) return false;
        // 主搜索框 #_view_xxxx 形式存在则已登录
        return Boolean(document.querySelector('#_view_1545184311000 input, .search-wrapper input[type="text"]'));
      })()
    `);
        if (!loggedIn) {
            throw new CliError(
                'NOT_LOGGED_IN',
                '裁判文书网未登录，无法执行检索。',
                '请先在 Chrome 中打开 https://wenshu.court.gov.cn 完成登录后再运行本命令。'
            );
        }

        // 注入查询条件 + 提交
        const payload = JSON.stringify({ query, court, cause, start, end });
        await page.evaluate(`
      (async () => {
        const cfg = ${payload};
        const setVal = (sel, v) => {
          const el = document.querySelector(sel);
          if (!el || !v) return;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        // 主关键字
        setVal('input[placeholder*="案由"], input[placeholder*="关键词"], input.search-input, #qbValue', cfg.query);
        // 法院 / 案由 / 日期 —— 这些字段位于「高级检索」抽屉中
        if (cfg.court || cfg.cause || cfg.start || cfg.end) {
          const adv = document.querySelector('a[href*="advanceSearch"], .advanced-search, .high-search');
          if (adv) adv.click();
          await new Promise(r => setTimeout(r, 600));
          setVal('input[placeholder*="法院名称"]', cfg.court);
          setVal('input[placeholder*="案由"]', cfg.cause);
          setVal('input[placeholder*="开始"], input[name="cprqStart"]', cfg.start);
          setVal('input[placeholder*="结束"], input[name="cprqEnd"]', cfg.end);
        }
        // 提交
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
        // 等待结果列表 —— 不同时期 DOM 形态略有差异
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
          // 案号识别 —— 形如 (2020)京01民终1234号
          const caseNoMatch = text.match(/[（(]\\s*\\d{4}\\s*[）)][^，。\\s]{0,40}号/);
          const caseNo = caseNoMatch ? caseNoMatch[0] : normalize(el.querySelector('.case-num, .ah, span[class*="case"]')?.textContent);
          const dateMatch = text.match(/\\d{4}-\\d{2}-\\d{2}/);
          const judgmentDate = dateMatch ? dateMatch[0] : normalize(el.querySelector('.date, .cprq, span[class*="date"]')?.textContent);
          const courtNode = el.querySelector('.court, .fy, span[class*="court"]');
          let court = normalize(courtNode?.textContent);
          if (!court) {
            const m2 = text.match(/[\\u4e00-\\u9fa5]{2,30}人民法院/);
            if (m2) court = m2[0];
          }
          results.push({
            rank: results.length + 1,
            title,
            case_no: caseNo,
            court,
            judgment_date: judgmentDate,
            url,
          });
          if (results.length >= ${limit}) break;
        }
        return results;
      })()
    `);
        if (!Array.isArray(data) || data.length === 0) {
            throw new CliError(
                'NO_RESULTS',
                '未在裁判文书网检索到任何结果。',
                '可能原因：(1) 关键字过窄，请尝试拆分；(2) 网站 DOM 已升级，请通过 issue 反馈以更新适配器。'
            );
        }
        return data;
    },
});
