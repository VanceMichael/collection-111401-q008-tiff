import { makeTiff } from './tiff.mjs';
import { serveRange } from './range.mjs';
export const initialState = { generation: 1, mode: 'normal', clock: 1000 };
export async function stop(state) {  }
export async function routes(context) {
 const { request, url, body, payload, state, json, text, binary } = context;

 if(url.pathname==='/survey') return json({id:'plot-7',edition:state.generation,resources:[{href:'/image.tif',pixelSize:1,width:32,height:32},{href:'/overview.tif',pixelSize:2,width:32,height:32}],requestedWindow:{x:14,y:14,width:5,height:5},maxPixelSize:1,nodata:0});
 if(url.pathname==='/image.tif'||url.pathname==='/overview.tif') return serveRange(context,makeTiff(state.generation,state.mode==='deflate'),'image/tiff','"survey-'+state.generation+'"');

}
