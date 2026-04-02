import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { detectSite, extractFromDocument, extractFromElement, extractFromRoot, findMediaElements } from '../src/lib/extract';

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

  it('detects newly supported sites', () => {
    expect(detectSite('https://www.xiaohongshu.com/explore/123456')).toBe('xiaohongshu');
    expect(detectSite('https://image.baidu.com/search/index?tn=baiduimage')).toBe('baidu');
    expect(detectSite('https://www.google.com/search?tbm=isch&q=cat')).toBe('google');
    expect(detectSite('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube');
  });

  it('extracts google image originals from imgres links', () => {
    const html = `
      <html>
        <body>
          <a href="https://www.google.com/imgres?imgurl=https%3A%2F%2Fcdn.example.com%2Fcat.jpg&imgrefurl=https%3A%2F%2Fexample.com%2Fpost">
            <img src="https://encrypted-tbn0.gstatic.com/images?q=tbn:abc" />
          </a>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.google.com/search?tbm=isch&q=cat' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toBe('https://cdn.example.com/cat.jpg');
    expect(r.items[0]?.sourcePageUrl).toBe('https://example.com/post');
  });

  it('extracts baidu image originals from result links', () => {
    const html = `
      <html>
        <body>
          <a href="https://image.baidu.com/search/detail?objurl=https%3A%2F%2Fimg.example.com%2Fpic.png&fromurl=https%3A%2F%2Fexample.com%2Fpage">
            <img src="https://img1.baidu.com/it/u=123,456&fm=253&fmt=auto" />
          </a>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://image.baidu.com/search/index?word=cat' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toBe('https://img.example.com/pic.png');
    expect(r.items[0]?.sourcePageUrl).toBe('https://example.com/page');
  });

  it('extracts xiaohongshu media and filters avatar assets', () => {
    const html = `
      <html>
        <head>
          <meta name="keywords" content="travel,landscape,film" />
          <meta name="author" content="Tester" />
        </head>
        <body>
          <img src="https://sns-avatar-qc.xhscdn.com/avatar/abc.jpg" />
          <a href="/explore/66f0cafe000000001203abcd">
            <img src="https://sns-webpic-qc.xhscdn.com/202401010000/abc123.jpg?imageView2/2/w/1080" />
          </a>
        </body>
      </html>
    `;
    const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/explore/66f0cafe000000001203abcd' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.length).toBe(1);
    expect(r.items[0]?.mediaUrl).toContain('sns-webpic-qc.xhscdn.com/202401010000/abc123.jpg');
    expect(r.items[0]?.authorHandle).toBe('Tester');
    expect(r.items[0]?.context?.tags).toEqual(expect.arrayContaining(['travel', 'landscape', 'film']));
  });

  it('extracts xiaohongshu videos from video source tags', () => {
    const html = `
      <html>
        <head>
          <meta name="author" content="VideoMaker" />
        </head>
        <body>
          <div class="note-video">
            <video controls>
              <source src="https://fe-video-qc.xhscdn.com/stream/110/259/01e7f0aabbccddeeff00112233445566.mp4" />
            </video>
          </div>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/explore/66f0cafe000000001203beef' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    expect(r.items.some((item) => item.mediaType === 'video')).toBe(true);
    expect(r.items.find((item) => item.mediaType === 'video')?.mediaUrl).toContain('fe-video-qc.xhscdn.com/stream');
    expect(r.items.find((item) => item.mediaType === 'video')?.authorHandle).toBe('VideoMaker');
  });

  it('extracts xiaohongshu video from og meta even when images already exist', () => {
    const html = `
      <html>
        <head>
          <meta property="og:image" content="https://sns-webpic-qc.xhscdn.com/202401010000/cover.webp" />
          <meta property="og:video" content="https://fe-video-qc.xhscdn.com/stream/110/259/abc987654321/master.m3u8" />
          <meta name="twitter:player:stream" content="https://fe-video-qc.xhscdn.com/stream/110/259/abc987654321/fhd.mp4" />
        </head>
        <body>
          <img src="https://sns-webpic-qc.xhscdn.com/202401010000/cover.webp?imageView2/2/w/1080" />
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/explore/66f0cafe000000001203cafe' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    const videoItems = r.items.filter((item) => item.mediaType === 'video');
    expect(videoItems.length).toBeGreaterThan(0);
    expect(videoItems.some((item) => item.mediaUrl.includes('fe-video-qc.xhscdn.com'))).toBe(true);
  });

  it('extracts xiaohongshu video urls from inline script payloads', () => {
    const html = `
      <html>
        <head>
          <script>
            window.__INITIAL_STATE__ = {
              note: {
                video: {
                  masterUrl: "https:\\/\\/fe-video-qc.xhscdn.com\\/stream\\/110\\/259\\/ff0011223344\\/master.m3u8",
                  originUrl: "https:\\/\\/fe-video-qc.xhscdn.com\\/stream\\/110\\/259\\/ff0011223344\\/fhd.mp4"
                }
              }
            };
          </script>
        </head>
        <body>
          <img src="https://sns-webpic-qc.xhscdn.com/202401010000/poster.webp" />
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/explore/66f0cafe000000001203d00d' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    const videoItems = r.items.filter((item) => item.mediaType === 'video');
    expect(videoItems.length).toBeGreaterThan(0);
    expect(videoItems.some((item) => item.mediaUrl.includes('ff0011223344'))).toBe(true);
  });

  it('ignores xiaohongshu pdf attachments even when they are on a video host', () => {
    const html = `
      <html>
        <head>
          <script>
            window.__INITIAL_STATE__ = {
              note: {
                attachments: {
                  pdfUrl: "https:\\/\\/fe-video-qc.xhscdn.com\\/docs\\/aa11bb22cc33\\/guide.pdf"
                },
                video: {
                  masterUrl: "https:\\/\\/fe-video-qc.xhscdn.com\\/stream\\/110\\/259\\/aa11bb22cc33\\/master.m3u8",
                  originUrl: "https:\\/\\/fe-video-qc.xhscdn.com\\/stream\\/110\\/259\\/aa11bb22cc33\\/fhd.mp4"
                }
              }
            };
          </script>
        </head>
        <body>
          <video>
            <source src="https://fe-video-qc.xhscdn.com/stream/110/259/aa11bb22cc33/fhd.mp4" />
          </video>
        </body>
      </html>
    `;

    const dom = new JSDOM(html, { url: 'https://www.xiaohongshu.com/explore/66f0cafe000000001203face' });
    const r = extractFromDocument(dom.window.document, dom.window.location.href);
    const videoItems = r.items.filter((item) => item.mediaType === 'video');
    expect(videoItems.some((item) => item.mediaUrl.includes('.pdf'))).toBe(false);
    expect(videoItems.some((item) => item.mediaUrl.includes('aa11bb22cc33') && item.mediaUrl.includes('.mp4'))).toBe(true);
  });
});
