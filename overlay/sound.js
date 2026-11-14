// Glint sounds: synthesized with WebAudio, no audio files.
// Serious, slightly futuristic: soft sine/triangle tones, a low sub, a filtered
// noise "static" tail. Nothing shrill. GLINT_MUTE=1 silences everything.
(function () {
  let ctx = null;
  let master = null;
  let muted = false;

  function audio() {
    if (muted) return null;
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.22;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 4;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  }

  function tone(at, freq, dur, { type = "sine", gain = 0.5, glideTo = null, attack = 0.012, filter = null } = {}) {
    const c = ctx;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(gain, at + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let node = osc.connect(amp);
    if (filter) {
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = filter;
      f.Q.value = 2;
      node = amp.connect(f);
      f.connect(master);
    } else {
      amp.connect(master);
    }
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  function noise(at, dur, { gain = 0.08, from = 2400, to = 300 } = {}) {
    const c = ctx;
    const len = Math.max(1, Math.floor(c.sampleRate * dur));
    const buffer = c.createBuffer(1, len, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (Math.random() < 0.3 ? 1 : 0.25);
    const src = c.createBufferSource();
    src.buffer = buffer;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.4;
    f.frequency.setValueAtTime(from, at);
    f.frequency.exponentialRampToValueAtTime(to, at + dur);
    const amp = c.createGain();
    amp.gain.setValueAtTime(gain, at);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(amp).connect(master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  // Incoming holocall: a low sub swell, then two pairs of soft fifth chimes
  // with a faint shimmer, like a secure line opening.
  function incoming() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + 0.02;
    tone(t, 55, 0.9, { type: "sine", gain: 0.35, attack: 0.25, glideTo: 82 });
    noise(t, 0.22, { gain: 0.05, from: 5200, to: 900 });
    for (const offset of [0.12, 0.82]) {
      tone(t + offset, 392, 0.34, { type: "triangle", gain: 0.32, filter: 2400 });
      tone(t + offset, 587.3, 0.34, { type: "sine", gain: 0.2 });
      tone(t + offset + 0.17, 523.3, 0.42, { type: "triangle", gain: 0.3, filter: 2400 });
      tone(t + offset + 0.17, 784, 0.42, { type: "sine", gain: 0.16 });
      tone(t + offset + 0.17, 1568, 0.3, { type: "sine", gain: 0.035, glideTo: 1590 });
    }
  }

  // Answer sent: two quick rising blips.
  function answered() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + 0.01;
    tone(t, 659.3, 0.09, { type: "triangle", gain: 0.28 });
    tone(t + 0.075, 987.8, 0.14, { type: "triangle", gain: 0.26 });
  }

  // Call ended: a falling tone into a short burst of static.
  function ended() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + 0.01;
    tone(t, 523.3, 0.38, { type: "sine", gain: 0.26, glideTo: 130.8 });
    tone(t, 261.6, 0.38, { type: "triangle", gain: 0.12, glideTo: 65.4, filter: 900 });
    noise(t + 0.26, 0.18, { gain: 0.06, from: 1800, to: 240 });
  }

  // Feed notice: one soft tick.
  function notice() {
    const c = audio();
    if (!c) return;
    const t = c.currentTime + 0.01;
    tone(t, 1174.7, 0.08, { type: "sine", gain: 0.14 });
    tone(t + 0.05, 1760, 0.1, { type: "sine", gain: 0.06 });
  }

  window.glintSound = {
    setMuted(value) {
      muted = Boolean(value);
    },
    isMuted() {
      return muted;
    },
    incoming,
    answered,
    ended,
    notice,
  };
})();
