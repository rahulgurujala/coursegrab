// node-vtt-to-srt ships no types and has no @types package. Minimal shape for the one thing this
// app uses it for: a Transform stream that converts piped-in WebVTT to SRT.
declare module "node-vtt-to-srt" {
  import type { Transform } from "stream";
  function vtt2srt(): Transform;
  export default vtt2srt;
}
