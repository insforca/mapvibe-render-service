# Picker font sources and implementation report

All nine picker families are bundled offline. Ivan's 2026-11-21 option A decision for render PR #104 permits official static CFF OTFs for Noto Sans JP 300/400/700 alongside the existing static TTFs.

The original eight families are unchanged upstream bytes from google/fonts commit `ebaa6a7aab9b700da4e30a4682687acdf427eae7`. Noto Sans JP is from the official notofonts/noto-cjk commit `f8d157532fbfaeda587e826d4cd5b21a49186f7c`, under `Sans/SubsetOTF/JP/`; its SIL OFL 1.1 licence is the original `Sans/LICENSE`. Every font and licence is pinned by URL, bytes and SHA-256 in the table and `manifest.json`. No conversion, subsetting, variable-font instancing or name-table edits were performed. Registration aliases are runtime names only. Existing `.gitattributes` `assets/fonts/** -text` covers all these files.

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
| Noto Sans JP | 300, 400, 700 (OTF) | 700 / 300 / 400 / 300 |

The role's CSS request stays 700 / 300 / 400 / 300. Missing weights select the supplied Regular face for these sets. Bebas Neue's 700 city request allows backend synthetic bold, as a browser's default font-synthesis does for a 400-only set. No fabricated weight files are bundled. Every physical weight has its own `MapVibe Picker <stem> <weight>` alias. Unknown nonblank picker values warn and explicitly use legacy Roboto without interpolating user input into a CSS family string. Legacy Roboto and Space/Plex remain registered first. All picker faces register at startup before single or tiled text rendering; runtime font downloads are removed. Missing or invalid files fail startup.

## Native CFF verification and platform limits

The offline hash test covers all 24 fonts and nine licences, verifies real OS/2 weights and absence of fvar, and additionally verifies OTTO signature, CFF table presence and absence of glyf for all three Noto OTFs. A fresh node-canvas process measures individual glyphs at 100px and compares them with independently decoded cmap/hmtx advances from each original SFNT, within 0.02px. All weights must also have distinguishable advance fingerprints. Noto includes Latin and Japanese characters (Tokyo, Japanese-language kanji, hiragana and katakana), so Japanese coverage is exercised as well as the weight-dependent Latin metrics. Role capture checks city/country/coordinates/credits use the corresponding aliases.

On this Windows checkout, node-canvas 3.2.3 successfully registers and uses all three original OTFs with `PANGOCAIRO_BACKEND=fc` and an isolated Fontconfig configuration, matching the existing native font test setup. At 100px, the Japanese sample's alpha-summed raster densities are Light **14,277.84**, Regular **21,514.78**, Bold **33,148.27**; Bold/Light is **2.32**, above the test's 1.4 threshold. This verifies actual weight use, beyond successful registration. The default Windows Pango backend was not certified by this check.

Local `node_modules/canvas/src/register_font.cc` confirms that Linux uses FreeType `FT_New_Face` for font parsing and `FcConfigAppFontAddFile` for registration, whereas Windows uses `AddFontResourceExW`. There is no TTF-extension restriction in that path. The Docker image supplies Pango/FreeType/Fontconfig through its native dependencies, so no Windows-specific OTF blocker is indicated; the successful Windows Fontconfig rendering also supports compatibility. This is source inspection and backend evidence, not a Linux runtime result. Docker is unavailable here and WSL reports `WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED`; no Linux image was built or run. The same native test runs without the Windows environment override on Linux.

## Image payload, memory and startup

Noto OTFs add **13,703,444 bytes** (13.70 MB / 13.07 MiB). Its licence adds **4,301 bytes**, for **13,707,745 bytes** of additional font/licence image payload. Total picker font bytes are **18,948,612** (18.95 MB / 18.07 MiB), plus **39,817 bytes** of licences: **18,988,429 bytes** combined. Docker already copies assets; documentation and manifest add a small further amount. These are uncompressed payload sizes, not a measured compressed layer size.

The additional 13.7 MB of font files are registered once at startup. File bytes do not translate directly into resident memory: native font data, mapping, Fontconfig caches and later glyph raster caches have separate costs. One fresh local Windows/Fontconfig observation, registering all existing faces first, measured the three additional registerFont calls at **68.16 / 68.59 / 68.14 ms**, about **205 ms** combined, and an aggregate RSS increase of **1,630,208 bytes** (1.55 MiB) across those calls. This is a single environment-specific observation, not a production benchmark or an upper bound on later rendering memory. No lazy loading or per-request registration was introduced.

## Validation and scope

`npx tsc --noEmit` passes. The whole Vitest suite runs **272 tests: 270 pass, two fail** in unchanged catalogue tests because `spawnSync('python3')` returns `EACCES` with null output streams; their string assertions then receive a number. All picker hash, native glyph/raster, role, startup/tiled and legacy lockup checks pass. No Python tooling or dependencies were added. Native checks use the existing canvas dependency and fresh-process Fontconfig setup.

Only official font/licence downloads used network access. No production, vendor, order/cart/checkout, browser, deployment, push or merge action was performed. Studio parity remains separate work: copy these exact pinned TTF/OTF bytes and licences to the editor, use matching local font-face weights and missing-weight/synthesis rules, and verify browser parity. Its existing WOFF2 bytes are not claimed to match. Both applications should share one versioned manifest to avoid drift.

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
| NotoSansJP-Light.otf | https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/JP/NotoSansJP-Light.otf | 4513968 | e358dcfa7970805300a953bb71209c3efcbcc17a00a5e4101f8cf94a3870ad93 |
| NotoSansJP-Regular.otf | https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/JP/NotoSansJP-Regular.otf | 4533028 | dff723ba59d57d136764a04b9b2d03205544f7cd785a711442d6d2d085ac5073 |
| NotoSansJP-Bold.otf | https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/SubsetOTF/JP/NotoSansJP-Bold.otf | 4656448 | 1b0edfb500b73a4fa8a4fcaae1bbbd403994e08e73e3e0da37e70d3853f42c5f |
| notosansjp-OFL.txt | https://raw.githubusercontent.com/notofonts/noto-cjk/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE | 4301 | 6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2 |
