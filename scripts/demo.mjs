import { createProvider } from '../provider/server.mjs';
import { receivePlotWindow } from '../src/domain.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
  const result = await receivePlotWindow(provider.base, directory);
  console.log(JSON.stringify({
    service: 'tiff',
    manifest: result.manifest,
    pixels: [...result.pixels],
    source: { transferred: provider.state.transferred, requests: provider.audit }
  }, null, 2));
} finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
