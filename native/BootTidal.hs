:set -fno-warn-orphans -Wno-type-defaults -XMultiParamTypeClasses -XOverloadedStrings
:set prompt ""
:set prompt-cont ""

import Sound.Tidal.Boot
import System.IO (hSetBuffering, stdout, BufferMode(LineBuffering))
default (Rational, Integer, Double, Pattern String)

let sccConfig = defaultConfig { cCtrlListen = False, cEnableLink = False, cFrameTimespan = 1/50, cProcessAhead = 0.3 }
let sccTargets = [(superdirtTarget { oAddress = "127.0.0.1", oPort = 57120, oLatency = 0.05 }, [superdirtShape])]
tidalInst <- mkTidalWith sccTargets sccConfig
tidalNext <- mkTidalWith sccTargets (sccConfig { cCtrlPort = 6011 })
let sccStream deck = if deck == (0 :: Int) then tidalInst else tidalNext
let sccTempo deck bpm = streamSetBPM (sccStream deck) bpm
let sccCycle deck position = streamSetCycle (sccStream deck) position
let sccHush deck = streamHush (sccStream deck)
instance Tidally where tidal = tidalInst

hSetBuffering stdout LineBuffering
setcps (112/60/4)
hush
sccHush 1
putStrLn "__SCC_TIDAL_READY__"
