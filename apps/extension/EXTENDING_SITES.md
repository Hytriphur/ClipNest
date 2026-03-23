# Extending Sites

This file explains how to add support for a new site. The main goal is to extract real media URLs from the DOM while filtering avatars, ads, and decorative assets.

## 1. Add a site id
Edit `apps/extension/src/lib/types.ts` and add a new value to `SiteId`.

Edit `apps/extension/src/lib/extract.ts` and update `detectSite` to map the hostname to your new site id.

## 2. Media URL rules
Edit `apps/extension/src/lib/extract.ts`
- Add media URL rules in `isLikelyMediaUrl`
- Filter noise in `isNoiseAsset`

If the site needs URL cleanup or original-size normalization, update `apps/extension/src/lib/url-normalize.ts` in `normalizeMediaUrl`.

## 3. Metadata and tags
If the site exposes author or tag data, follow the pattern in `parsePixivMeta`:
- Parse from meta tags or embedded JSON
- Pass `extra` data into `extractFromRoot` or `extractFromElement`
- Tags are sent via `context.tags` and written to the database

## 4. UI injection and multi-image posts
Every site differs, so you may need adjustments in `apps/extension/src/content.ts`:
- `findAnchorForMedia` controls where buttons are attached
- `findGroupRoot` detects multi-image containers
- `scanAndInject` can enforce stricter filters

## 5. Optional server origin update
If you want the server to mark the origin, update `detectOrigin` in `apps/server/src/ingest.ts` and write the new site id into `media.origin`.

## 6. Testing
Manual check
1. `npm run build -w apps/extension`
2. Reload the extension
3. Open the target site and confirm Save buttons and results

Unit test
1. Add or update `apps/extension/test/extract.test.ts`
2. Run `npm run test -w apps/extension`
