import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createProvider, json, binary } from '../provider/server.mjs';
import { serveRange } from '../provider/range.mjs';
import { makeTiff } from '../provider/tiff.mjs';
import { receivePlotWindow, selectResource } from '../src/domain.mjs';
import { acquireWindow } from '../src/window.mjs';
import { parseHeader, parseIfdEntries, normalizeMeta } from '../src/tiff.mjs';
import { stitchWindow, scanInvalid } from '../src/raster.mjs';
import { Archive } from '../src/archive.mjs';

// 目录默认窗口 (14,14,5,5) 在 32x32、16x16 瓦片网格上横跨全部四块瓦片；
// 第 generation 版第 i 块瓦片填充值为 generation*10+i。
function expectedWindow(generation) {
  const value = index => generation * 10 + index;
  return [
    [value(0), value(0), value(1), value(1), value(1)],
    [value(0), value(0), value(1), value(1), value(1)],
    [value(2), value(2), value(3), value(3), value(3)],
    [value(2), value(2), value(3), value(3), value(3)],
    [value(2), value(2), value(3), value(3), value(3)]
  ].flat();
}

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change)
  });
  assert.equal(response.status, 200);
}

function withFixture(run) {
  return async () => {
    const provider = await createProvider();
    const directory = await mkdtemp(join(tmpdir(), 'window-'));
    try { await run(provider, directory); }
    finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
  };
}

test('窗口领取跨瓦片拼接正确，实际范围、版本与无效区域一并交接', withFixture(async (provider, directory) => {
  const result = await receivePlotWindow(provider.base, directory);
  assert.deepEqual([...result.pixels], expectedWindow(1));
  assert.deepEqual(result.manifest.actualRange, { x: 14, y: 14, width: 5, height: 5 });
  assert.equal(result.manifest.version.etag, '"survey-1"');
  assert.equal(result.manifest.version.edition, 1);
  assert.equal(result.manifest.attempts, 1);
  assert.deepEqual(result.manifest.position.windowOrigin, [114, 186]);
  assert.deepEqual(result.manifest.invalid, { nodata: 0, pixels: 0, runs: [] });
  assert.equal(result.manifest.tiles.length, 4);
  assert.equal(result.manifest.transferred, provider.state.transferred, '领取字节数应与来源核对一致');
  assert.ok(provider.audit.every(entry => entry.path !== '/overview.tif'), '不得请求不满足分辨率的层');
  assert.equal(result.manifest.selected.href, '/image.tif');
  assert.deepEqual(result.manifest.rejected.map(entry => entry.href), ['/overview.tif']);
  assert.match(result.manifest.rejected[0].reason, /超过上限/);
  const archive = new Archive(directory);
  assert.deepEqual(await archive.read(result.receipts.pixels), result.pixels);
  assert.deepEqual(JSON.parse(await archive.read(result.receipts.manifest)), result.manifest);
  assert.equal(result.manifest.catalog.digest, result.receipts.catalog.digest);
}));

test('窗口只覆盖单块瓦片时只取该瓦片的字节', withFixture(async (provider, directory) => {
  const result = await receivePlotWindow(provider.base, directory, { window: { x: 0, y: 0, width: 5, height: 5 } });
  assert.deepEqual([...result.pixels], Array(25).fill(10));
  assert.deepEqual(result.manifest.tiles.map(tile => tile.index), [0]);
  assert.ok(result.manifest.transferred < result.manifest.image.size, '应明显少于整幅影像');
  assert.equal(result.manifest.transferred, provider.state.transferred);
}));

test('压缩瓦片领取结果与未压缩一致且流量更小', withFixture(async (provider, directory) => {
  const plain = await receivePlotWindow(provider.base, directory);
  await controlled(provider, { mode: 'deflate' });
  const packed = await receivePlotWindow(provider.base, directory);
  assert.deepEqual([...packed.pixels], expectedWindow(1));
  assert.deepEqual([...packed.pixels], [...plain.pixels]);
  assert.equal(packed.manifest.image.compression, 8);
  assert.ok(packed.manifest.transferred < plain.manifest.transferred, '压缩后领取字节应更少');
  assert.equal(plain.manifest.transferred + packed.manifest.transferred, provider.state.transferred);
}));

test('领取中换版后整体重来，交付单一新版本', withFixture(async (provider, directory) => {
  let bumped = false;
  const onRange = async () => {
    if (bumped) return;
    bumped = true;
    await controlled(provider, { generation: 2 });
  };
  const result = await receivePlotWindow(provider.base, directory, { onRange });
  assert.equal(result.manifest.attempts, 2);
  assert.equal(result.manifest.version.etag, '"survey-2"');
  assert.equal(result.manifest.catalog.edition, 2);
  assert.deepEqual([...result.pixels], expectedWindow(2));
  assert.ok(result.manifest.transferred <= provider.state.transferred);
}));

test('换版且重试耗尽时明确失败，不留下完成的交接清单', withFixture(async (provider, directory) => {
  let bumped = false;
  const onRange = async () => {
    if (bumped) return;
    bumped = true;
    await controlled(provider, { generation: 2 });
  };
  await assert.rejects(
    receivePlotWindow(provider.base, directory, { attempts: 1, onRange }),
    /持续换版.*可信完成边界/
  );
  const receipts = await new Archive(directory).list();
  assert.ok(receipts.every(receipt => receipt.source?.type !== 'window-qc-handoff'), '失败的领取不得产生质检交接');
}));

test('没有满足像素尺度上限的层时明确拒绝', () => {
  assert.throws(
    () => selectResource({ maxPixelSize: 1, resources: [{ href: '/overview.tif', pixelSize: 2 }] }),
    /没有满足像素尺度上限 1/
  );
  const { selected, rejected } = selectResource({
    maxPixelSize: 1,
    resources: [{ href: '/coarse.tif', pixelSize: 1 }, { href: '/fine.tif', pixelSize: 0.5 }]
  });
  assert.equal(selected.href, '/fine.tif');
  assert.deepEqual(rejected.map(entry => entry.href), ['/coarse.tif']);
  assert.match(rejected[0].reason, /粗于所选层/);
});

test('窗口越出影像时按实际取得范围交付并标出无效区域', withFixture(async (provider, directory) => {
  const result = await receivePlotWindow(provider.base, directory, { window: { x: 30, y: 30, width: 5, height: 5 } });
  assert.deepEqual(result.manifest.actualRange, { x: 30, y: 30, width: 2, height: 2 });
  assert.deepEqual(result.manifest.tiles.map(tile => tile.index), [3]);
  assert.deepEqual([...result.pixels], [
    13, 13, 0, 0, 0,
    13, 13, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0
  ]);
  assert.equal(result.manifest.invalid.pixels, 21);
  assert.deepEqual(result.manifest.invalid.runs, [
    { y: 0, x0: 2, x1: 5 }, { y: 1, x0: 2, x1: 5 },
    { y: 2, x0: 0, x1: 5 }, { y: 3, x0: 0, x1: 5 }, { y: 4, x0: 0, x1: 5 }
  ]);
  assert.deepEqual(result.manifest.position.windowOrigin, [130, 170]);
}));

test('拼接按行列位置组装，不错位', () => {
  const meta = { width: 4, height: 4, tileWidth: 2, tileHeight: 2, tilesAcross: 2, tilesDown: 2 };
  const tiles = new Map([[0, Buffer.from([1, 2, 3, 4])], [1, Buffer.from([5, 6, 7, 8])],
    [2, Buffer.from([9, 10, 11, 12])], [3, Buffer.from([13, 14, 15, 16])]]);
  const { pixels, actualRange } = stitchWindow({ x: 1, y: 1, width: 2, height: 2 }, meta, tiles, 0);
  assert.deepEqual([...pixels], [4, 7, 10, 13]);
  assert.deepEqual(actualRange, { x: 1, y: 1, width: 2, height: 2 });
  assert.throws(() => stitchWindow({ x: 9, y: 9, width: 2, height: 2 }, meta, tiles, 0), /无交集/);
});

test('无效值扫描给出行内游程', () => {
  const { count, runs } = scanInvalid(Buffer.from([0, 1, 1, 0, 0, 2]), 3, 2, 0);
  assert.equal(count, 3);
  assert.deepEqual(runs, [{ y: 0, x0: 0, x1: 1 }, { y: 1, x0: 0, x1: 2 }]);
});

function validValues() {
  return new Map([[256, [32]], [257, [32]], [258, [8]], [259, [1]], [262, [1]], [277, [1]], [284, [1]],
    [322, [16]], [323, [16]], [324, [286, 542, 798, 1054]], [325, [256, 256, 256, 256]], [339, [1]],
    [33550, [1, 1, 0]], [33922, [0, 0, 0, 100, 200, 0]]]);
}

test('元数据不完整或编码不受支持时明确报错，不静默误读', () => {
  assert.throws(() => parseHeader(Buffer.from('MM\x00*\x00\x00\x00\x08')), /小端/);
  assert.throws(() => parseHeader(Buffer.from('II\x2b\x00\x08\x00\x00\x00')), /版本标记/);
  assert.throws(() => parseIfdEntries(Buffer.alloc(10), 1), /目录不完整/);
  const missing = validValues();
  missing.delete(33922);
  assert.throws(() => normalizeMeta(missing, 1310), /缺少标签 33922/);
  const compressed = validValues();
  compressed.set(259, [5]);
  assert.throws(() => normalizeMeta(compressed, 1310), /压缩方式/);
  const stripped = validValues();
  stripped.set(324, [286, 542]);
  stripped.set(325, [256, 256]);
  assert.throws(() => normalizeMeta(stripped, 1310), /瓦片索引数量/);
  const overflowing = validValues();
  overflowing.set(324, [286, 542, 798, 2000]);
  assert.throws(() => normalizeMeta(overflowing, 1310), /超出对象大小/);
  assert.deepEqual(normalizeMeta(validValues(), 1310).tilesAcross, 2);
});

async function stubSource(bytes) {
  const state = {};
  const server = createServer((request, response) => {
    const result = serveRange({ request, state, json, binary }, bytes, 'image/tiff', '"stub-1"');
    response.writeHead(result.status ?? 200, result.headers);
    response.end(result.body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}

test('来源对象被截断或定位元数据缺失时领取明确失败', async () => {
  const truncated = await stubSource(makeTiff(1).subarray(0, 800));
  try {
    await assert.rejects(
      acquireWindow(truncated.base, { href: '/image.tif' }, { x: 0, y: 0, width: 5, height: 5 }, { nodata: 0 }),
      /超出对象大小/
    );
  } finally { await truncated.close(); }
  const corrupted = Buffer.from(makeTiff(1));
  corrupted.fill(0, 10 + 13 * 12, 10 + 14 * 12); // 抹掉最后一个目录项（定位点标签）
  const broken = await stubSource(corrupted);
  try {
    await assert.rejects(
      acquireWindow(broken.base, { href: '/image.tif' }, { x: 0, y: 0, width: 5, height: 5 }, { nodata: 0 }),
      /缺少标签 33922/
    );
  } finally { await broken.close(); }
});
