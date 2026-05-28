// Audio CAPTURE shim. Unlike audio-shim.js (which only logs events), this
// version delegates every AudioContext call to a REAL OfflineAudioContext, so
// the page's full DSP output is preserved exactly as a browser would play it.
// After the render, __renderAndUploadAudio() calls offline.startRendering(),
// encodes the resulting AudioBuffer as a 32-bit float WAV, and POSTs it back
// to a local server endpoint.
//
// The wrapper is needed because:
//   * OfflineAudioContext.currentTime is read-only and stays at 0 until
//     startRendering(). The page reads currentTime while scheduling — we
//     override the getter to return the virtual-clock value, so scheduled
//     events end up at correct positions in the offline timeline.
//   * The page expects a few live-AudioContext-only methods (resume, suspend,
//     state). We stub them.

export function buildAudioCaptureShim({ durationSeconds, sampleRate = 44100, channels = 2, padSeconds = 2 }) {
  const totalSeconds = durationSeconds + padSeconds; // extra room for events scheduled past last frame
  return `(() => {
    if (window.__claude2vid_audio) return;

    const RealOAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!RealOAC) {
      console.warn('[claude2vid] OfflineAudioContext not available; audio capture disabled');
      window.__claude2vid_audio = { ready: true, mode: 'capture', disabled: true };
      return;
    }

    const TOTAL_SECONDS = ${totalSeconds};
    const SAMPLE_RATE = ${sampleRate};
    const CHANNELS = ${channels};
    const virtualSeconds = () => (window.__virtualNow ? window.__virtualNow() : 0) / 1000;

    let offline = null;
    let renderedBuffer = null;

    function ensureOffline() {
      if (!offline) {
        offline = new RealOAC(CHANNELS, Math.ceil(TOTAL_SECONDS * SAMPLE_RATE), SAMPLE_RATE);
      }
      return offline;
    }

    class VirtualAudioContext {
      constructor() {
        this._offline = ensureOffline();
        this.destination = this._offline.destination;
        this.sampleRate = this._offline.sampleRate;
        this.state = 'running';
        this.baseLatency = 0;
        this.outputLatency = 0;
        this.listener = this._offline.listener;
        this.audioWorklet = this._offline.audioWorklet;
      }
      get currentTime() { return virtualSeconds(); }
      createOscillator()          { return this._offline.createOscillator(); }
      createGain()                { return this._offline.createGain(); }
      createBuffer(...a)          { return this._offline.createBuffer(...a); }
      createBufferSource()        { return this._offline.createBufferSource(); }
      createBiquadFilter()        { return this._offline.createBiquadFilter(); }
      createConvolver()           { return this._offline.createConvolver(); }
      createDelay(...a)           { return this._offline.createDelay(...a); }
      createDynamicsCompressor()  { return this._offline.createDynamicsCompressor(); }
      createPanner()              { return this._offline.createPanner(); }
      createStereoPanner()        { return this._offline.createStereoPanner(); }
      createAnalyser()            { return this._offline.createAnalyser(); }
      createWaveShaper()          { return this._offline.createWaveShaper(); }
      createIIRFilter(...a)       { return this._offline.createIIRFilter(...a); }
      createPeriodicWave(...a)    { return this._offline.createPeriodicWave(...a); }
      createChannelMerger(...a)   { return this._offline.createChannelMerger(...a); }
      createChannelSplitter(...a) { return this._offline.createChannelSplitter(...a); }
      createConstantSource()      { return this._offline.createConstantSource(); }
      decodeAudioData(...a)       { return this._offline.decodeAudioData(...a); }
      resume()  { return Promise.resolve(); }
      suspend() { return Promise.resolve(); }
      close()   { return Promise.resolve(); }
      addEventListener() {}
      removeEventListener() {}
    }

    window.AudioContext = VirtualAudioContext;
    window.webkitAudioContext = VirtualAudioContext;

    // CRITICAL FIX: in offline rendering, AudioScheduledSourceNode.start() / .stop()
    // called WITHOUT a \`when\` argument default to the context's currentTime — which
    // for OfflineAudioContext is stuck at 0 until startRendering() runs. The page's
    // virtual time may be far ahead (e.g. virtualSeconds() = 17.2). If \`stop()\` is
    // called no-args after \`start(17.2)\`, the schedule becomes \`stop(0)\` which is
    // before start; per spec stop time is clamped up to start → zero duration → the
    // oscillator is silent. This bites every page that uses voice-cap code like
    // \`try { oldVoice.osc.stop(); } catch(e){} \`.
    // Patch both methods so missing \`when\` substitutes our virtual clock.
    const Ascn = window.AudioScheduledSourceNode || (window.OscillatorNode && Object.getPrototypeOf(window.OscillatorNode.prototype).constructor);
    if (Ascn && Ascn.prototype && Ascn.prototype.start && Ascn.prototype.stop) {
      const realStart = Ascn.prototype.start;
      const realStop  = Ascn.prototype.stop;
      Ascn.prototype.start = function(when, offset, duration) {
        if (when === undefined) when = virtualSeconds();
        if (offset === undefined && duration === undefined) return realStart.call(this, when);
        if (duration === undefined) return realStart.call(this, when, offset);
        return realStart.call(this, when, offset, duration);
      };
      Ascn.prototype.stop = function(when) {
        if (when === undefined) when = virtualSeconds();
        return realStop.call(this, when);
      };
    }

    // WAV encoder, 32-bit IEEE float interleaved (format code 3).
    function audioBufferToWavFloat(buffer) {
      const numChannels = buffer.numberOfChannels;
      const sr = buffer.sampleRate;
      const frames = buffer.length;
      const bytesPerSample = 4;
      const blockAlign = numChannels * bytesPerSample;
      const byteRate = sr * blockAlign;
      const dataSize = frames * blockAlign;
      const ab = new ArrayBuffer(44 + dataSize);
      const view = new DataView(ab);
      let off = 0;
      const wStr = (s) => { for (let i = 0; i < s.length; i++) view.setUint8(off++, s.charCodeAt(i)); };
      const w32  = (v) => { view.setUint32(off, v, true); off += 4; };
      const w16  = (v) => { view.setUint16(off, v, true); off += 2; };
      wStr('RIFF'); w32(36 + dataSize); wStr('WAVE');
      wStr('fmt '); w32(16); w16(3); // 3 = IEEE float
      w16(numChannels); w32(sr); w32(byteRate); w16(blockAlign); w16(32);
      wStr('data'); w32(dataSize);
      const channelData = [];
      for (let c = 0; c < numChannels; c++) channelData.push(buffer.getChannelData(c));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numChannels; c++) {
          view.setFloat32(off, channelData[c][i], true);
          off += 4;
        }
      }
      return ab;
    }

    // Host-side hook: render + upload. Returns metadata about the rendered audio.
    window.__renderAndUploadAudio = async (uploadUrl) => {
      if (!offline) return { rendered: false, reason: 'page never constructed an AudioContext' };
      if (!renderedBuffer) renderedBuffer = await offline.startRendering();
      const wavAb = audioBufferToWavFloat(renderedBuffer);
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: wavAb,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error('audio upload failed: ' + res.status + ' ' + text);
      }
      return {
        rendered: true,
        sampleRate: renderedBuffer.sampleRate,
        length: renderedBuffer.length,
        durationSeconds: renderedBuffer.length / renderedBuffer.sampleRate,
        numChannels: renderedBuffer.numberOfChannels,
        bytes: wavAb.byteLength,
      };
    };

    window.__claude2vid_audio = { ready: true, mode: 'capture', version: 1 };
  })();`;
}
