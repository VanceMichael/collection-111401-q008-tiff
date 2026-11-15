// 窗口与瓦片网格之间的纯函数换算：只算位置，不碰网络。
// 窗口为左上闭、右下开的整数像素范围：[x, x+width) × [y, y+height)。

export function tilesForWindow(window, meta) {
  const x1 = window.x + window.width, y1 = window.y + window.height;
  const col0 = Math.max(0, Math.floor(window.x / meta.tileWidth));
  const row0 = Math.max(0, Math.floor(window.y / meta.tileHeight));
  const col1 = Math.min(meta.tilesAcross - 1, Math.floor((x1 - 1) / meta.tileWidth));
  const row1 = Math.min(meta.tilesDown - 1, Math.floor((y1 - 1) / meta.tileHeight));
  const indices = [];
  for (let row = row0; row <= row1; row++)
    for (let col = col0; col <= col1; col++) indices.push(row * meta.tilesAcross + col);
  return indices;
}

// 把解压后的整瓦片按行列位置拼进窗口缓冲；影像外区域保留无效值填充。
// tileData: Map(瓦片序号 → 长度为 tileWidth*tileHeight 的 Buffer)。
export function stitchWindow(window, meta, tileData, nodata) {
  const pixels = Buffer.alloc(window.width * window.height, nodata & 0xff);
  const ax0 = Math.max(window.x, 0), ay0 = Math.max(window.y, 0);
  const ax1 = Math.min(window.x + window.width, meta.width);
  const ay1 = Math.min(window.y + window.height, meta.height);
  if (ax0 >= ax1 || ay0 >= ay1) throw new Error('请求窗口与影像范围无交集');
  const row0 = Math.floor(ay0 / meta.tileHeight), row1 = Math.floor((ay1 - 1) / meta.tileHeight);
  const col0 = Math.floor(ax0 / meta.tileWidth), col1 = Math.floor((ax1 - 1) / meta.tileWidth);
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const index = row * meta.tilesAcross + col;
      const tile = tileData.get(index);
      if (!tile) throw new Error(`缺少拼接所需瓦片 ${index}`);
      if (tile.length !== meta.tileWidth * meta.tileHeight)
        throw new Error(`瓦片 ${index} 大小不符：${tile.length}`);
      const tx0 = col * meta.tileWidth, ty0 = row * meta.tileHeight;
      const ix0 = Math.max(ax0, tx0), iy0 = Math.max(ay0, ty0);
      const ix1 = Math.min(ax1, tx0 + meta.tileWidth), iy1 = Math.min(ay1, ty0 + meta.tileHeight);
      for (let y = iy0; y < iy1; y++) {
        const source = (y - ty0) * meta.tileWidth + (ix0 - tx0);
        const target = (y - window.y) * window.width + (ix0 - window.x);
        tile.copy(pixels, target, source, source + (ix1 - ix0));
      }
    }
  }
  return { pixels, actualRange: { x: ax0, y: ay0, width: ax1 - ax0, height: ay1 - ay0 } };
}

// 逐行扫描无效值，输出行内游程（x1 为开边界），供质检精确定位无效区域。
export function scanInvalid(pixels, width, height, nodata) {
  const runs = [];
  let count = 0;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      if (pixels[y * width + x] !== nodata) { x++; continue; }
      let x1 = x + 1;
      while (x1 < width && pixels[y * width + x1] === nodata) x1++;
      runs.push({ y, x0: x, x1 });
      count += x1 - x;
      x = x1;
    }
  }
  return { count, runs };
}
