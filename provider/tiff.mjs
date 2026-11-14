import { deflateSync } from 'node:zlib';
export function makeTiff(generation, compressed=false) {
 const tiles=Array.from({length:4},(_,index)=>Buffer.alloc(256,generation*10+index));
 const packed=compressed?tiles.map(tile=>deflateSync(tile)):tiles;
 const count=14;const dataStart=8+2+count*12+4;
 const offsetsStart=dataStart;const countsStart=offsetsStart+16;const scaleStart=countsStart+16;const tieStart=scaleStart+24;const pixelsStart=tieStart+48;
 const file=Buffer.alloc(pixelsStart+packed.reduce((sum,tile)=>sum+tile.length,0));
 file.write('II');file.writeUInt16LE(42,2);file.writeUInt32LE(8,4);file.writeUInt16LE(count,8);
 const entries=[[256,4,1,32],[257,4,1,32],[258,3,1,8],[259,3,1,compressed?8:1],[262,3,1,1],[277,3,1,1],[284,3,1,1],[322,4,1,16],[323,4,1,16],[324,4,4,offsetsStart],[325,4,4,countsStart],[339,3,1,1],[33550,12,3,scaleStart],[33922,12,6,tieStart]].sort((left,right)=>left[0]-right[0]);
 entries.forEach(([tag,type,size,value],index)=>{const cursor=10+index*12;file.writeUInt16LE(tag,cursor);file.writeUInt16LE(type,cursor+2);file.writeUInt32LE(size,cursor+4);file.writeUInt32LE(value,cursor+8);});
 [1,1,0].forEach((value,index)=>file.writeDoubleLE(value,scaleStart+index*8));[0,0,0,100,200,0].forEach((value,index)=>file.writeDoubleLE(value,tieStart+index*8));
 let offset=pixelsStart;packed.forEach((tile,index)=>{file.writeUInt32LE(offset,offsetsStart+index*4);file.writeUInt32LE(tile.length,countsStart+index*4);tile.copy(file,offset);offset+=tile.length;});
 return file;
}
