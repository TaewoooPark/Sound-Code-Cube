// Core SuperCollider UGens only: the score does not depend on sc3-plugins.
(
SynthDef(\sccbass, { |out=0, freq=110, sustain=0.25, pan=0.5|
    var env = EnvGen.ar(Env.linen(0.006, sustain.max(0.02), 0.09), doneAction: 2);
    var sound = (VarSaw.ar(freq, 0, 0.34, 0.2) + SinOsc.ar(freq, 0, 0.28));
    sound = RLPF.ar(sound, (freq * 5).clip(180, 1800), 0.7);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\sccchords, { |out=0, freq=440, sustain=1, pan=0.5|
    var env = EnvGen.ar(Env.linen(0.03, sustain.max(0.04), 0.3), doneAction: 2);
    var sound = Mix(VarSaw.ar(freq * [0.997, 1.003], 0, 0.45, 0.075)) + SinOsc.ar(freq, 0, 0.08);
    sound = RLPF.ar(sound, 2600, 0.8);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\sccmelody, { |out=0, freq=660, sustain=0.2, pan=0.5|
    var env = EnvGen.ar(Env.perc(0.004, sustain.max(0.1) + 0.22, 1, -5), doneAction: 2);
    var sound = SinOsc.ar(freq, SinOsc.ar(freq * 2, 0, env * 1.7), 0.23);
    sound = sound + SinOsc.ar(freq * 3, 0, 0.035 * env);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\scctexture, { |out=0, freq=880, sustain=1.5, pan=0.5|
    var env = EnvGen.ar(Env.linen(0.3, sustain.max(0.1), 0.7), doneAction: 2);
    var sound = Mix(SinOsc.ar(freq * [0.5, 1, 1.002, 2.001], 0, [0.06, 0.08, 0.06, 0.02]));
    sound = sound + BPF.ar(PinkNoise.ar(0.018), freq * 2, 0.3);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

// The additional voices use sustain as their complete note duration, including
// attack and release. All voices free themselves, so short genre patterns do
// not accumulate long-running nodes or depend on a later gate-off message.

SynthDef(\sccacid, { |out=0, freq=110, sustain=0.25, pan=0.5|
    var duration = sustain.max(0.03);
    var pitch = freq.clip(30, 8000);
    var env = EnvGen.ar(Env([0, 1, 0.68, 0], duration * [0.02, 0.72, 0.26], [-2, -2, -5]), doneAction: 2);
    var sweep = EnvGen.kr(Env.perc(0.002, duration * 0.85, 1, -5));
    var cutoff = (140 + (pitch * 2) + (sweep * 4200)).clip(90, 6500);
    var sound = Saw.ar(pitch, 0.34) + Pulse.ar(pitch, 0.48, 0.12);
    sound = RLPF.ar(sound, cutoff, 0.18);
    // Resonance is deliberately driven into a bounded soft saturation.
    sound = (LeakDC.ar(sound) * 2.2).tanh * 0.25;
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\sccpluck, { |out=0, freq=440, sustain=0.35, pan=0.5|
    var duration = sustain.max(0.05);
    var pitch = freq.clip(30, 8000);
    var env = EnvGen.ar(Env([0, 1, 0.7, 0], duration * [0.012, 0.628, 0.36], [0, -1, -6]), doneAction: 2);
    // Core Pluck implements a Karplus-Strong delay with a damped feedback loop.
    // A single initial trigger injects a noise burst into the string.
    var sound = Pluck.ar(WhiteNoise.ar(0.45), Impulse.kr(0), 0.05, pitch.reciprocal, duration * 2.5, 0.45);
    sound = HPF.ar(LeakDC.ar(sound), 45);
    sound = (sound * 3).tanh * 0.27;
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\sccbell, { |out=0, freq=660, sustain=0.7, pan=0.5|
    var duration = sustain.max(0.04);
    var pitch = freq.clip(30, 8000);
    var attack = (duration * 0.04).min(0.002);
    var release = duration * 0.12;
    var env = EnvGen.ar(Env.linen(attack, duration - attack - release, release), doneAction: 2);
    // Inharmonic metal modes lose their upper partials faster than their body.
    var partialEnv = EnvGen.ar(Env.perc(0.001, duration * [1, 0.65, 0.38, 0.2], 1, -5));
    var partials = SinOsc.ar((pitch * [1, 2.756, 5.404, 8.933]).clip(20, 18000), 0, [0.16, 0.06, 0.035, 0.012]);
    var sound = Mix(partials * partialEnv);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\sccpad, { |out=0, freq=330, sustain=1.8, pan=0.5|
    var duration = sustain.max(0.06);
    var pitch = freq.clip(30, 8000);
    var env = EnvGen.ar(Env.linen(duration * 0.28, duration * 0.44, duration * 0.28, 1, \sine), doneAction: 2);
    var width = SinOsc.kr(0.17, 0).range(0.36, 0.62);
    var cutoff = (pitch * 3.5 + 900 + (env * 1800)).clip(500, 6500);
    var sound = Mix(VarSaw.ar(pitch * [0.996, 1, 1.004], [0, 0.25, 0.5], width, [0.055, 0.045, 0.055]));
    sound = sound + SinOsc.ar(pitch, 0, 0.07);
    sound = LPF.ar(sound, cutoff);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\sccorgan, { |out=0, freq=440, sustain=0.7, pan=0.5|
    var duration = sustain.max(0.03);
    var pitch = freq.clip(30, 8000);
    var attack = (duration * 0.1).min(0.008);
    var release = (duration * 0.25).min(0.04);
    var env = EnvGen.ar(Env.linen(attack, duration - attack - release, release), doneAction: 2);
    var percussion = EnvGen.kr(Env.perc(0.002, duration * 0.22, 1, -5));
    var sound = Mix(SinOsc.ar((pitch * [1, 2, 3, 4, 6, 8]).clip(20, 18000), 0, [0.12, 0.065, 0.028, 0.018, 0.012, 0.008]));
    sound = sound + SinOsc.ar((pitch * 3).min(18000), 0, percussion * 0.022);
    sound = sound * SinOsc.kr(5.8, 0).range(0.92, 1);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;

SynthDef(\sccfm, { |out=0, freq=440, sustain=0.65, pan=0.5|
    var duration = sustain.max(0.04);
    var pitch = freq.clip(30, 4000);
    var attack = (duration * 0.03).min(0.003);
    var env = EnvGen.ar(Env.perc(attack, duration - attack, 1, -3), doneAction: 2);
    var modEnv = EnvGen.kr(Env.perc(0.001, duration * 0.38, 1, -5));
    var modulator = SinOsc.ar(pitch * 2, 0, pitch * 2.6 * modEnv);
    var sound = SinOsc.ar(pitch + modulator, 0, 0.21);
    sound = sound + SinOsc.ar(pitch * 0.5, 0, 0.035);
    sound = sound + SinOsc.ar((pitch * 7).min(18000), 0, modEnv * 0.02);
    Out.ar(out, DirtPan.ar(sound, ~dirt.numChannels, pan, env));
}).add;
)
