import { cli, Strategy } from '@jackwener/opencli/registry';
import { CliError } from '@jackwener/opencli/errors';
import { requireNonEmptyQuery } from '../_shared/common.js';

/**
 * 中国裁判文书网按文书 ID 调取全文：
 *   opencli wenshu detail "17bc3da215ac4245a70030084e686590"
 *
 * 文书 ID 通常来自 wenshu/search 或 wenshu/case 返回的 url，
 * 形如：
 *   https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=...
 *
 * 输出字段：标题、案号、法院、当事人、裁判日期、案由、裁判结果、正文摘要。
 */
cli({
    site: 'wenshu',
    name: 'detail',
    description: '裁判文书网按 docId 调取裁判文书全文（需先在浏览器中登录）',
    domain: 'wenshu.court.gov.cn',
    strategy: Strategy.COOKIE,
    browser: true,
    args: [
        { name: 'docId', positional: true, required: true, help: '文书 ID（来自 search/case 返回的 url）' },
        { name: 'maxBody', type: 'int', default: 2000, help: '正文摘要的最大字符数（默认 2000）' },
    ],
    columns: ['title', 'case_no', 'court', 'parties', 'judgment_date', 'cause', 'result', 'body'],
    navigateBefore: false,
    func: async (page, kwargs) => {
        const docId = requireNonEmptyQuery(kwargs.docId, 'docId');
        const maxBody = Math.max(200, Math.min(20000, Number(kwargs.maxBody) || 2000));

        const url = `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${encodeURIComponent(docId)}`;
        await page.goto(url);
        await page.wait(6);

        const loggedIn = await page.evaluate(`
      (() => /login|user\\/login/i.test(location.href || '') ? false : true)()
    `);
        if (!loggedIn) {
            throw new CliError(
                'NOT_LOGGED_IN',
                '裁判文书网未登录，无法读取文书详情。',
                '请先在 Chrome 中打开 https://wenshu.court.gov.cn 完成登录后再运行本命令。'
            );
        }

        const data = await page.evaluate(`
      (async () => {
        const normalize = v => (v || '').replace(/\\s+/g, ' ').trim();
        // 等待文书容器出现
        for (let i = 0; i < 60; i++) {
          const ok = document.querySelector('.PDF_pox, .QSWordCom, .Content, .article-content, #_view_1545184311000, .PDF_box');
          const txt = document.body && document.body.innerText || '';
          if (ok || txt.length > 1500) break;
          await new Promise(r => setTimeout(r, 500));
        }
        const root =
          document.querySelector('.PDF_pox') ||
          document.querySelector('.QSWordCom') ||
          document.querySelector('.Content') ||
          document.querySelector('.article-content') ||
          document.querySelector('.PDF_box') ||
          document.body;
        const bodyText = normalize(root && root.innerText || document.body.innerText || '');
        if (!bodyText) return null;

        const pickAfter = (label, cap = 200) => {
          const re = new RegExp(label + '[：:]\\\\s*([^\\\\n。]{1,' + cap + '})');
          const m = bodyText.match(re);
          return m ? normalize(m[1]) : '';
        };

        // 标题：通常是文书第一行最显眼的句子
        let title =
          normalize(document.querySelector('.PDF_title, .QSWB, h1, h2, .title')?.textContent) ||
          (bodyText.split(/[。\\n]/)[0] || '').slice(0, 80);

        // 案号
        const caseNoMatch = bodyText.match(/[（(]\\s*\\d{4}\\s*[）)][^，。\\s]{0,40}号/);
        const caseNo = caseNoMatch ? caseNoMatch[0] : pickAfter('案号', 60);

        // 法院
        const courtMatch = bodyText.match(/[\\u4e00-\\u9fa5]{2,30}人民法院/);
        const court = courtMatch ? courtMatch[0] : '';

        // 裁判日期
        const dateMatch = bodyText.match(/(\\d{4})\\s*[年-]\\s*(\\d{1,2})\\s*[月-]\\s*(\\d{1,2})\\s*日?/);
        const judgmentDate = dateMatch ? \`\${dateMatch[1]}-\${String(dateMatch[2]).padStart(2,'0')}-\${String(dateMatch[3]).padStart(2,'0')}\` : '';

        // 当事人 / 案由 / 结果（基于关键字粗提取）
        const parties = pickAfter('原告|申请人|上诉人', 200);
        const cause = pickAfter('案由|案件类型', 60);
        const result = pickAfter('判决如下|裁定如下|本院认为', 400);

        return {
          title,
          case_no: caseNo,
          court,
          parties,
          judgment_date: judgmentDate,
          cause,
          result,
          body: bodyText.slice(0, ${maxBody}),
        };
      })()
    `);

        if (!data || !data.body) {
            throw new CliError(
                'NOT_FOUND',
                '该 docId 在裁判文书网上未读取到正文。',
                '可能原因：(1) 该文书已下架；(2) docId 格式错误；(3) 当前账户当日查询额度已用尽。'
            );
        }
        return [data];
    },
});
