// 小端 classic TIFF 子集的严格解析：单波段 uint8、tiled、planar=1、未压缩或 Deflate。
// 合同要求：不要求支持其它编码，但不能静默误读——任何缺失或越界都以明确错误终止。

export const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 12: 8 };

// 领取窗口所需的全部标签；缺任何一个都视为元数据不完整。
export const REQUIRED_TAGS = [256, 257, 258, 259, 262, 277, 284, 322, 323, 324, 325, 339, 33550, 33922];

export function parseHeader(bytes) {
  if (bytes.length < 8) throw new Error('影像头不完整');
  const order = bytes.toString('latin1', 0, 2);
  if (order !== 'II') throw new Error('仅支持小端 TIFF，收到其它字节序');
  const magic = bytes.readUInt16LE(2);
  if (magic !== 42) throw new Error(`不支持的 TIFF 版本标记：${magic}`);
  return { ifdOffset: bytes.readUInt32LE(4) };
}

export function parseIfdEntries(bytes, count) {
  if (bytes.length < count * 12 + 4) throw new Error('影像目录不完整');
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    const cursor = index * 12;
    const tag = bytes.readUInt16LE(cursor);
    entries.set(tag, {
      tag,
      type: bytes.readUInt16LE(cursor + 2),
      count: bytes.readUInt32LE(cursor + 4),
      field: bytes.subarray(cursor + 8, cursor + 12)
    });
  }
  return entries;
}

// 标签值内联在 4 字节字段里时返回对应切片，否则返回 null（值在文件其它位置）。
export function inlineValue(entry) {
  const size = TYPE_SIZES[entry.type];
  if (!size) throw new Error(`标签 ${entry.tag} 类型不受支持：${entry.type}`);
  const length = size * entry.count;
  return length <= 4 ? entry.field.subarray(0, length) : null;
}

export function valueLocation(entry) {
  const size = TYPE_SIZES[entry.type];
  if (!size) throw new Error(`标签 ${entry.tag} 类型不受支持：${entry.type}`);
  return { offset: entry.field.readUInt32LE(0), length: size * entry.count };
}

export function decodeValues(entry, bytes) {
  const { type, count } = entry;
  const size = TYPE_SIZES[type];
  if (!size || ![3, 4, 12].includes(type)) throw new Error(`标签 ${entry.tag} 类型不受支持：${type}`);
  if (bytes.length < count * size) throw new Error(`标签 ${entry.tag} 的值不完整`);
  if (type === 3) return Array.from({ length: count }, (_, i) => bytes.readUInt16LE(i * 2));
  if (type === 4) return Array.from({ length: count }, (_, i) => bytes.readUInt32LE(i * 4));
  return Array.from({ length: count }, (_, i) => bytes.readDoubleLE(i * 8));
}

// 把标签值规范化为影像元数据；fileSize 用于核对瓦片范围不越出对象。
export function normalizeMeta(values, fileSize) {
  for (const tag of REQUIRED_TAGS)
    if (!values.has(tag)) throw new Error(`影像元数据不完整：缺少标签 ${tag}`);
  const scalar = tag => {
    const list = values.get(tag);
    if (list.length !== 1) throw new Error(`标签 ${tag} 应为单值，实为 ${list.length} 个`);
    return list[0];
  };
  const width = scalar(256), height = scalar(257);
  const bits = scalar(258);
  if (bits !== 8) throw new Error(`仅支持 8 位采样，收到 ${bits} 位`);
  const compression = scalar(259);
  if (![1, 8].includes(compression)) throw new Error(`不支持的瓦片压缩方式：${compression}`);
  const samples = scalar(277);
  if (samples !== 1) throw new Error(`仅支持单波段影像，收到 ${samples} 波段`);
  const planar = scalar(284);
  if (planar !== 1) throw new Error(`仅支持 planar=1，收到 ${planar}`);
  const sampleFormat = scalar(339);
  if (sampleFormat !== 1) throw new Error(`仅支持无符号整型采样，收到格式 ${sampleFormat}`);
  const tileWidth = scalar(322), tileHeight = scalar(323);
  if (!(width > 0 && height > 0 && tileWidth > 0 && tileHeight > 0)) throw new Error('影像尺寸元数据无效');
  const offsets = values.get(324), counts = values.get(325);
  const tilesAcross = Math.ceil(width / tileWidth);
  const tilesDown = Math.ceil(height / tileHeight);
  const total = tilesAcross * tilesDown;
  if (offsets.length !== total || counts.length !== total)
    throw new Error(`瓦片索引数量与影像尺寸不符：${offsets.length}/${counts.length}，应为 ${total}`);
  offsets.forEach((offset, index) => {
    if (offset + counts[index] > fileSize) throw new Error(`瓦片 ${index} 范围超出对象大小`);
  });
  const scale = values.get(33550);
  if (scale.length !== 3) throw new Error('像素尺度元数据不完整');
  const tiepoint = values.get(33922);
  if (tiepoint.length < 6 || tiepoint.length % 6 !== 0) throw new Error('定位点元数据不完整');
  return {
    width, height, tileWidth, tileHeight, compression,
    photometric: scalar(262),
    offsets, counts, scale, tiepoint, tilesAcross, tilesDown
  };
}
