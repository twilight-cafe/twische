import { describe, test, expect, afterEach } from 'vitest';
import { parseMultiStatus, normalizeHref, DavXmlError } from './xml';

const wrap = (inner: string): string => `<?xml version="1.0" encoding="utf-8"?>${inner}`;

describe('multistatus 解析', () => {
  test('解析 record 列表：href / ETag / 是否为集合', () => {
    const xml = wrap(`
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/dav/twische/records/</D:href>
          <D:propstat>
            <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
        <D:response>
          <D:href>/dav/twische/records/abc.json</D:href>
          <D:propstat>
            <D:prop>
              <D:getetag>"e1"</D:getetag>
              <D:resourcetype/>
              <D:getcontentlength>128</D:getcontentlength>
              <D:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</D:getlastmodified>
              <D:displayname>abc.json</D:displayname>
            </D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
        </D:response>
      </D:multistatus>`);

    const list = parseMultiStatus(xml);
    expect(list).toHaveLength(2);

    expect(list[0].href).toBe('/dav/twische/records/');
    expect(list[0].isCollection).toBe(true);
    expect(list[0].ok).toBe(true);

    expect(list[1].href).toBe('/dav/twische/records/abc.json');
    expect(list[1].etag).toBe('"e1"');
    expect(list[1].isCollection).toBe(false);
    expect(list[1].contentLength).toBe(128);
    expect(list[1].lastModified).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    expect(list[1].displayName).toBe('abc.json');
  });

  test('命名空间前缀大小写与默认命名空间都能解析', () => {
    const lower = wrap(
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/a.json</d:href>' +
        '<d:propstat><d:prop><d:getetag>"x"</d:getetag></d:prop>' +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
    );
    expect(parseMultiStatus(lower)[0].etag).toBe('"x"');

    const def = wrap(
      '<multistatus xmlns="DAV:"><response><href>/b.json</href>' +
        '<propstat><prop><getetag>"y"</getetag></prop>' +
        '<status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
    );
    expect(parseMultiStatus(def)[0].etag).toBe('"y"');
  });

  test('404 的 propstat 记为不存在，且不取它的属性', () => {
    const xml = wrap(`
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/dav/missing.json</D:href>
          <D:propstat>
            <D:prop><D:getetag>"deadbeef"</D:getetag></D:prop>
            <D:status>HTTP/1.1 404 Not Found</D:status>
          </D:propstat>
        </D:response>
      </D:multistatus>`);
    const [res] = parseMultiStatus(xml);
    expect(res.ok).toBe(false);
    expect(res.etag).toBeNull();
    expect(res.isCollection).toBe(false);
    expect(res.propstats[0].status).toBe(404);
  });

  test('同时存在 200 与 404 组时取 200 组', () => {
    const xml = wrap(`
      <D:multistatus xmlns:D="DAV:">
        <D:response>
          <D:href>/dav/a.json</D:href>
          <D:propstat>
            <D:prop><D:getetag>"good"</D:getetag></D:prop>
            <D:status>HTTP/1.1 200 OK</D:status>
          </D:propstat>
          <D:propstat>
            <D:prop><D:displayname/></D:prop>
            <D:status>HTTP/1.1 404 Not Found</D:status>
          </D:propstat>
        </D:response>
      </D:multistatus>`);
    const [res] = parseMultiStatus(xml);
    expect(res.ok).toBe(true);
    expect(res.etag).toBe('"good"');
    expect(res.propstats).toHaveLength(2);
  });

  test('缺失 status 元素按 0 处理，空属性文本归一为 null', () => {
    const xml = wrap(
      '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a.json</D:href>' +
        '<D:propstat><D:prop><D:getetag></D:getetag><D:getcontentlength>abc</D:getcontentlength></D:prop>' +
        '</D:propstat></D:response></D:multistatus>',
    );
    const [res] = parseMultiStatus(xml);
    expect(res.propstats[0].status).toBe(0);
    expect(res.propstats[0].etag).toBeNull();
    expect(res.propstats[0].contentLength).toBeNull();
    expect(res.ok).toBe(false);
  });

  test('状态行里没有三位数字时按 0 处理，而不是 NaN', () => {
    const xml = wrap(
      '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a.json</D:href>' +
        '<D:propstat><D:prop><D:getetag>"z"</D:getetag></D:prop>' +
        '<D:status>OK</D:status></D:propstat></D:response></D:multistatus>',
    );
    const [res] = parseMultiStatus(xml);
    expect(res.propstats[0].status).toBe(0);
    expect(res.ok).toBe(false);
  });

  test('没有 propstat 的 response 不炸', () => {
    const xml = wrap('<D:multistatus xmlns:D="DAV:"><D:response><D:href>/a.json</D:href></D:response></D:multistatus>');
    const [res] = parseMultiStatus(xml);
    expect(res.propstats).toEqual([]);
    expect(res.ok).toBe(false);
  });

  test('缺 href、缺 prop 的残缺 response 也能降级处理', () => {
    const xml = wrap(
      '<D:multistatus xmlns:D="DAV:"><D:response><D:propstat>' +
        '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>',
    );
    const [res] = parseMultiStatus(xml);
    expect(res.href).toBe('');
    expect(res.ok).toBe(true);
    expect(res.etag).toBeNull();
    expect(res.isCollection).toBe(false);
    expect(res.contentLength).toBeNull();
    expect(res.lastModified).toBeNull();
    expect(res.displayName).toBeNull();
  });

  test('ETag 里的引号被实体转义时要还原成原样', () => {
    // 有些服务器会把 ETag 的引号写成 &quot;（XML 规范允许，也常见）。
    // 如果解析后没还原，应用就会拿着 &quot;e1&quot; 去发 If-Match，
    // 结果是每次写入都撞 412，同步彻底卡死。
    const xml = wrap(
      '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/a.json</D:href>' +
        '<D:propstat><D:prop><D:getetag>&quot;e1&quot;</D:getetag></D:prop>' +
        '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>',
    );
    const [res] = parseMultiStatus(xml);
    expect(res.etag).toBe('"e1"');
    expect(res.etag).not.toContain('&quot;');
  });

  test('格式错误的 XML 落到 parsererror 分支', () => {
    expect(() => parseMultiStatus('<D:multistatus xmlns:D="DAV:"><unclosed>')).toThrow(/不是合法 XML/);
  });

  test('只有注释的响应体也算解析失败', () => {
    expect(() => parseMultiStatus('<!-- nothing -->')).toThrow(DavXmlError);
  });

  test('空响应体、非 XML、非 multistatus 根元素都抛 DavXmlError', () => {
    expect(() => parseMultiStatus('   ')).toThrow(DavXmlError);
    expect(() => parseMultiStatus('<html><body>502 Bad Gateway</body></html>')).toThrow(DavXmlError);
    expect(() => parseMultiStatus('<D:foo xmlns:D="DAV:"/>')).toThrow(/期望 multistatus/);
  });

  test('HTML 错误页（真实场景：反向代理）报错而不是当成空目录', () => {
    const html = '<!DOCTYPE html><html><head><title>502</title></head><body>bad gateway</body></html>';
    expect(() => parseMultiStatus(html)).toThrow(DavXmlError);
  });

  test('没有 DOMParser 的环境明确报错', () => {
    const original = globalThis.DOMParser;
    try {
      // @ts-expect-error 故意删掉，模拟非浏览器环境
      delete globalThis.DOMParser;
      expect(() => parseMultiStatus('<D:multistatus xmlns:D="DAV:"/>')).toThrow(/没有 DOMParser/);
    } finally {
      globalThis.DOMParser = original;
    }
  });
});

describe('href 归一化', () => {
  const base = 'https://dav.test/dav/twische/records';

  test('绝对 URL、绝对路径、相对路径都归一成同一路径', () => {
    expect(normalizeHref('https://dav.test/dav/a.json', base)).toBe('/dav/a.json');
    expect(normalizeHref('/dav/a.json', base)).toBe('/dav/a.json');
    expect(normalizeHref('a.json', base)).toBe('/dav/twische/records/a.json');
  });

  test('baseUrl 已带尾斜杠时不再补，相对 href 仍落在同目录', () => {
    expect(normalizeHref('a.json', `${base}/`)).toBe('/dav/twische/records/a.json');
  });

  test('百分号编码与原文归一为同一个键（打卡记录的竖线是重点）', () => {
    expect(normalizeHref('/dav/records/a%7Cb.json', base)).toBe('/dav/records/a|b.json');
    expect(normalizeHref('/dav/records/a|b.json', base)).toBe('/dav/records/a|b.json');
    expect(normalizeHref('/dav/records/%E6%97%A5%E7%A8%8B.json', base)).toBe('/dav/records/日程.json');
  });

  test('非法百分号序列不抛异常', () => {
    expect(normalizeHref('/dav/records/%E0%A4%A.json', base)).toBe('/dav/records/%E0%A4%A.json');
  });

  test('完全无法解析的 href 原样返回', () => {
    expect(normalizeHref('http://[', base)).toBe('http://[');
  });
});
