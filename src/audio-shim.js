// Audio-event capture shim. Injected into the page before any user JS runs.
// Replaces window.AudioContext with a mock that LOGS scheduled audio events
// (oscillator start/stop times, peak gain, frequency) instead of producing
// sound. The host (Node) reads window.__getAudioEvents() after the render and
// synthesizes the actual audio from user-provided sample files.
//
// This works because Web Audio scheduling is declarative: every event has a
// start time, a duration, a frequency, and a gain envelope. We don't need to
// run the DSP — we just record the schedule, then replay it on the Node side.

export const audioShimSource = `(() => {
  if (window.__claude2vid_audio) return;

  const events = [];
  let nextNodeId = 1;
  const virtualSeconds = () => (window.__virtualNow ? window.__virtualNow() : 0) / 1000;

  // AudioParam — supports setValueAtTime + linear/exponential ramps. We track
  // the peak value reached so the host can normalize per-event gain.
  class MockAudioParam {
    constructor(initial = 0) {
      this.value = initial;
      this._peak = Math.abs(initial);
      this._lastSetTime = 0;
    }
    setValueAtTime(v, t) {
      this.value = v;
      this._lastSetTime = t;
      if (Math.abs(v) > this._peak) this._peak = Math.abs(v);
      return this;
    }
    linearRampToValueAtTime(v, t) {
      this.value = v;
      if (Math.abs(v) > this._peak) this._peak = Math.abs(v);
      return this;
    }
    exponentialRampToValueAtTime(v, t) {
      this.value = v;
      if (Math.abs(v) > this._peak) this._peak = Math.abs(v);
      return this;
    }
    setTargetAtTime(v, t, tc) {
      this.value = v;
      if (Math.abs(v) > this._peak) this._peak = Math.abs(v);
      return this;
    }
    setValueCurveAtTime(curve, t, dur) {
      for (const v of curve) if (Math.abs(v) > this._peak) this._peak = Math.abs(v);
      return this;
    }
    cancelScheduledValues(t) { return this; }
    cancelAndHoldAtTime(t) { return this; }
  }

  class MockOscillator {
    constructor(ctx) {
      this._id = nextNodeId++;
      this._ctx = ctx;
      this.type = 'sine';
      this.frequency = new MockAudioParam(440);
      this.detune = new MockAudioParam(0);
      this._gainNode = null; // populated when we connect into a GainNode
      this._startTime = null;
      this._stopTime = null;
      this._stopped = false;
    }
    connect(target) {
      if (target instanceof MockGain) this._gainNode = target;
      return target;
    }
    disconnect() {}
    start(t) {
      if (this._startTime != null) return; // start can only be called once
      this._startTime = (t == null) ? virtualSeconds() : t;
    }
    stop(t) {
      if (this._stopped) return;
      this._stopped = true;
      this._stopTime = (t == null) ? virtualSeconds() : t;
      // Record the event. Default duration to 100ms if the page never called stop().
      const start = this._startTime ?? this._stopTime;
      const end = this._stopTime;
      events.push({
        startTime: start,
        endTime: end,
        duration: Math.max(0, end - start),
        frequency: this.frequency.value,
        type: this.type,
        peakGain: this._gainNode ? this._gainNode.gain._peak : 1,
      });
    }
    addEventListener() {}
    removeEventListener() {}
  }

  class MockGain {
    constructor(ctx) {
      this._id = nextNodeId++;
      this._ctx = ctx;
      this.gain = new MockAudioParam(1);
    }
    connect(target) { return target; }
    disconnect() {}
  }

  class MockBufferSource {
    constructor(ctx) {
      this._ctx = ctx;
      this.buffer = null;
      this.loop = false;
      this.playbackRate = new MockAudioParam(1);
      this._gainNode = null;
      this._startTime = null;
      this._stopped = false;
    }
    connect(target) {
      if (target instanceof MockGain) this._gainNode = target;
      return target;
    }
    disconnect() {}
    start(t, offset, dur) {
      this._startTime = (t == null) ? virtualSeconds() : t;
      const duration = (this.buffer && this.buffer.duration) ? this.buffer.duration : (dur || 0.1);
      events.push({
        startTime: this._startTime,
        endTime: this._startTime + duration,
        duration,
        frequency: 0, // buffer sources have no single frequency
        type: 'buffer',
        peakGain: this._gainNode ? this._gainNode.gain._peak : 1,
      });
    }
    stop() { this._stopped = true; }
  }

  class MockAudioContext extends EventTarget {
    constructor() {
      super();
      this.state = 'running';
      this.sampleRate = 44100;
      this.baseLatency = 0;
      this.outputLatency = 0;
      this.destination = { _isDestination: true, connect: () => {}, disconnect: () => {} };
      this.listener = {};
    }
    get currentTime() { return virtualSeconds(); }
    createOscillator() { return new MockOscillator(this); }
    createGain() { return new MockGain(this); }
    createBufferSource() { return new MockBufferSource(this); }
    createBuffer(channels, length, sampleRate) {
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length),
        copyToChannel: () => {},
        copyFromChannel: () => {},
      };
    }
    createBiquadFilter() { return { connect: t => t, disconnect: () => {}, frequency: new MockAudioParam(350), Q: new MockAudioParam(1), gain: new MockAudioParam(0), type: 'lowpass' }; }
    createDelay() { return { connect: t => t, disconnect: () => {}, delayTime: new MockAudioParam(0) }; }
    createDynamicsCompressor() { return { connect: t => t, disconnect: () => {}, threshold: new MockAudioParam(-24), knee: new MockAudioParam(30), ratio: new MockAudioParam(12), attack: new MockAudioParam(0.003), release: new MockAudioParam(0.25) }; }
    createStereoPanner() { return { connect: t => t, disconnect: () => {}, pan: new MockAudioParam(0) }; }
    createPanner() { return { connect: t => t, disconnect: () => {} }; }
    createAnalyser() { return { connect: t => t, disconnect: () => {}, getFloatFrequencyData: () => {}, getByteFrequencyData: () => {}, getFloatTimeDomainData: () => {}, getByteTimeDomainData: () => {}, fftSize: 2048, frequencyBinCount: 1024, smoothingTimeConstant: 0.8 }; }
    createConvolver() { return { connect: t => t, disconnect: () => {}, buffer: null, normalize: true }; }
    createWaveShaper() { return { connect: t => t, disconnect: () => {}, curve: null, oversample: 'none' }; }
    createConstantSource() { return { connect: t => t, disconnect: () => {}, offset: new MockAudioParam(1), start: () => {}, stop: () => {} }; }
    decodeAudioData(data) { return Promise.resolve(this.createBuffer(2, 1, this.sampleRate)); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }

  window.AudioContext = MockAudioContext;
  window.webkitAudioContext = MockAudioContext;
  // OfflineAudioContext: same mock — events would still be captured if the page
  // used offline rendering for some reason.
  window.OfflineAudioContext = MockAudioContext;
  window.webkitOfflineAudioContext = MockAudioContext;

  window.__getAudioEvents = () => events.slice().sort((a, b) => a.startTime - b.startTime);
  window.__claude2vid_audio = { ready: true, version: 1 };
})();`;
