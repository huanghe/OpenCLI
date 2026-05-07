import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { clampInt, requireNonEmptyQuery } from '../_shared/common.js';

/**
 * OpenLaw（openlaw.cn）裁判文书检索适配器。
 *
 * 设计动机：
 * - 中国裁判文书网（wenshu.court.gov.cn）自 2024 年起对全部检索功能强制
 *   登录，且对单账户每日查询次数有上限。
 * - OpenLaw 是一个长期开放的免登录公开案例库，覆盖范围与裁判文书网高度
 *   重叠，可作为 wenshu 适配器的备用回退源。
 *
 * 使用 PUBLIC 策略，无需 cookie；DOM 选择器做了多版本兜底。
 */
cli({
    site: 'openlaw',
    name: 'search',
    description: 'OpenLaw 裁判文书检索（免登录公开案例库）',
    domain: 'openlaw.cn',
    strategy: Strategy.PUBLIC,
    browser: true,
    args: [
        { name: 'query', positional: true, required: true, help: '检索关键词，多个词以空格分隔' },
        { name: 'limit', type: 'int', default: 10, help: '返回结果数量 (max 30)' },
        { name: 'caseType', type: 'str', default: '', help: '案件类型：刑事/民事/行政/赔偿/执行' },
    ],
    columns: ['rank', 'title', 'case_no', 'court', 'judgment_date', 'cause', 'url'],
    navigateBefore: false,
    func: async (page, kwargs) => {
        const limit = clampInt(kwargs.limit, 10, 1, 30);
        const query = requireNonEmptyQuery(kwargs.query);
        const caseType = String(kwargs.caseType || '').trim();

        const params = new URLSearchParams();
        params.set('keyword', query);
        if (caseType) params.set('caseType', caseType);
        const url = `http://openlaw.cn/search/judgement?${params.toString()}`;

        await page.goto(url);
        await page.wait(5);

        const data = await page.evaluate(`
      (async () => {
        const normalize = v => (v || '').replace(/\\s+/g, ' ').trim();
        for (let i = 0; i < 40; i++) {
          if (document.querySelectorAll('.entry-list .entry, .result-list .result, .judgement-item, li.entry').length > 0) break;
          await new Promise(r => setTimeout(r, 500));
        }
        const items = document.querySelectorAll('.entry-list .entry, .result-list .result, .judgement-item, li.entry');
        const results = [];
        for (const el of items) {
          const titleA = el.querySelector('h4 a, h3 a, .entry-title a, .result-title a, a.title');
          const title = normalize(titleA?.textContent);
          if (!title) continue;
          let href = titleA?.getAttribute('href') || '';
          if (href && !href.startsWith('http')) {
            href = href.startsWith('/') ? 'http://openlaw.cn' + href : 'http://openlaw.cn/' + href;
          }
          const text = normalize(el.textContent);
          const caseNoMatch = text.match(/[（(]\\s*\\d{4}\\s*[）)][^，。\\s]{0,40}号/);
          const caseNo = caseNoMatch ? caseNoMatch[0] : normalize(el.querySelector('.case-num, .ah')?.textContent);
          const courtMatch = text.match(/[\\u4e00-\\u9fa5]{2,30}人民法院/);
          const court = courtMatch ? courtMatch[0] : normalize(el.querySelector('.court')?.textContent);
          const dateMatch = text.match(/(20\\d{2})[-/.年](\\d{1,2})[-/.月](\\d{1,2})/);
          const judgmentDate = dateMatch ? \`\${dateMatch[1]}-\${String(dateMatch[2]).padStart(2,'0')}-\${String(dateMatch[3]).padStart(2,'0')}\` : '';
          const causeNode = el.querySelector('.cause, .case-cause, .ay');
          const cause = normalize(causeNode?.textContent);
          results.push({
            rank: results.length + 1,
            title,
            case_no: caseNo,
            court,
            judgment_date: judgmentDate,
            cause,
            url: href,
          });
          if (results.length >= ${limit}) break;
        }
        return results;
      })()
    `);

        if (!Array.isArray(data) || data.length === 0) {
            throw new CliError(
                'NO_RESULTS',
                '在 OpenLaw 上未检索到任何结果。',
                '可能原因：(1) 关键字过窄；(2) OpenLaw 站点 DOM 已升级，请通过 issue 反馈以更新适配器。'
            );
        }
        return data;
    },
});
