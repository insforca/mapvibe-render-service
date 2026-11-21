# Picker font sources and implementation report

Partial implementation of mapvibe-context#21. Eight families are bundled; **Noto Sans JP is blocked** under the requested static-TTF-only rule. Do not consider the nine-font task complete.

All bundled files are unchanged upstream bytes from google/fonts commit `ebaa6a7aab9b700da4e30a4682687acdf427eae7` (historical snapshot). The historical snapshot deliberately supplies published static TTFs, avoiding variable-font instancing or new tooling. Each family's SIL OFL 1.1 licence is included. No subsetting, conversion or name-table edits. Registration aliases are runtime names only. The machine-readable `manifest.json` and the table below pin every font and licence; the offline hash test also checks byte counts, true OS/2 weights and absence of an fvar table. Existing `.gitattributes` `assets/fonts/** -text` covers this directory.

## Available weights and browser matching

| Stored picker value (case-insensitive) | Bundled weights | City / country / coordinates / credit face |
|---|---|---|
| Montserrat | 300, 400, 700 | 700 / 300 / 400 / 300 |
| Playfair Display | 400, 700 | 700 / 400 / 400 / 400 |
| Oswald | 300, 400, 700 | 700 / 300 / 400 / 300 |
| Source Sans Pro | 300, 400, 700 | 700 / 300 / 400 / 300 |
| Raleway | 300, 400, 700 | 700 / 300 / 400 / 300 |
| Lato | 300, 400, 700 | 700 / 300 / 400 / 300 |
| Merriweather | 300, 400, 700 | 700 / 300 / 400 / 300 |
| Bebas neue | 400 only | 400 / 400 / 400 / 400 |
| Noto Sans JP | blocked | Explicit warning, legacy Roboto fallback pending source decision |

The role's CSS request stays 700 / 300 / 400 / 300. Missing weights select the nearest supplied face using CSS matching for these sets. Playfair Display does not have a Light face; its country and credit select Regular. Bebas Neue has no Light or Bold: all roles select the original Regular file. Its 700 city request allows backend synthetic bold, as a browser's default `font-synthesis` does for a 400-only `@font-face` set. There is no fabricated 300/700 font file. Browser and Pango synthetic bold rasterization is not claimed to be pixel-identical; no browser was run in this task.

Every physical weight has its own `MapVibe Picker <stem> <weight>` alias so canvas cannot collapse Light into Regular. Real canvas measurements compare each weight's per-glyph advances against independently decoded cmap/hmtx values in the pinned TTF. Legacy Roboto and Space/Plex remain registered first. A nonblank unknown picker also keeps the legacy layout and explicitly uses Roboto; values are never interpolated into a CSS family string. Unknown and blocked values warn without echoing arbitrary input.

## Noto Sans JP blocker and options

No static TTF instance was found in the official sources inspected. Work on this family stopped without downloading a variable file, generating instances or adding Python tooling.

* [Google Fonts pinned tree](https://github.com/google/fonts/tree/06bfe0d62a98375cb09c942fa18e68bd32cff057/ofl/notosansjp): `NotoSansJP[wght].ttf` is variable-only, **9,589,900 bytes**. Using it would relax the static requirement and require separate evidence that canvas can select each weight.
* [Official Noto CJK pinned tree](https://github.com/notofonts/noto-cjk/tree/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans): the JP subset variable TTF is **9,590,732 bytes**. Static JP subset fonts are OTF: Light **4,513,968**, Regular **4,533,028**, Bold **4,656,448**; total **13,703,444 bytes** (13.07 MiB), plus licence. Allowing original static OTFs is the smallest straightforward source-format exception and still needs canvas registration/weight tests.
* [Official Sans 2.004 release](https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004) publishes static OTFs and variable TTFs; its `02_NotoSansCJK-TTF-VF.zip` is **277,113,645 bytes compressed** and is not a static-TTF release. `16_NotoSansJP.zip` is **27,139,567 bytes compressed**, containing the JP OTF distribution.
* Generating static TTFs from a pinned official variable TTF requires an approved conversion/instancing workflow, provenance and licence review, and new fingerprints. Resulting sizes are not known without producing the files. This task expressly excludes adding Python tooling.

Noto Sans JP adds **0 bytes** to this change's image. It is intentionally not listed as a supported bundled family.

## Docker size

Docker already copies `assets/`; no font download is performed at build or print time. Added TTF payload: **5,245,168 bytes**. Added licences: **35,516 bytes**. Font + licence payload: **5,280,684 bytes** (5.04 MiB). Documentation and manifest are included in the directory total reported in the final handoff. These are uncompressed file payloads, not a measured compressed Docker layer; no image was built or deployed.

## Verification and scope

Before the implementation, three offline regression tests failed against the actual server font/startup and tiled function bodies in isolated fresh VM contexts: the picker/unknown paths performed four mocked HTTP calls; a three-weight CSS fixture registered just the first 300 URL without a weight; and a fresh tiled render stripped the overlay from its tiles and reached the final draw without any picker registration. No real HTTP or server route was involved. Startup registration now makes all supported faces available before either render path. Missing or invalid bundled files fail startup rather than silently shipping fallback. The same tests pass with downloads removed. No other source caller depends on the removed font downloader (only the two local ensureFont calls in the single-render preparation path).

Tests use the project's existing canvas dependency, with a fresh child process and Fontconfig on Windows just like `lockup-fonts.test.ts`. They need no new install scripts or dependencies; CI can continue `npm install --ignore-scripts` and `npm rebuild canvas`. The tiled test uses real server code with GL, stitching and final drawing replaced by local adapters; it checks registration at the instant of the post-stitch draw. Native glyph tests separately prove all role aliases resolve to the intended file. No production render, fulfillment, vendor, order, browser or deployment was used.

Studio parity remains out of scope: its @fontsource WOFF2 files are different bytes and potentially different versions/subsets. To serve the same files, copy these exact pinned TTFs and licences into the studio's static assets, replace its font imports with local `@font-face` declarations for the available weights, map Playfair/Bebas missing weights consistently (including font-synthesis policy), and verify hashes and visual/advance parity. Resolve Noto's source-format blocker first. Both applications should share one versioned asset manifest to prevent later drift.

Full validation: `npx tsc --noEmit` passes. The full Vitest run has 270 passing tests and two failures in the unchanged catalogue tests because this sandbox rejects spawning `python3` with `EACCES` (the tests then concatenate null streams). No Python tooling was installed or changed. All font, tiled-path, hash, role and legacy-lockup tests pass.

## Pinned files

| File | Source URL | Bytes | SHA-256 |
|---|---|---:|---|
| Montserrat-Bold.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/montserrat/Montserrat-Bold.ttf | 261588 | c4c8cb572a5a2c43d78b3701f4b2349684e6ca4d1557e469af6065b1e099c26c |
| Montserrat-Light.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/montserrat/Montserrat-Light.ttf | 259416 | 9b87925d061b1affb66417717731ad781f7d7678fb089b49f14bd922c2338559 |
| Montserrat-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/montserrat/Montserrat-Regular.ttf | 263192 | 81ebc3916b524007b756d91d9df13c7673ec401161f2cad161662d08dcf1cc72 |
| montserrat-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/montserrat/OFL.txt | 4392 | 41f82bb4d24b304f30f7136bc47abdd083782e4265c984160f5649d1e78ea49c |
| playfairdisplay-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/playfairdisplay/OFL.txt | 4450 | f5b03ea0b27c7f5afb9702771ee57679ae8ba6b471b6ba9e62d985d3256f1929 |
| PlayfairDisplay-Bold.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/playfairdisplay/static/PlayfairDisplay-Bold.ttf | 213592 | 37fcc00a7503976693088bed271e64ce34fca5119181da9acf5b74bd59da8c7e |
| PlayfairDisplay-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/playfairdisplay/static/PlayfairDisplay-Regular.ttf | 210208 | 844b4c3b02e307318abb61d8ebd55bfb8e19304515075fd8af06af099480191e |
| oswald-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/oswald/OFL.txt | 4482 | ae05f8781a5ef38380ef3efe8cad86783610b6a780c6c278d7472f95310fccee |
| Oswald-Bold.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/oswald/static/Oswald-Bold.ttf | 94272 | 0cde70ba3b3398ab0bc19be74c7517442ef711846d33f286d7932fef9784e2d8 |
| Oswald-Light.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/oswald/static/Oswald-Light.ttf | 91664 | 292165793dab020fbe32fc3741d912b7fdc23e13c19c45451ea591f7ddfc7732 |
| Oswald-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/oswald/static/Oswald-Regular.ttf | 93132 | 43b55a174fb3f5a1e6218a5385f647d2eace04776ab58673f4a439381930006e |
| sourcesanspro-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/sourcesanspro/OFL.txt | 4514 | fce9f9e2fb268507a89fceea0b3eccc044f39fc3492968a04fd9e04df5ae95fa |
| SourceSansPro-Bold.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/sourcesanspro/SourceSansPro-Bold.ttf | 290916 | da4f442e66843990825ed4757e27ad3442cad83f9844cc503e8ece85e00f77f2 |
| SourceSansPro-Light.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/sourcesanspro/SourceSansPro-Light.ttf | 292680 | 5705ecafdaa64d8af74d0c03f89272a65cfee9f7e62b55016a8dcbe4a69b6f86 |
| SourceSansPro-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/sourcesanspro/SourceSansPro-Regular.ttf | 293516 | 71d10a86b4c54a5a9c0c8b467e53ac67d79edb96c956e4e9f65a7074dfb9992a |
| raleway-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/raleway/OFL.txt | 4497 | 7e946cf1171784d1015279e7dc35f827957a6b5d1f1f659ae0c98e5f5e37ed9b |
| Raleway-Bold.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/raleway/static/Raleway-Bold.ttf | 137952 | 6894481ab1c298e9c66f23455ecf05ccb25393d719a6b2d63428358c0409d2d0 |
| Raleway-Light.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/raleway/static/Raleway-Light.ttf | 132244 | 02fdd3ead5a2927391ec2dfc2dcd3ab5b6fc6d33698e24c43b46cdcb88870c70 |
| Raleway-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/raleway/static/Raleway-Regular.ttf | 132000 | cb70f8815eecd850263d54fa59286377b1d7362bec612e981155a00039d8b513 |
| Lato-Bold.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/lato/Lato-Bold.ttf | 656544 | 8a0aace75d33794eece4b28187bfc1df0bbd2888b5d8a56e01788c8d65d16be1 |
| Lato-Light.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/lato/Lato-Light.ttf | 643884 | cf2a774503baf418d584f49967bd160e1e03f087c13b25602f28024ec7788f08 |
| Lato-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/lato/Lato-Regular.ttf | 656568 | d636e4683231f931eda222d588e944d082bfd3bdba02f928bee461c0f185b251 |
| lato-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/lato/OFL.txt | 4407 | 74ba064d03f1f1c4a952da936c3eb71866c34404916734de3cae73b34357e59e |
| Merriweather-Bold.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/merriweather/Merriweather-Bold.ttf | 149112 | 55139769a87085bff777f68e3ecf92450c21a04c5ddd1e9e9528960ba4088c9f |
| Merriweather-Light.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/merriweather/Merriweather-Light.ttf | 155192 | d3ecc46bab128ed073ad9189bd7efdd2df455d8942ec056f14129bf35bcea7e5 |
| Merriweather-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/merriweather/Merriweather-Regular.ttf | 156096 | bc38fe756b3e259248183fc0b75ad81b02774f3ca68e5e544e925827b0186d40 |
| merriweather-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/merriweather/OFL.txt | 4437 | a7ba785ad99b6eae0444ab89910e512d4af9865937fddbcb5c72c4f59f55d6ad |
| BebasNeue-Regular.ttf | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/bebasneue/BebasNeue-Regular.ttf | 61400 | 08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73 |
| bebasneue-OFL.txt | https://raw.githubusercontent.com/google/fonts/ebaa6a7aab9b700da4e30a4682687acdf427eae7/ofl/bebasneue/OFL.txt | 4337 | 72082f6cb4d04be2ecf7cc7d9e1e7d73787f0af8a5a278a47cade70c16b78341 |
