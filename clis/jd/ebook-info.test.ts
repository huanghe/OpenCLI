import { describe, expect, it } from 'vitest';
import { __test__ } from './ebook-info.js';

describe('jd ebook-info helpers', () => {
  describe('normalizeJdEbookId', () => {
    it('passes through bare numeric IDs', () => {
      expect(__test__.normalizeJdEbookId('30906459')).toBe('30906459');
    });

    it('extracts ebookId from a reader URL with return_url', () => {
      expect(
        __test__.normalizeJdEbookId('https://ebooks.jd.com/reader/?ebookId=30906459&return_url=%2Flogin'),
      ).toBe('30906459');
    });

    it('extracts ebookId from an e.jd.com consumer URL', () => {
      expect(__test__.normalizeJdEbookId('https://e.jd.com/30906459.html')).toBe('30906459');
    });

    it('extracts skuId from an item.jd.com URL (ebooks share the JD sku id)', () => {
      expect(__test__.normalizeJdEbookId('https://item.jd.com/30906459.html?from=share')).toBe('30906459');
      expect(__test__.normalizeJdEbookId('https://item.m.jd.com/product/30906459.html')).toBe('30906459');
    });

    it('extracts ebookId from query string in any position', () => {
      expect(__test__.normalizeJdEbookId('?foo=bar&ebookId=12345&baz=qux')).toBe('12345');
    });

    it('returns the raw input when no ID can be extracted', () => {
      expect(__test__.normalizeJdEbookId('not-a-url')).toBe('not-a-url');
      expect(__test__.normalizeJdEbookId('')).toBe('');
    });
  });

  describe('decodeJdHtmlEntities', () => {
    it('decodes numeric and named HTML entities', () => {
      expect(__test__.decodeJdHtmlEntities('&amp; &lt; &gt; &quot; &nbsp;')).toBe('& < > "  ');
      expect(__test__.decodeJdHtmlEntities('&#x4e2d;&#x6587;')).toBe('中文');
      expect(__test__.decodeJdHtmlEntities('&#20013;&#25991;')).toBe('中文');
    });
  });

  describe('parseEJdHtml', () => {
    const fixture = `<!DOCTYPE html><html><head>
<title>《图解大模型：生成式AI原理与实战》(（沙特）杰伊·阿拉马尔，（荷）马尔滕·格鲁滕多斯特)电子书下载、在线阅读、内容简介、评论 – 京东电子书频道</title>
<meta name="description" content="《图解大模型：生成式AI原理与实战》(（沙特）杰伊·阿拉马尔，（荷）马尔滕·格鲁滕多斯特)内容简介：&#x3000;&#x3000;本书全程图解式讲解，通过大量全彩插图拆解概念。" />
</head><body>
<div class="crumb-wrap" id="crumb-wrap">
    <div class="w">
        <div class="crumb fl clearfix">
            <div class="item first"><a href="">数字内容</a></div>
            <div class="item sep">&gt;</div>
            <div class="item"><a href="//list.jd.com/list.html?cat=5272,5307">计算机</a></div>
            <div class="item sep">&gt;</div>
            <div class="item"><a href="//list.jd.com/list.html?cat=5272,5307,10845">算法</a></div>
            <div class="item sep">&gt;</div>
            <div class="item ellipsis" title="图解大模型：生成式AI原理与实战">图解大模型：生成式AI原理与实战</div>
        </div><!-- .crumb -->
    </div>
</div>
<img id="spec-img" data-origin="//img14.360buyimg.com/n1/s720x720_jfs/t1/293535/10/2733/63153/68383781F7f2b327f/a09d085f9cb03ce6.jpg" />
<div class="sku-name">图解大模型：生成式AI原理与实战</div>
</body></html>`;

    it('extracts title, author, intro, category, cover from a real-shape e.jd.com page', () => {
      const r = __test__.parseEJdHtml(fixture, '30906459');
      expect(r.ebookId).toBe('30906459');
      expect(r.title).toBe('图解大模型：生成式AI原理与实战');
      expect(r.author).toBe('（沙特）杰伊·阿拉马尔，（荷）马尔滕·格鲁滕多斯特');
      expect(r.intro).toMatch(/本书全程图解式讲解/);
      expect(r.intro.startsWith('内容简介')).toBe(false);
      expect(r.category).toBe('数字内容 > 计算机 > 算法');
      expect(r.cover).toBe('https://img14.360buyimg.com/n1/jfs/t1/293535/10/2733/63153/68383781F7f2b327f/a09d085f9cb03ce6.jpg');
      expect(r.url).toBe('https://e.jd.com/30906459.html');
    });

    it('throws NOT_FOUND when the page has no title or sku-name (404 / wrong id)', () => {
      const empty = '<!DOCTYPE html><html><head></head><body></body></html>';
      expect(() => __test__.parseEJdHtml(empty, '999999999')).toThrow(/No JD ebook found/);
    });

    it('falls back to .sku-name when <title> is missing', () => {
      const fallback = `<!DOCTYPE html><html><body><div class="sku-name"> 仅 sku-name 的书 </div></body></html>`;
      const r = __test__.parseEJdHtml(fallback, '12345');
      expect(r.title).toBe('仅 sku-name 的书');
      expect(r.author).toBe('');
    });
  });
});
