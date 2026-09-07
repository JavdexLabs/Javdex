# NFO compatibility fixtures

All files in this directory are synthetic, minimal fixtures created for Javdex. They contain no copied movie descriptions or third-party artwork.

`third-party/` captures the field shapes accepted from the following research snapshots. Tool names identify dialect families, not bundled code or a runtime dependency:

- Movie_Data_Capture: commit `6bad088683265d36fb1109b67a4df2bf1deb9d39`; `num`, `maker`, `label`, release date, runtime, plot and scalar/structured rating precedence.
- MDCx: commit `58e3f930f2e864fceb8a53ceef818716e2a6413d`; precise sidecar lookup plus `publisher`, `series`, `originalplot` and local poster fallbacks.
- Javinizer: commit `0c1cc4127f23d624e22baffa6aee7b0350f439bb`; `id`, scalar `set`, actors, `folder.*`, `fanart.*`, `.actors/` and `extrafanart/` conventions.
- JavSP: commit `c4cfe61188234dd24c75b53b42b054327fef3e58`; `uniqueid[type=num]`, structured `set/name`, `premiered`, `studio`, `movie.nfo`, poster and fanart conventions.

The baseline was recorded on 2026-09-05. Compatibility means that the synthetic shapes and file conventions listed above pass Javdex contract tests; it is not a promise to follow arbitrary future versions or to preserve unknown tags losslessly.

`javdex-roundtrip/` contains canonical UTF-8/LF interchange documents emitted by `renderNfoArtifact`. The five fixtures isolate metadata, people/collections, artwork references, ratings, and XML escaping. Tests require parse → render → parse stability and byte-stable repeated rendering.

Only local relative image names are present. The fixtures intentionally omit real media, remote images, and third-party prose.
