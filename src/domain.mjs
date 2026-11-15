import { capture } from './client.mjs';
import { Archive } from './archive.mjs';
import { acquireWindow, VersionChanged } from './window.mjs';
import { scanInvalid } from './raster.mjs';

export async function receiveCurrent(base, directory) {
 const { bytes, receipt } = await capture(base + '/survey', directory);
 const data = JSON.parse(bytes);
 return { receipt: receipt.id, plot: data.id, window: data.requestedWindow, resources: data.resources };
}

// 按目录约束选择影像层：只接受像素尺度不超过 maxPixelSize 的层，取其中最细的；
// 一个都不满足时明确失败，绝不为节省流量悄悄换用不满足需求的层。
export function selectResource(catalog) {
  const fitting = catalog.resources.filter(resource => resource.pixelSize <= catalog.maxPixelSize);
  if (!fitting.length)
    throw new Error(`没有满足像素尺度上限 ${catalog.maxPixelSize} 的影像层`);
  fitting.sort((left, right) => left.pixelSize - right.pixelSize);
  const selected = fitting[0];
  const rejected = catalog.resources.filter(resource => resource !== selected).map(resource => ({
    href: resource.href,
    pixelSize: resource.pixelSize,
    reason: resource.pixelSize > catalog.maxPixelSize
      ? `像素尺度 ${resource.pixelSize} 超过上限 ${catalog.maxPixelSize}`
      : `像素尺度 ${resource.pixelSize} 粗于所选层`
  }));
  return { selected, rejected };
}

// 按窗口领取地块影像并把质检交接写入收件库。
// 完成边界：每次尝试内所有字节绑定同一 ETag，且目录在尝试前后一致；
// 交接清单最后落库——没有清单即没有完成，绝不交付混版或来源不明的像素。
export async function receivePlotWindow(base, directory, options = {}) {
  const archive = new Archive(directory);
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const catalogCapture = await capture(base + '/survey', directory);
    const catalog = parseCatalog(catalogCapture.bytes);
    const window = options.window ?? catalog.requestedWindow;
    validateWindow(window);
    const selection = selectResource(catalog);
    try {
      const acquired = await acquireWindow(base, selection.selected, window, {
        nodata: catalog.nodata, onRange: options.onRange
      });
      const current = parseCatalog(await fetchCatalog(base));
      if (stable(current) !== stable(catalog)) throw new VersionChanged('目录在领取中变化');
      const invalid = scanInvalid(acquired.pixels, window.width, window.height, catalog.nodata);
      const pixelReceipt = await archive.save(acquired.pixels, {
        url: base + selection.selected.href, etag: acquired.etag, window
      });
      const { meta } = acquired;
      const manifest = {
        kind: 'plot-window-acquisition',
        status: 'complete',
        plot: catalog.id,
        attempts: attempt,
        catalog: { digest: catalogCapture.receipt.digest, receipt: catalogCapture.receipt.id, edition: catalog.edition },
        requestedWindow: window,
        maxPixelSize: catalog.maxPixelSize,
        selected: selection.selected,
        rejected: selection.rejected,
        version: { etag: acquired.etag, edition: catalog.edition },
        image: {
          width: meta.width, height: meta.height,
          tileWidth: meta.tileWidth, tileHeight: meta.tileHeight,
          compression: meta.compression, size: acquired.total
        },
        tiles: acquired.tiles,
        actualRange: acquired.actualRange,
        pixels: {
          digest: pixelReceipt.digest, receipt: pixelReceipt.id,
          width: window.width, height: window.height, nodata: catalog.nodata
        },
        invalid: { nodata: catalog.nodata, pixels: invalid.count, runs: invalid.runs },
        position: {
          scale: meta.scale,
          tiepoint: meta.tiepoint,
          windowOrigin: windowOrigin(window, meta)
        },
        transferred: acquired.transferred
      };
      const manifestReceipt = await archive.save(Buffer.from(JSON.stringify(manifest, null, 2)), {
        type: 'window-qc-handoff', plot: catalog.id, etag: acquired.etag
      });
      return {
        manifest,
        pixels: acquired.pixels,
        receipts: { catalog: catalogCapture.receipt, pixels: pixelReceipt, manifest: manifestReceipt }
      };
    } catch (error) {
      if (!(error instanceof VersionChanged)) throw error;
      if (attempt === attempts)
        throw new Error(`来源在领取中持续换版，${attempts} 次尝试后仍无法形成可信完成边界`, { cause: error });
    }
  }
}

function windowOrigin(window, meta) {
  const [i, j, , x, y] = meta.tiepoint;
  return [x + (window.x - i) * meta.scale[0], y - (window.y - j) * meta.scale[1]];
}

async function fetchCatalog(base) {
  const response = await fetch(base + '/survey', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`目录复核失败：${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function parseCatalog(bytes) {
  let catalog;
  try { catalog = JSON.parse(bytes); }
  catch { throw new Error('目录不是有效 JSON'); }
  if (!catalog || typeof catalog !== 'object') throw new Error('目录资料不完整');
  if (typeof catalog.id !== 'string' || !catalog.id) throw new Error('目录资料不完整：缺少地块标识');
  if (!Number.isInteger(catalog.edition)) throw new Error('目录资料不完整：缺少版本');
  if (!Array.isArray(catalog.resources) || !catalog.resources.length) throw new Error('目录资料不完整：缺少影像层');
  for (const resource of catalog.resources) {
    if (typeof resource.href !== 'string' || !resource.href.startsWith('/'))
      throw new Error('目录资料不完整：影像层地址无效');
    if (!(resource.pixelSize > 0)) throw new Error('目录资料不完整：影像层像素尺度无效');
  }
  if (!(catalog.maxPixelSize > 0)) throw new Error('目录资料不完整：缺少像素尺度上限');
  if (!Number.isInteger(catalog.nodata) || catalog.nodata < 0 || catalog.nodata > 255)
    throw new Error('目录资料不完整：无效值定义缺失');
  validateWindow(catalog.requestedWindow, '目录默认窗口无效');
  return catalog;
}

function validateWindow(window, message = '领取窗口无效') {
  if (!window || !Number.isInteger(window.x) || !Number.isInteger(window.y) ||
      !Number.isInteger(window.width) || !Number.isInteger(window.height) ||
      window.x < 0 || window.y < 0 || window.width < 1 || window.height < 1)
    throw new Error(message);
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
