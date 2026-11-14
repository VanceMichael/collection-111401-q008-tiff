import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvider } from '../provider/server.mjs';
import { receiveCurrent } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';

async function controlled(provider, change) {
  const response = await fetch(provider.base + '/_control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(change) });
  assert.equal(response.status, 200);
}

test('现有业务入口真实收存来源资料并可重新打开', async () => {
  const provider = await createProvider();
  const directory = await mkdtemp(join(tmpdir(), 'business-'));
  try {
    const result = await receiveCurrent(provider.base, directory);
    assert.ok(result);
    const archive = new Archive(directory);
    const receipts = await archive.list();
    assert.ok(receipts.length > 0);
    for (const receipt of receipts) assert.ok((await archive.read(receipt)).length > 0);
    assert.ok(provider.audit.some(request => !request.path.startsWith('/_')));
  } finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
});

test('影像头是有效小端 TIFF 且支持范围读取', async () => {
 const provider = await createProvider();
 try {
const response=await fetch(provider.base+'/image.tif',{headers:{range:'bytes=0-7'}});assert.equal(response.status,206);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.toString('ascii',0,2),'II');assert.equal(bytes.readUInt16LE(2),42);
 } finally { await provider.close(); }
});

test('范围读取绑定影像版', async () => {
 const provider = await createProvider();
 try {
await controlled(provider,{generation:2});assert.equal((await fetch(provider.base+'/image.tif',{headers:{range:'bytes=0-7','if-match':'"survey-1"'}})).status,412);
 } finally { await provider.close(); }
});

test('压缩瓦片与未压缩有不同体积', async () => {
 const provider = await createProvider();
 try {
const before=(await(await fetch(provider.base+'/image.tif')).arrayBuffer()).byteLength;await controlled(provider,{mode:'deflate'});const after=(await(await fetch(provider.base+'/image.tif')).arrayBuffer()).byteLength;assert.ok(after<before);
 } finally { await provider.close(); }
});
