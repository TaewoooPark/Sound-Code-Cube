# Third-party software and references

The root MIT license covers Sound Code Cube's original application code,
documentation, diagrams, and application screenshots. Dependencies, external
audio engines, fonts, and samples retain their own licenses and attribution.

## Installed JavaScript dependencies

`npm ci` installs the versions recorded in `package-lock.json`, together with
their upstream license files. The principal runtime dependencies are:

| Component | License | Source |
| --- | --- | --- |
| Three.js | MIT | https://github.com/mrdoob/three |
| Express | MIT | https://github.com/expressjs/express |
| IBM Plex Mono font | SIL Open Font License 1.1 | https://github.com/IBM/plex |
| Fontsource packaging | MIT; font remains OFL-1.1 | https://github.com/fontsource/fontsource |

The IBM font copyright and complete OFL text are included in
[public/licenses/IBM-Plex-Mono-OFL.txt](public/licenses/IBM-Plex-Mono-OFL.txt),
which Vite also copies into the built application.

The palette names Turbo, Plasma, Viridis, Icefire, and Spectral acknowledge
established scientific color-map families. This application uses compact,
interpolated color-stop approximations with an additional genre hue transform;
they are not exact copies of the full reference lookup tables.

## External programs and samples

These are separate local installations or downloads, not bundled in this
repository or its source release:

- [OpenAI Codex CLI](https://github.com/openai/codex): Apache-2.0 software;
  access to OpenAI services uses each user's own account and applicable terms.
- [TidalCycles](https://github.com/tidalcycles/Tidal): see its upstream license.
- [SuperCollider](https://github.com/supercollider/supercollider): see its
  upstream license and component notices.
- [SuperDirt](https://github.com/musikinformatik/SuperDirt): GNU GPL license
  supplied by the upstream project.
- [Vowel](https://github.com/supercollider-quarks/Vowel): GNU LGPL license
  supplied by the upstream project.
- [Dirt-Samples](https://github.com/tidalcycles/Dirt-Samples): downloaded
  separately into `.runtime/Dirt-Samples`. Sound Code Cube does not relicense
  these samples or claim a blanket license for the collection. Consult the
  upstream project and the relevant sample provenance before redistributing
  samples or using them in a separately distributed asset pack.

The setup commands preserve the downloaded repositories and their notices.
`.runtime/`, credentials, and downloaded sample files are excluded from Git
and release packaging. No third-party music recordings or artwork are used
as README illustrations; the gallery shows this application's own rendering.

## Research and artistic context

Research papers and artworks linked in the README are credited as references.
The mitransient paper supplied the project's initial conceptual stimulus;
mitransient itself is not a dependency. The other artistic connections are
interpretive context, not claims of collaboration or endorsement. Their
original images, scores, recordings, and texts are not redistributed here.
