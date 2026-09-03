// Web Audio API Sound Synthesizer for LooDoo
let audioCtx: AudioContext | null = null;
let soundEnabled = true;

export function setSoundEnabled(enabled: boolean) {
  soundEnabled = enabled;
  try {
    localStorage.setItem('loodoo_sound_enabled', enabled ? 'true' : 'false');
  } catch (e) {
    // Ignore storage issues
  }
}

export function isSoundEnabled(): boolean {
  try {
    const stored = localStorage.getItem('loodoo_sound_enabled');
    if (stored !== null) return stored === 'true';
  } catch (e) {
    // default true
  }
  return soundEnabled;
}

function getAudioContext(): AudioContext | null {
  if (!soundEnabled) return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Ensure WebAudio is automatically unlocked upon first mobile touch or click
if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  };
  window.addEventListener('touchstart', unlockAudio, { passive: true, once: false });
  window.addEventListener('pointerdown', unlockAudio, { passive: true, once: false });
  window.addEventListener('click', unlockAudio, { passive: true, once: false });
}

export const soundFx = {
  // Click button sound
  click: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.04);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.04);
    } catch (e) {}
  },

  // Dice roll shaker sound - realistic tumbling on board
  diceRoll: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const hits = 7;
      for (let i = 0; i < hits; i++) {
        const time = ctx.currentTime + i * 0.05 + (Math.random() * 0.02);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i % 2 === 0 ? 'triangle' : 'sine';
        const freq = 180 + Math.random() * 320;
        osc.frequency.setValueAtTime(freq, time);
        osc.frequency.exponentialRampToValueAtTime(80, time + 0.045);
        
        const vol = (0.15 + Math.random() * 0.12) * (1 - (i / hits) * 0.4);
        gain.gain.setValueAtTime(vol, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.045);
      }
    } catch (e) {}
  },

  // Token move single step tap sound
  tokenStep: (stepNumber = 0) => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      const baseFreq = 440; // A4
      const noteFreq = baseFreq * Math.pow(1.059463, (stepNumber % 12));
      osc.frequency.setValueAtTime(noteFreq, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(noteFreq * 1.2, ctx.currentTime + 0.07);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.07);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.07);
    } catch (e) {}
  },

  // Token hop sequence (counting & proceeding)
  tokenMoveSequence: (stepCount: number) => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const total = Math.max(1, Math.min(stepCount, 6));
      for (let i = 0; i < total; i++) {
        setTimeout(() => {
          soundFx.tokenStep(i);
        }, i * 110);
      }
    } catch (e) {}
  },

  // Token spawn out of yard
  tokenSpawn: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(300, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.28, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.15);
    } catch (e) {}
  },

  // Capture opponent token sound - dramatic crunch and rising fanfare
  capture: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      // 1. Crunch down zap
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(950, ctx.currentTime);
      osc1.frequency.exponentialRampToValueAtTime(120, ctx.currentTime + 0.22);
      gain1.gain.setValueAtTime(0.35, ctx.currentTime);
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start();
      osc1.stop(ctx.currentTime + 0.22);

      // 2. Triumphant rising chords
      const chord = [587.33, 739.99, 880, 1174.66]; // D5, F#5, A5, D6
      chord.forEach((freq, idx) => {
        const time = ctx.currentTime + 0.18 + idx * 0.07;
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(freq, time);
        gain2.gain.setValueAtTime(0.28, time);
        gain2.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(time);
        osc2.stop(time + 0.25);
      });
    } catch (e) {}
  },

  // Reached Home sound - glorious celebratory arpeggio
  home: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.51]; // C5, E5, G5, C6, E6
      notes.forEach((freq, idx) => {
        const time = ctx.currentTime + idx * 0.08;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        gain.gain.setValueAtTime(0.3, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.3);
      });
    } catch (e) {}
  },

  // Six Rolled fanfare sound
  sixRolled: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const notes = [659.25, 880, 1046.5]; // E5, A5, C6
      notes.forEach((freq, idx) => {
        const time = ctx.currentTime + idx * 0.07;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, time);
        gain.gain.setValueAtTime(0.25, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.2);
      });
    } catch (e) {}
  },

  // Your turn alert sound
  myTurn: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const notes = [440, 659.25]; // A4, E5
      notes.forEach((freq, idx) => {
        const time = ctx.currentTime + idx * 0.09;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        gain.gain.setValueAtTime(0.2, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.22);
      });
    } catch (e) {}
  },

  // Penalty / turn pass buzz
  penalty: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(280, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(140, ctx.currentTime + 0.3);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
  },

  // Victory fanfare
  win: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const melody = [
        { f: 523.25, d: 0.16 }, // C5
        { f: 659.25, d: 0.16 }, // E5
        { f: 783.99, d: 0.16 }, // G5
        { f: 1046.5, d: 0.35 }, // C6
        { f: 880.00, d: 0.16 }, // A5
        { f: 1046.5, d: 0.50 }, // C6 (long)
      ];
      let t = ctx.currentTime;
      melody.forEach((note) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(note.f, t);
        gain.gain.setValueAtTime(0.32, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + note.d);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + note.d);
        t += note.d + 0.04;
      });
    } catch (e) {}
  },

  // Snake bite hiss & slide down sound (Snake & Ladder mode)
  snakeBite: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      // 1. Noise hiss
      const bufferSize = ctx.sampleRate * 0.4;
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const whiteNoise = ctx.createBufferSource();
      whiteNoise.buffer = buffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(3200, ctx.currentTime);
      filter.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.4);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.3, ctx.currentTime);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);

      whiteNoise.connect(filter);
      filter.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      whiteNoise.start();

      // 2. Downward slide tone
      const osc = ctx.createOscillator();
      const oscGain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(450, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 0.4);
      oscGain.gain.setValueAtTime(0.2, ctx.currentTime);
      oscGain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.connect(oscGain);
      oscGain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {}
  },

  // Ladder climb ascending joyful arpeggio
  ladderClimb: () => {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const notes = [261.63, 329.63, 392.0, 523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, idx) => {
        const time = ctx.currentTime + idx * 0.055;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        gain.gain.setValueAtTime(0.22, time);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(time);
        osc.stop(time + 0.12);
      });
    } catch (e) {}
  },
};

// ================= BENGALI ACOUSTIC FOLK BACKGROUND MUSIC SYNTHESIZER =================
// Generates soothing acoustic Dotara, Bansuri flute drone, and gentle Bhatiyali rhythm
class FolkMusicEngine {
  private isPlaying = false;
  private musicVolume = 0.35;
  private timer: any = null;
  private droneOsc: OscillatorNode | null = null;
  private droneGain: GainNode | null = null;

  constructor() {
    try {
      const storedEnabled = localStorage.getItem('loodoo_music_enabled');
      const storedVol = localStorage.getItem('loodoo_music_volume');
      if (storedVol !== null) {
        this.musicVolume = parseFloat(storedVol) || 0.35;
      }
      if (storedEnabled === 'true') {
        // Will start upon user interaction
      }
    } catch (e) {}
  }

  public getVolume(): number {
    return this.musicVolume;
  }

  public setVolume(vol: number) {
    this.musicVolume = Math.max(0, Math.min(1, vol));
    try {
      localStorage.setItem('loodoo_music_volume', this.musicVolume.toString());
    } catch (e) {}
    if (this.droneGain && audioCtx) {
      this.droneGain.gain.setValueAtTime(this.musicVolume * 0.12, audioCtx.currentTime);
    }
  }

  public isMusicPlaying(): boolean {
    return this.isPlaying;
  }

  public isPlayingState(): boolean {
    return this.isPlaying;
  }

  public toggle(): boolean {
    if (this.isPlaying) {
      this.stop();
      return false;
    } else {
      this.start();
      return true;
    }
  }

  public start() {
    if (this.isPlaying) return;
    const ctx = getAudioContext();
    if (!ctx) return;

    this.isPlaying = true;
    try {
      localStorage.setItem('loodoo_music_enabled', 'true');
    } catch (e) {}

    // 1. Soft Bansuri Flute Drone (Tanpura Root D3 / A3)
    try {
      this.droneOsc = ctx.createOscillator();
      this.droneGain = ctx.createGain();
      this.droneOsc.type = 'sine';
      this.droneOsc.frequency.setValueAtTime(146.83, ctx.currentTime); // D3
      this.droneGain.gain.setValueAtTime(0.001, ctx.currentTime);
      this.droneGain.gain.linearRampToValueAtTime(this.musicVolume * 0.12, ctx.currentTime + 1.5);
      
      this.droneOsc.connect(this.droneGain);
      this.droneGain.connect(ctx.destination);
      this.droneOsc.start();
    } catch (e) {}

    // 2. Folk Dotara Pluck Pattern Loop (Bhatiyali Pentatonic: D4, F#4, G4, A4, C5, D5)
    const scale = [293.66, 369.99, 392.00, 440.00, 523.25, 587.33]; // D4, F#4, G4, A4, C5, D5
    const rhythmPattern = [0, 2, 3, 5, 3, 2, 1, 0, 3, 4, 3, 1];
    let step = 0;

    const playStep = () => {
      if (!this.isPlaying) return;
      const c = getAudioContext();
      if (c && c.state !== 'suspended') {
        const noteIdx = rhythmPattern[step % rhythmPattern.length];
        const freq = scale[noteIdx % scale.length];
        
        // Dotara Pluck Note
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, c.currentTime);
        
        // High harmonic shimmer
        const shimmer = c.createOscillator();
        const shimmerGain = c.createGain();
        shimmer.type = 'sine';
        shimmer.frequency.setValueAtTime(freq * 2, c.currentTime);

        const vol = this.musicVolume * 0.18;
        gain.gain.setValueAtTime(vol, c.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.28);
        shimmerGain.gain.setValueAtTime(vol * 0.4, c.currentTime);
        shimmerGain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.18);

        osc.connect(gain);
        gain.connect(c.destination);
        shimmer.connect(shimmerGain);
        shimmerGain.connect(c.destination);

        osc.start();
        shimmer.start();
        osc.stop(c.currentTime + 0.3);
        shimmer.stop(c.currentTime + 0.2);

        step++;
      }
      this.timer = setTimeout(playStep, 420);
    };

    playStep();
  }

  public stop() {
    this.isPlaying = false;
    try {
      localStorage.setItem('loodoo_music_enabled', 'false');
    } catch (e) {}
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.droneGain && audioCtx) {
      try {
        this.droneGain.gain.linearRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
        setTimeout(() => {
          this.droneOsc?.stop();
          this.droneOsc?.disconnect();
          this.droneGain?.disconnect();
          this.droneOsc = null;
          this.droneGain = null;
        }, 600);
      } catch (e) {}
    }
  }
}

export const folkMusic = new FolkMusicEngine();
export const folkMusicEngine = folkMusic;


