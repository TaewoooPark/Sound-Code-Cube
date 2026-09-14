# Sound Code Cube

**English** | [한국어](README.ko.md)

**One music, three areas — code · sound · space**

An instrument for reading sound through space, and playing that space in return.

Sound Code Cube maps eight musical voices composed by Codex into **three areas: code, sound, and space**. A TidalCycles score types itself across the bottom of the screen. A new voice enters every two cycles, while waves from the cube's eight corners reflect and overlap inside it. Tap a corner, or shake and throw the cube, to take part in the performance.

![Sound Code Cube during playback: a translucent cyan and violet pressure field inside a white cube, with a TidalCycles score typing below.](docs/images/sound-code-cube.png)

> **Requires a computer with Codex CLI installed and signed in through your own ChatGPT OAuth account.** Each person uses their own local Codex installation and account. Download and run the app locally; it is not a hosted web service.

[Installation](#installation) · [Controls](#controls) · [Three areas](#one-music-three-areas) · [Physics](#from-huygens-to-a-pressure-field) · [TidalCycles examples](#tidalcycles-examples) · [Latest release](https://github.com/TaewoooPark/Sound-Code-Cube/releases/latest)

## One music, three areas

![Code represents the symbolic score, Sound its performance in time, and Space its pressure field. Taps and throws feed back into performance and composition.](docs/images/three-areas.svg)

| Area | How music exists | How you experience it |
| --- | --- | --- |
| **Code — symbols** | A TidalCycles score describing notes, rhythms, instruments, and repetition | Read the rules that produce the sound. Generated code appears as each layer enters. |
| **Sound — time** | Sounds that arrive and decay to a pulse, with eight repeating voices | Listen, add hits by tapping corners, and choose when to transition. |
| **Space — a field** | A relative pressure field that propagates, reflects, and interferes from each voice | See how sounds occupy space together through color, density, and depth. |

These areas express the same score in different forms. Code specifies the events to come. Sound is their unfolding in time. Space reveals how those events spread and overlap. The listener's gestures connect all three.

Once all eight voices have entered, the music settles into a repeating state you can stay with. Completion means reaching that state; the next gesture opens another arrangement.

## A question that began with light

This work began with Diego Royo et al.'s **“mitransient: Transient light transport in Mitsuba 3.”** The research incorporates light's time of flight into rendering to simulate its propagation over time. It prompted a question: **if we can see light traveling through space, could mapping sound into three dimensions give it another kind of meaning?** [Paper, 2025](https://arxiv.org/abs/2510.25660)

Applying that question to sound led to Huygens' principle as a starting point for propagation. The cube's **eight corners became sources for eight musical voices**, and its **six faces became reflecting boundaries**. The interior becomes a space in which several sounds coexist. This project extends the idea of making a physical process visible over time to sound; it does not port mitransient or its light transport equations.

## States of the cube

<table>
  <tr>
    <td width="50%"><img src="docs/images/pressure-volume.png" alt="A translucent three-dimensional pressure field in cyan, yellow, and orange"/><br/><strong>Pressure as volume</strong><br/>Continuous color and transparency reveal the depth of compression and rarefaction.</td>
    <td width="50%"><img src="docs/images/genre-transition.png" alt="Violet and green intersect inside a rotated cube during a genre transition"/><br/><strong>Moving to another genre</strong><br/>Hue and a transition wavefront change as two pieces overlap.</td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/custom-colormap.png" alt="A paused cube with a user-selected color range"/><br/><strong>Choose how to read the field</strong><br/>Adjust the colormap, color range, and amplitude sensitivity.</td>
    <td width="50%" align="center"><img src="docs/images/mobile-volume.png" alt="A volumetric pressure field rendered in a viewport 390 pixels wide" width="180"/><br/><strong>Space on a smaller screen</strong><br/>Rotation and volume rendering adapt to a narrow viewport.</td>
  </tr>
</table>

The hero image shows actual app playback. The gallery above contains verification scenes captured with the same Three.js wave renderer under different inputs, palettes, and viewports. The mobile image demonstrates responsive rendering, not standalone operation on a phone without Codex. Image provenance and the original SVG diagrams are documented in the [gallery notes (Korean)](docs/gallery.md).

## Installation

### Requirements

- **Node.js 22.12 or later** and npm. CI checks Node.js 22 and 24.
- **A local Codex CLI installation**, signed in with **your own ChatGPT OAuth account**. Run `npm run doctor` to check detection. The app also searches for bundled CLIs in supported desktop apps; installing the CLI on your PATH makes it available directly from the terminal. [Official Codex CLI guide](https://developers.openai.com/codex/cli/)
- A modern browser supporting WebGL 2 and Web Audio. Start the first playback with the Play button.
- Internet access for Codex composition, with Codex access and available usage on your account.

The complete native audio path has been verified on macOS. Linux and WSL can use browser audio where Node.js and Codex CLI are available. Automatic native audio setup targets macOS with Homebrew; other operating systems require you to prepare TidalCycles and SuperCollider yourself.

### Quick start — local browser audio

If Codex is not installed, install the official CLI first:

```sh
npm install -g @openai/codex
```

Clone the repository and check your sign-in:

```sh
git clone https://github.com/TaewoooPark/Sound-Code-Cube.git
cd Sound-Code-Cube
npm ci

# Check the Codex executable, required CLI features, and your ChatGPT sign-in
npm run doctor

# Run only if you need to sign in
npm run login

# Download drum samples separately from their upstream repository
npm run setup:samples

npm run build
npm start
```

Open **[http://127.0.0.1:4318](http://127.0.0.1:4318)** and press Play in the upper left. `npm start` serves both the local API and the built interface. If Codex is missing or ChatGPT OAuth sign-in cannot be confirmed, startup stops and the terminal explains how to proceed. `npm run login` runs the installed Codex CLI's login flow. An existing sign-in can be reused.

This mode **performs the Codex-generated score with Web Audio**. Drums use the downloaded Dirt-Samples, and melodic parts use browser synthesizers. It does not execute Tidal Haskell in the browser.

### Full setup — native TidalCycles + SuperDirt

```sh
npm run setup:native
npm run build
npm run start:native
```

Open **[http://127.0.0.1:4318](http://127.0.0.1:4318)**. TidalCycles schedules the score, and SuperDirt with SuperCollider produces the sound. The browser drives the visualization using analysis signals from its own performance of the same score.

On macOS, `setup:native` uses Homebrew to prepare GHC, Cabal, libffi, and SuperCollider, then installs a Tidal package environment, SuperDirt, Vowel, and Dirt-Samples in the project's `.runtime/` directory. The first download and compilation can take time. Later runs reuse the installed tools and samples. See the [local runtime guide (Korean)](docs/runtime.md) for environment variables and execution details, and the [server documentation (Korean)](server/README.md) for the API.

### Distribution and accounts

The app is distributed as a [GitHub source release](https://github.com/TaewoooPark/Sound-Code-Cube/releases). Clone the repository or download a release and run it **on your own computer**, using your own account.

The app detects the local Codex CLI, checks its login status, and asks that CLI to compose. It does not send OAuth tokens to the browser or copy them into app configuration files. There is no browser field for an API key. Requests run under the signed-in account and count toward that account's usage. Authentication follows the [official Codex authentication documentation](https://developers.openai.com/codex/auth/).

## Controls

| Location / gesture | Result |
| --- | --- |
| Upper-left **Play / Stop**, or **Space** | Start or stop playback explicitly. Stop also works while a score is being prepared. |
| Upper-left **Refresh** | Select a genre different from the previous one and return to idle. Press Play to compose a new piece. |
| **Drag / touch** the cube | Rotate the space to view it from another angle. |
| **Click / tap a corner** during playback | Add a note from that voice. Three rapid taps produce three sequential hits. |
| **Shake in a zigzag, then throw quickly** during playback | Crossfade into the next genre over 6–12 seconds. Ordinary rotation and slow shaking do not trigger a transition. |
| Upper-right **colormap icon** | Change the palette, color range, and amplitude sensitivity. Settings are saved in the browser. |
| Bottom **code area** | Watch the generated TidalCycles score appear through typing. Long lines scroll horizontally. |

**Stop cancels composition requests, preparation of the next piece, scheduled notes, queued taps, and mixing.** A late response cannot restart playback automatically. If the current score is complete, the next Play resumes it from the paused position. Refresh and initial page load always leave the app idle. Corner taps and throws while stopped do not start composition or playback.

The interface uses a black background, white cube edges, white Tidal code, and a colored pressure field. The font is IBM Plex Mono. Button and input names are available to screen readers without adding visible explanatory text. Use Tab and arrow keys to adjust color ranges, and Escape to close settings.

## How the eight voices build

![Kick, bass, snare, hats, percussion, chords, melody, and texture enter at cycles 0, 2, 4, 6, 8, 10, 12, and 14.](docs/images/eight-layers.svg)

One cycle contains four beats. A phrase spans two cycles, with 32 sixteenth-note positions. **Kick → bass → snare → hats → percussion → chords → melody → texture** enter in sequence, then repeat together once all eight are present.

Eight genres—Deep house, Techno, UK garage, Drum and bass, Trip hop, Ambient, Electro, and Dub—use different tempo ranges, rhythms, tonalities, drum banks, and synthesizer combinations. A shuffled genre queue stored in the browser cycles through all eight. Both the app's Refresh button and a browser reload exclude the immediately preceding genre.

Codex generates all eight layers **as one structured score (JSON)** under the selected genre and instrument constraints. The server validates notes, timing, and instruments before rendering Tidal code. The audio engine schedules entries two cycles apart, without waiting for a model response on every beat. During playback, the current score provides context for preparing the next genre's score.

Codex receives **symbolic information about notes, rhythm, tonality, and instruments**. It does not listen to the audio or analyze microphone input. The typing reveals a generated score in performance time; it is not a stream of the model's internal reasoning. Failed generation is not silently replaced by a local score. Connection problems are available in terminal output and developer diagnostics.

## TidalCycles examples

This short eight-voice example makes the structure easy to read. Actual Codex output is longer, with gain and sustain specified per note. Instruments named `scc*` are defined in the project's [SuperCollider synths](native/synths.scd).

```haskell
setcps (128/60/4)

d1 $ s "bd:18*4"                                      # gain 0.8
d2 $ slow 2 $ midinote "45 ~ 45 48 ~ 52 48 ~" # s "sccbass"
d3 $ s "~ sn:35 ~ sn:35"                              # gain 0.65
d4 $ s "hh:3*8"                                      # gain 0.5
d5 $ s "~ perc:4 ~ ~ perc:4 ~ ~ ~"                    # pan 0.7
d6 $ slow 2 $ midinote "[57,60,64] ~ [57,60,64] ~" # s "sccpad"
d7 $ slow 2 $ midinote "69 ~ 72 ~ 76 72 ~ 67"     # s "sccbell"
d8 $ slow 2 $ midinote "81 ~"                    # s "scctexture"

-- Evaluate this line to stop all voices.
hush
```

In an external Tidal session, select only the lines you want to evaluate. Running the final `hush` with the patterns stops them immediately. This example does not schedule layer entries automatically; the app's native clock and entry gates provide the two-cycle intervals.

- [Short live coding example](examples/eight-voices.tidal)
- [Saved Codex score — Drum and bass / 165 BPM / A minor](examples/drum-and-bass.tidal)
- [Saved Codex score — Dub / 72 BPM / D dorian](examples/dub.tidal)

## From Huygens to a pressure field

Huygens' principle treats each point on a wavefront as a secondary source contributing to the next wavefront. **Choosing the eight corners as primary musical sources is an artistic decision.** The numerical implementation takes propagation as its starting point and solves a damped three-dimensional scalar wave equation. [Huygens' principle — OpenStax](https://openstax.org/books/university-physics-volume-3/pages/1-6-huygenss-principle)

$$
\frac{\partial^2 p}{\partial t^2}
+ \gamma\frac{\partial p}{\partial t}
= c^2\nabla^2p + s(\mathbf{x},t)
$$

- **Propagation:** finite differences on a 33 × 33 × 33 grid carry each disturbance to its neighbors. The time step follows the three-dimensional CFL stability condition.
- **Reflection:** Neumann conditions on all six faces set the pressure gradient normal to each boundary to zero.
- **Interference:** the eight sources contribute to one pressure field. Waves pass through one another, reinforcing or canceling; they do not bounce off each other as particles would.
- **Input:** analyzed waveforms and note onsets from each voice drive disturbances at its assigned corner.

The pressure grid becomes a 3D texture. The GPU integrates through the volume along the viewing direction to render a **translucent heatmap**. After subtracting the mean pressure, the sign and magnitude of the relative pressure determine color, while magnitude controls density and opacity. Front-to-back alpha compositing reveals depth. Choose Turbo, Plasma, Viridis, Icefire, or Spectral, and restrict the palette to a range of your choice.

Space and propagation speed use visual units chosen to make motion perceptible. This is not an acoustic analysis tool calibrated to room dimensions, physical sound speed, or decibels. Even in native mode, visualization input comes from browser analysis of the same score, not a direct recording of SuperCollider's output. See the [physics notes (Korean)](docs/physics.md) for these distinctions and the implementation equations.

## Artistic context

The direct starting points were the light rendering paper and Huygens' principle. The works and practices below offer **a context for interpreting and extending this project**.

| Reference | Connection |
| --- | --- |
| **Alvin Lucier — *I Am Sitting in a Room* (1969)** | Repeated playback and re-recording reveal a room's resonances. The cube similarly makes space itself an object through which to read sound. [MoMA's collection essay](https://www.moma.org/explore/inside_out/2015/01/20/collecting-alvin-luciers-i-am-sitting-in-a-room/) |
| **Iannis Xenakis / CEMAMu — UPIC** | Drawn lines become waveforms and musical control information. Visual form and physical gesture become inputs to performance. [Xenakis Association](https://www.iannis-xenakis.org/en/dictionary-upic/) |
| **Ryoji Ikeda — *datamatics*** | Invisible data becomes perceptible through sound and images. It offers a context for translating computed pressure into color and transparency. [Artist's website](https://www.ryojiikeda.com/project/datamatics/), [co-producer YCAM's documentation](https://special.ycam.jp/datamatics/dl/datamatics_release_en.pdf) |
| **TOPLAP / TidalCycles — live coding** | A performance culture that shows code alongside sound. The score at the bottom is another performance area, where the rules of the music unfold over time. [TOPLAP manifesto](https://toplap.org/wiki/ManifestoDraft), [TidalCycles](https://tidalcycles.org/) |
| **George E. Lewis — *Voyager*** | An improvisation system combining independent machine behavior with responses to human performers. Here, Codex proposes a score while a person chooses when to add hits and change direction. [Lewis, “Too Many Notes”](https://eamusic.dartmouth.edu/~larry/algoCompClass/readings/george%20lewis/lewis.too_many_notes.pdf) |

## Development and verification

```sh
npm run dev          # Development server + local bridge, port 5173
npm run dev:native   # Development with native Tidal/SuperDirt, port 5173
npm test
npm run build
```

Tests cover wave causality, superposition, cancellation, reflection, and numerical stability; score validation and Tidal rendering; genre repeat prevention and throw gestures; local API access restrictions, session ownership, and process cancellation; and stopping delayed audio starts, resumes, and sample requests.

| Location | Responsibility |
| --- | --- |
| [`src/main.ts`](src/main.ts) | Playback, stop, and transition state; interface coordination |
| [`src/audio/`](src/audio/) | Browser synthesis, samples, analysis, and manual hits |
| [`src/visual/`](src/visual/) | Wave grid, volume rendering, colormaps, and cube gestures |
| [`shared/`](shared/) | Genre profiles, note model, and safe Tidal code generation |
| [`server/`](server/) | Local Codex, session cancellation, and the Tidal/OSC bridge |
| [`native/`](native/) | Tidal startup, SuperDirt mixer, and synth definitions |
| [`scripts/`](scripts/) | Setup, diagnostics, login, and launch tools |

See the [runtime documentation (Korean)](docs/runtime.md) for detailed configuration, MIDI, and synchronization limits. Report reproducible problems through [Issues](https://github.com/TaewoooPark/Sound-Code-Cube/issues), including the execution mode and diagnostic results. Do not include account credentials or OAuth tokens.

## License and credits

Original code and documentation in this repository are released under the [MIT License](LICENSE). Three.js, TidalCycles, SuperCollider, SuperDirt, Codex CLI, IBM Plex Mono, and other dependencies retain their own licenses. **External audio engines and Dirt-Samples are not bundled in source releases**; setup commands download them separately from their upstream projects. Sample rights are not covered by this project's MIT license. See [third-party notices](THIRD_PARTY_NOTICES.md).

The cube images are captures of this app's renderer. The diagrams are original SVGs made to explain the project. Images from the referenced papers and artworks are not redistributed.
