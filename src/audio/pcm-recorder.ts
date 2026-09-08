// Dedicated AudioWorklet module, emitted as a same-origin JS asset by Vite.
// It receives the real MediaStreamAudioSourceNode input. No synthetic samples,
// denoising, resampling, speech analysis or main-thread ScriptProcessor fallback.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof PcmCaptureProcessor): void;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private buffer = new Float32Array(2048);
  private used = 0;
  private frames = 0;
  private finished = false;
  private readonly maxFrames: number;

  constructor(options: { processorOptions: { maxSeconds: number; maxBytes: number } }) {
    super();
    this.maxFrames = Math.min(Math.floor(sampleRate * options.processorOptions.maxSeconds),
      Math.floor((options.processorOptions.maxBytes - 44) / 2));
    this.port.onmessage = event => {
      if (event.data === "stop") this.finish();
      else if (event.data === "cancel") { this.finished = true; this.used = 0; }
    };
  }

  private flush() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ type: "data", samples }, [samples.buffer]);
    this.used = 0;
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    this.flush();
    this.port.postMessage({ type: "done" });
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.finished) return false;
    // Explicit one-channel AudioWorkletNode input performs browser-standard
    // speech downmixing; an absent input must never be counted as captured time.
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    // Construction is not capture: the UI may start its clock only after an
    // actual input quantum reaches the rendering thread (including real silence).
    if (!this.frames) this.port.postMessage({ type: "ready" });
    for (const value of input) {
      if (this.frames >= this.maxFrames) { this.finish(); return false; }
      this.buffer[this.used++] = value;
      this.frames++;
      if (this.used === this.buffer.length) this.flush();
    }
    if (this.frames >= this.maxFrames) this.finish();
    // Output remains zero. Microphone monitoring is deliberately not connected.
    return !this.finished;
  }
}

registerProcessor("jove-pcm-capture", PcmCaptureProcessor);
export {};
