import { inflateSync } from 'node:zlib';
import { sha256 } from './archive.mjs';
import { parseHeader, parseIfdEntries, inlineValue, valueLocation, decodeValues, normalizeMeta, REQUIRED_TAGS } from './tiff.mjs';
import { tilesForWindow, stitchWindow } from './raster.mjs';

// 来源在领取过程中换版：调用方应整体重来，而不是混用两个版本的字节。
export class VersionChanged extends Error {
  constructor(message) {
    super(message);
    this.name = 'VersionChanged';
  }
}

// 按窗口领取一个影像层：只取影像头、目录、所需标签值和相交瓦片的字节。
// 全程用首个响应的 ETag 做 If-Match 条件，任何 412、ETag 漂移或长度变化都使本次尝试失败，
// 保证交付的字节来自同一个版本。options.onRange 是可选的逐段观测钩子。
export async function acquireWindow(base, resource, window, options = {}) {
  const url = base + resource.href;
  let etag = null;
  let total = null;
  let transferred = 0;

  const get = async (start, end) => {
    const headers = { range: `bytes=${start}-${end}` };
    if (etag) headers['if-match'] = etag;
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (response.status === 412) throw new VersionChanged(`来源在领取中换版：${resource.href}`);
    if (response.status !== 206) throw new Error(`来源未按范围响应（${response.status}）：${resource.href}`);
    const boundary = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (!boundary) throw new Error('范围响应缺少内容边界');
    if (Number(boundary[1]) !== start || Number(boundary[2]) !== end) throw new Error('范围响应边界与请求不符');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== end - start + 1) throw new Error('范围响应长度与请求不符');
    const current = response.headers.get('etag');
    if (!current) throw new Error('来源未提供版本标识，无法形成可信完成边界');
    if (etag && current !== etag) throw new VersionChanged(`来源在领取中换版：${resource.href}`);
    if (total !== null && Number(boundary[3]) !== total) throw new Error('来源长度在领取中变化');
    etag ??= current;
    total ??= Number(boundary[3]);
    transferred += bytes.length;
    await options.onRange?.({ href: resource.href, start, end, etag: current });
    return bytes;
  };

  const header = parseHeader(await get(0, 7));
  if (header.ifdOffset + 2 > total) throw new Error('影像目录位置超出对象');
  const countBytes = await get(header.ifdOffset, header.ifdOffset + 1);
  const count = countBytes.readUInt16LE(0);
  if (count === 0 || count > 256) throw new Error(`影像目录项数量异常：${count}`);
  const entriesEnd = header.ifdOffset + 2 + count * 12 + 4;
  if (entriesEnd > total) throw new Error('影像目录不完整');
  const entries = parseIfdEntries(await get(header.ifdOffset + 2, entriesEnd - 1), count);

  const values = new Map();
  for (const tag of REQUIRED_TAGS) {
    const entry = entries.get(tag);
    if (!entry) continue; // 缺失交给 normalizeMeta 统一报告
    const inline = inlineValue(entry);
    const raw = inline ?? await get(...spanOf(valueLocation(entry), total, tag));
    values.set(tag, decodeValues(entry, raw));
  }
  const meta = normalizeMeta(values, total);

  const tiles = new Map();
  const fetched = [];
  for (const index of tilesForWindow(window, meta)) {
    const offset = meta.offsets[index], count = meta.counts[index];
    const packed = await get(offset, offset + count - 1);
    let tile = packed;
    if (meta.compression === 8) {
      try { tile = inflateSync(packed); }
      catch { throw new Error(`瓦片 ${index} 解压失败`); }
    }
    if (tile.length !== meta.tileWidth * meta.tileHeight)
      throw new Error(`瓦片 ${index} 解压后大小不符：${tile.length}`);
    tiles.set(index, tile);
    fetched.push({ index, offset, count, sha256: sha256(packed) });
  }

  const { pixels, actualRange } = stitchWindow(window, meta, tiles, options.nodata ?? 0);
  return { pixels, actualRange, meta, etag, total, transferred, tiles: fetched };
}

function spanOf(location, total, tag) {
  if (location.offset + location.length > total) throw new Error(`标签 ${tag} 的值超出对象大小`);
  return [location.offset, location.offset + location.length - 1];
}
