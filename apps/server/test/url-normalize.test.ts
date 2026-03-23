import { describe, expect, it } from 'vitest';
import { normalizeMediaUrl } from '../src/url-normalize.js';

describe('normalizeMediaUrl', () => {
  it('strips query on video.twimg.com', () => {
    const out = normalizeMediaUrl('https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/a.mp4?tag=12');
    expect(out).toBe('https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/a.mp4');
  });

  it('stabilizes pbs.twimg.com/media to name=orig', () => {
    const out = normalizeMediaUrl('https://pbs.twimg.com/media/ABCDEF?format=jpg&name=small');
    expect(out).toBe('https://pbs.twimg.com/media/ABCDEF?format=jpg&name=orig');
  });

  it('normalizes pixiv img-master to img-original', () => {
    const out = normalizeMediaUrl(
      'https://i.pximg.net/img-master/img/2024/01/02/00/00/00/12345678_p0_master1200.jpg',
    );
    expect(out).toBe('https://i.pximg.net/img-original/img/2024/01/02/00/00/00/12345678_p0.jpg');
  });

  it('strips query on duitang CDN', () => {
    const out = normalizeMediaUrl('https://c-ssl.duitang.com/uploads/item/202402/12/a.jpeg?x-oss-process=style/s');
    expect(out).toBe('https://c-ssl.duitang.com/uploads/item/202402/12/a.jpeg');
  });
});
