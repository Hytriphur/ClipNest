import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractFromDocument, extractFromElement, extractFromRoot, findMediaElements } from '../src/lib/extract';

describe('extractFromDocument', () => {
  it('extracts tweet media and excludes profile images', () => {
    const html = `
      <html>
        <body>
          <img src="https://pbs.twimg.com/profile_images/aaa/bbb.jpg" />
          <article>
            <a href="/somebody/status/12345">tweet</a>
            <img src="https://pbs.twimg.com/media/ABCDEF?format=jpg&name=small" />
            <video>
              <source src="https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/a.mp4?tag=12" />
            </video>
          </article>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: 'https://x.com/somebody/media' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(2);
    expect(r.items.some((x) => x.mediaUrl.includes('profile_images'))).toBe(false);
    expect(r.items.some((x) => x.mediaType === 'image')).toBe(true);
    expect(r.items.some((x) => x.mediaType === 'video')).toBe(true);
    expect(r.items[0]?.sourcePageUrl).toBe('https://x.com/somebody/media');
  });

  it('extracts from a tweet article root', () => {
    const html = `
      <html>
        <body>
          <article id="tweet">
            <a href="/someone/status/999">tweet</a>
            <img src="https://pbs.twimg.com/media/AAA?format=jpg&name=small" />
          </article>
          <article id="other">
            <img src="https://pbs.twimg.com/media/BBB?format=jpg&name=small" />
          </article>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://x.com/someone/media' });
    const root = dom.window.document.getElementById('tweet')!;
    const r = extractFromRoot(root, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.tweetUrl).toContain('/status/999');
  });

  it('extracts a single media item from an element', () => {
    const html = `
      <html>
        <body>
          <article id="tweet">
            <a href="/someone/status/42">tweet</a>
            <img id="a" src="https://pbs.twimg.com/media/AAA?format=jpg&name=small" />
            <img id="b" src="https://pbs.twimg.com/media/BBB?format=jpg&name=small" />
          </article>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://x.com/someone/media' });
    const target = dom.window.document.getElementById('b')!;
    const r = extractFromElement(target, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toContain('BBB');
    expect(r.items[0]?.tweetUrl).toContain('/status/42');
  });

  it('finds only tweet media elements', () => {
    const html = `
      <html>
        <body>
          <img src="https://pbs.twimg.com/profile_images/aaa/bbb.jpg" />
          <article>
            <img src="https://pbs.twimg.com/media/ABC?format=jpg&name=small" />
            <video>
              <source src="https://video.twimg.com/ext_tw_video/1/pu/vid/720x720/a.mp4?tag=12" />
            </video>
          </article>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://x.com/somebody/media' });
    const elements = findMediaElements(dom.window.document, dom.window.location.href);
    expect(elements.length).toBe(2);
    expect(elements.some((el) => el.tagName === 'IMG')).toBe(true);
    expect(elements.some((el) => el.tagName === 'VIDEO')).toBe(true);
  });

  it('extracts pixiv images and normalizes to original', () => {
    const html = `
      <html>
        <head>
          <meta id="meta-preload-data" content='{"illust":{"12345678":{"userId":"99","tags":{"tags":[{"tag":"tagA"},{"tag":"tagB"}]}}},"user":{"99":{"name":"PixivUser"}}}' />
        </head>
        <body>
          <img src="https://i.pximg.net/img-master/img/2024/01/02/00/00/00/12345678_p0_master1200.jpg" />
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.pixiv.net/artworks/12345678' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toContain('/img-original/');
    expect(r.items[0]?.mediaUrl).toContain('_p0.jpg');
    expect(r.items[0]?.authorHandle).toBe('PixivUser');
    expect(r.items[0]?.context?.tags?.includes('tagA')).toBe(true);
  });

  it('ignores pixiv avatars and common assets', () => {
    const html = `
      <html>
        <body>
          <img src="https://s.pximg.net/common/images/logo.png" />
          <img src="https://i.pximg.net/user-profile/img/2024/01/01/00/00/00/abc123_1700000000_1700000000.png" />
          <img src="https://i.pximg.net/img-master/img/2024/01/02/00/00/00/12345678_p1_master1200.jpg" />
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.pixiv.net/artworks/12345678' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toContain('img-original');
    expect(r.items[0]?.mediaUrl).toContain('_p1');
  });

  it('extracts pixiv data-src blocks', () => {
    const html = `
      <html>
        <body>
          <div data-src="https://i.pximg.net/img-master/img/2024/01/02/00/00/00/12345678_p2_master1200.jpg"></div>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.pixiv.net/artworks/12345678' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toContain('/img-original/');
    expect(r.items[0]?.mediaUrl).toContain('_p2');
  });

  it('extracts pixiv urls from picture source srcset', () => {
    const html = `
      <html>
        <body>
          <picture>
            <source srcset="https://i.pximg.net/img-master/img/2024/02/02/00/00/00/99999999_p0_master1200.jpg 1x" />
            <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" />
          </picture>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.pixiv.net/artworks/99999999' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toContain('/img-original/');
    expect(r.items[0]?.mediaUrl).toContain('_p0');
  });

  it('extracts pixiv preview and attaches artwork url', () => {
    const html = `
      <html>
        <body>
          <a href="/artworks/55555555">
            <img src="https://i.pximg.net/c/250x250_80_a2/custom-thumb/img/2024/01/02/00/00/00/55555555_p0_custom1200.jpg" />
          </a>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.pixiv.net/tags/cats' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.sourcePageUrl).toBe('https://www.pixiv.net/artworks/55555555');
    expect(r.items[0]?.context?.artworkUrl).toBe('https://www.pixiv.net/artworks/55555555');
    expect(r.items[0]?.mediaUrl).toContain('/img-master/');
  });

  it('skips pixiv novel covers', () => {
    const html = `
      <html>
        <body>
          <a href="/novel/show.php?id=777">
            <img src="https://i.pximg.net/img-master/img/2024/01/02/00/00/00/77777777_p0_master1200.jpg" />
          </a>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.pixiv.net' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(0);
  });

  it('extracts duitang images', () => {
    const html = `
      <html>
        <body>
          <img src="https://c-ssl.duitang.com/uploads/item/202402/12/20240212000000_xxx.jpeg?x-oss-process=style/s" />
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.duitang.com/blog/?id=123' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toContain('duitang.com/uploads/item/202402/12/20240212000000_xxx.jpeg');
  });
});
