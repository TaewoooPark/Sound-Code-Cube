// Run with: sclang native/superdirt.scd
// Requires SuperCollider, the SuperDirt quark, and Dirt-Samples.
(
var nativeDirectory = thisProcess.nowExecutingPath.dirname;
var samples = "SCC_SAMPLE_PATH".getenv;
if(samples.isNil) {
    samples = nativeDirectory.dirname +/+ ".runtime/Dirt-Samples/*";
};
s.options.numBuffers = 1024 * 64;
s.options.memSize = 8192 * 16;
s.options.numWireBufs = 2048;
s.options.maxNodes = 1024 * 16;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 0;
s.latency = 0.15;

s.waitForBoot {
    ~dirt = SuperDirt(2, s);
    ~dirt.loadSoundFiles(samples);
    s.sync;
    ~sccDeckBuses = [Bus.audio(s, 2), Bus.audio(s, 2)];
    ~sccHitBus = Bus.audio(s, 2);
    ~dirt.start(57120, Array.fill(17, { |index|
        if(index < 8) { ~sccDeckBuses[0].index } {
            if(index < 16) { ~sccDeckBuses[1].index } { ~sccHitBus.index };
        };
    }));
    (nativeDirectory +/+ "synths.scd").load;
    SynthDef(\sccmasterguard, { |deckABus=0, deckBBus=0, hitBus=0, deckA=1, deckB=0, fade=0.02, enabled=0|
        var gainA = (VarLag.kr(deckA, fade, 0, \linear).clip(0, 1) * (pi / 2)).sin;
        var gainB = (VarLag.kr(deckB, fade, 0, \linear).clip(0, 1) * (pi / 2)).sin;
        var mixed = (In.ar(deckABus, 2) * gainA) + (In.ar(deckBBus, 2) * gainB) + In.ar(hitBus, 2);
        ReplaceOut.ar(0, Limiter.ar(LeakDC.ar(mixed * Lag.kr(enabled, 0.01)), 0.9, 0.005));
    }).add;
    s.sync;
    if([\bd, \sd, \hh, \cp].every { |name| ~dirt.soundLibrary.buffers[name].notNil }.not) {
        Error("Sound Code Cube is missing required Dirt-Samples (bd, sd, hh, cp).").throw;
    };
    if([\sccbass, \sccchords, \sccmelody, \scctexture, \sccacid, \sccpluck, \sccbell, \sccpad, \sccorgan, \sccfm].every { |name| SynthDescLib.global.at(name).notNil }.not) {
        Error("Sound Code Cube core synth definitions did not load.").throw;
    };
    ~sccmaster = Synth.tail(s, \sccmasterguard, [\deckABus, ~sccDeckBuses[0].index,
        \deckBBus, ~sccDeckBuses[1].index, \hitBus, ~sccHitBus.index]);
    s.sync;
    SuperDirt.default = ~dirt;
    ~sccEpoch = 0.0;
    ~sccPaused = true;
    ~dirt.dropWhen = true;
    // Every control packet carries a monotonic fence. Old UDP arrivals cannot unmute a stop.
    OSCdef(\soundCodeCubeTransport, { |msg, time, address|
        var epoch = msg[3].asFloat;
        if(address.ip == "127.0.0.1") {
            if(epoch >= ~sccEpoch) {
                ~sccEpoch = epoch;
                if(msg[1].asInteger != 0) {
                    ~sccPaused = true;
                    ~dirt.dropWhen = true;
                    s.sendMsg('/clearSched');
                    ~sccmaster.set(\enabled, 0, \fade, 0.015, \deckA, 0, \deckB, 0);
                    ~dirt.orbits.do(_.freeSynths);
                } {
                    ~sccPaused = false;
                    ~dirt.dropWhen = false;
                    ~sccmaster.set(\enabled, 1, \fade, 0.015,
                        \deckA, if(msg[2].asInteger == 0) { 1 } { 0 },
                        \deckB, if(msg[2].asInteger == 1) { 1 } { 0 });
                };
            };
            SystemClock.sched(if(msg[1].asInteger != 0) { 0.35 } { 0 }, {
                NetAddr("127.0.0.1", msg[4].asInteger).sendMsg("/scc/transported");
                nil;
            });
        };
    }, '/scc/transport');
    OSCdef(\soundCodeCubeMix, { |msg, time, address|
        if(address.ip == "127.0.0.1") {
            if((msg[4].asFloat == ~sccEpoch) and: { ~sccPaused.not }) {
                s.makeBundle(msg[3].asFloat.max(0), {
                    ~sccmaster.set(\fade, msg[2].asFloat.clip(0.1, 30),
                        \deckA, if(msg[1].asInteger == 0) { 1 } { 0 },
                        \deckB, if(msg[1].asInteger == 1) { 1 } { 0 });
                });
            };
            NetAddr("127.0.0.1", msg[5].asInteger).sendMsg("/scc/mixed");
        };
    }, '/scc/mix');
    OSCdef(\soundCodeCubeClearDeck, { |msg, time, address|
        if(address.ip == "127.0.0.1") {
            // Guard again when the callback executes; stop may have invalidated this fade.
            SystemClock.sched(0.35, {
                if((msg[2].asFloat == ~sccEpoch) and: { ~sccPaused.not }) {
                    ~dirt.orbits.copyRange(msg[1].asInteger * 8, (msg[1].asInteger * 8) + 7).do(_.freeSynths);
                };
                SystemClock.sched(0.2, {
                    NetAddr("127.0.0.1", msg[3].asInteger).sendMsg("/scc/deck-cleared");
                    nil;
                });
                nil;
            });
        };
    }, '/scc/clear-deck');
    OSCdef(\soundCodeCubeHit, { |msg, time, address|
        if(address.ip == "127.0.0.1") {
            if((msg[9].asFloat == ~sccEpoch) and: { ~sccPaused.not }) {
                // Every request creates fresh nodes; stop clears all scheduled hits and tails.
                ~dirt.orbits[16].value((s: msg[1].asSymbol, midinote: msg[2].asFloat,
                    gain: msg[3].asFloat, sustain: msg[4].asFloat, pan: msg[5].asFloat,
                    cutoff: msg[6].asFloat, n: msg[7].asInteger, latency: 0.03 + msg[8].asFloat.max(0)));
            };
            NetAddr("127.0.0.1", msg[10].asInteger).sendMsg("/scc/hit-done");
        };
    }, '/scc/hit');
    OSCdef(\soundCodeCubeReady, { |msg, time, address|
        if(address.ip == "127.0.0.1") {
            NetAddr("127.0.0.1", msg[1].asInteger).sendMsg("/scc/pong");
        };
    }, '/scc/ping');
    "Sound Code Cube: SuperDirt is ready on 127.0.0.1:57120".postln;
};
s.boot;
)
