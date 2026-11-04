import { describe, expect, it } from "vitest";
import { stripPngAncillaryMetadata, validateScreenMarks } from "./ScreenAnnotationRenderer.js";

const PIXEL="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cJyoAAAAASUVORK5CYII=";
function extraChunk(name:string){
  const value=Buffer.alloc(12);
  value.writeUInt32BE(0,0);
  value.write(name,4,"ascii");
  return value;
}
describe("screen annotation owner safety",()=>{
  it("accepts exactly three bounded modes and enforces coordinate/text limits",()=>{
    expect(validateScreenMarks([
      {kind:"box",x:50,y:50},{kind:"arrow",x:900,y:850},
      {kind:"text",x:350,y:200,text:"检查这里"},
    ])).toHaveLength(3);
    expect(()=>validateScreenMarks(Array.from({length:13},
      ()=>({kind:"box",x:300,y:300})))).toThrow("SCREEN_MARKS_INVALID");
    for(const invalid of [
      {kind:"arrow",x:-1,y:10},{kind:"box",x:1001,y:5},
      {kind:"text",x:10,y:10,text:"a".repeat(61)},
      {kind:"text",x:10,y:10,text:"bad\nvalue"},
      {kind:"text",x:10,y:10,text:"OK",script:"do_not_accept"},
      {kind:"box",x:9,y:10,content:"injected"},
      {kind:"polygon",x:20,y:20},
    ])expect(()=>validateScreenMarks([invalid])).toThrow();
  });
  it("drops only optional PNG ancillary metadata and keeps critical bytes unchanged",()=>{
    const original=Buffer.from(PIXEL,"base64");
    // The fixture is already a complete one-pixel PNG. Add optional tEXt chunk
    // with no content; normalization must restore exactly the original bytes.
    const inserted=Buffer.concat([
      original.subarray(0,33),extraChunk("tEXt"),original.subarray(33),
    ]);
    expect(stripPngAncillaryMetadata(inserted).equals(original)).toBe(true);
    const forbidden=Buffer.concat([
      original.subarray(0,33),extraChunk("ABCD"),original.subarray(33),
    ]);
    expect(()=>stripPngAncillaryMetadata(forbidden)).toThrow("ANNOTATION_PNG_CRITICAL_CHUNK");
    expect(()=>stripPngAncillaryMetadata(Buffer.from("not a PNG"))).toThrow("ANNOTATION_PNG_INVALID");
  });
});