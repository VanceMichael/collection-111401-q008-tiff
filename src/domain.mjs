import { capture } from './client.mjs';
export async function receiveCurrent(base, directory) {
 const { bytes, receipt } = await capture(base + '/survey', directory);
 const data = JSON.parse(bytes);
 return { receipt: receipt.id, plot: data.id, window: data.requestedWindow, resources: data.resources };
}
