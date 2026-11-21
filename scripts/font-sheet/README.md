# Font comparison sheet

From the repository root:

```powershell
npm ci --prefix scripts/font-sheet --cache scripts/font-sheet/.npm-cache
node scripts/font-sheet/build.mjs
node scripts/font-sheet/verify.mjs
node scripts/font-sheet/review.mjs
```

Open `out/sheet.html`. All images and complete licence texts are embedded. The main table has four options and Chrome / print / difference columns. An expandable second table contains Edge. Per-browser images, differences, native DOM diagnostics, exact file sizes, SHA-256s, glyph coverage, font metadata and layout measurements are in `out/`. Output, dependencies and npm cache are ignored locally.

The build runs offline. Only the optional `prepare-fonts.mjs` downloads fonts/licences from upstream GitHub repositories; it records commit-pinned URLs and hashes in `fonts/SOURCES.md`. Checked-in Roboto, Playfair Display and DM Sans files are used unmodified. `prepare-fonts.mjs` is not required to rebuild this sheet.

Browser runs are sequential: each option launches Chrome, closes it in a `finally` block, then launches and closes Edge if installed. At most one browser is alive at a time, including on a failed comparison.

The print harness transpiles only `src/poster-text.ts` and its pure `print-parity.ts` dependency into `out/`, then calls the exported `drawPosterText` on node-canvas. No server module is loaded. A deterministic schematic raster is shared by both renderers. Attribution drawn unconditionally by the service is mirrored in the browser; the fixture itself contains no geographic data. The browser uses native HTML/CSS flow, scaled desktop margins and padding, 1.15 line-height, 0.45em title spacing, role weights 700/300/400 and the service's independent font-size/fitting rules. Chrome and Edge use device scale 1 and sRGB. HTTP requests from the test pages are blocked and fail the build.

On Windows, canvas's default Win32 Pango backend silently fell back despite successful `registerFont`. The build starts a child with the bundled Fontconfig/FreeType backend configured before DLL loading, using only local font directories and an ignored cache. This resembles the Linux service backend, but is not a test of its deployed binary. Twelve hmtx fingerprints assert that each role resolves to the intended file's metrics. Files shared by roles are registered once: canvas replaces registrations with identical native descriptions. A context adapter routes the source's font shorthand to separate face aliases while preserving its measurement and drawing calls. These workarounds are confined to this directory.

## Measured run

900 × 1200 px. Chrome 157.0.8103.79; Edge 158.0.4370.33. Edge gave identical scores to Chrome for every option. Raw RGB changed pixels count any nonzero difference; MAE is on 0–255. Identical background dilutes whole-image percentages, so the bottom text ROI (y=1003 through 1199, including attribution) is also measured. Diff images amplify RGB absolute differences 4×.

| Option | Changed pixels | RGB MAE | Text ROI changed / MAE | Unique font bytes |
|---|---:|---:|---:|---:|
| Roboto | 0.7118% | 0.686968 | 4.3356% / 4.1846 | 1,547,920 |
| Space Grotesk + IBM Plex Mono | 0.6653% | 0.588085 | 4.0525% / 3.5822 | 386,852 |
| Montserrat | 0.6289% | 0.479917 | 3.8308% / 2.9234 | 1,345,148 |
| Playfair Display + DM Sans | 1.0527% | 1.361238 | 6.4123% / 8.2918 | 435,092 |

Advance widths below exclude letter spacing. The JSON also includes CSS inline widths (including the trailing city gap), the service layout widths, and native DOM widths. They differ because measuring a kerned whole string is not equivalent to painting individually spaced glyphs.

| Option | City browser / print px | Country browser / print px |
|---|---:|---:|
| Roboto | 309.769 / 309.769 | 164.505 / 164.499 |
| Space Grotesk + IBM Plex Mono | 306.429 / 305.428 | 179.010 / 179.004 |
| Montserrat | 367.265 / 367.263 | 180.272 / 180.272 |
| Playfair Display + DM Sans | 332.537 / 329.413 | 158.285 / 160.559 |

Visual inspection of the rendered text crops shows:

- **Roboto:** very close horizontal extent; a small vertical shift, thinner/crisper browser body strokes and antialiasing differences remain. Existing files and embedded metadata say **Apache 2.0**, despite the task's initial OFL assumption.
- **Space/Plex:** comparable overall placement with small vertical and glyph-edge differences; the monospaced coordinates visibly occupy more width. Title advance differs about 1px. All three files are SIL OFL 1.1.
- **Montserrat:** closest measured pair in this fixture, with almost equal advances; small baseline/stroke and divider rasterization differences remain. All three files are SIL OFL 1.1.
- **Playfair/DM:** the strongest doubled title contours in the diff, uneven horizontal title drift, and visibly different body width/strokes. The checked-in DM Sans file is a variable font (opsz 9–40, default 9; wght 100–1000, default 400); the native/browser axis selection is not pinned by the production code. No Light file was downloaded or synthesized by this harness. Both families are SIL OFL 1.1. Only Bold Playfair is needed for the title; its unused existing Regular file is also hashed in SOURCES.md.

Every selected face contains all glyphs for **São Paulo, Zürich, Kraków and Reykjavík**, both as written and uppercase, checked directly against the font cmap. This is a glyph-presence check, not a claim about all languages, combining sequences, or accent layout at other sizes. File sizes above count unique files actually rendered; per-file sizes and hashes are in SOURCES.md and metrics.json. Browser and print refer to exactly those same files, without conversion or subsetting.

## Production changes needed (not made)

`src/poster-text.ts` already accepts a single `fontFamily`, so Roboto and Montserrat require no family API change. Production must register and serve their exact 700/300/400 files locally, keeping Light distinct where necessary. The service's other font-fetching path must not substitute a newly downloaded version.

For the mixed pairs, change `drawPosterText`'s single family input and the `titleFamily` / `lightFamily` construction to separate **city, country and coordinates** font specs. Coordinates currently use `titleFamily`, so adding only a body family for country is insufficient. Feed the same role specs into both `layoutPosterText`'s glyph callback and the three drawing assignments, with explicit role weights and exact local files. The script's alias/context adapter is a comparison-only substitute for that change.

For all families, replace the Roboto-only `ROBOTO_HHEA_ASCENT`, `ROBOTO_HHEA_LINE` and global `CSS_BASELINE_EM` assumption with per-face baseline metrics matching browser font selection (including applicable OS/2 metrics). `baselineY` must use the role's metrics, not a shared constant. Account for CSS subpixel box rounding. In `drawSpaced`, centering uses whole-string width while painting advances one glyph at a time; make measuring, shaping/kerning and letter-spacing agree with the editor. For DM Sans, pin matching optical-size and weight instances on both sides, or create identical static instances for both consumers in a future production change. Even after layout alignment, Cairo/FreeType and browser rasterization may not produce identical pixels.

At this test size, Chromium snaps the scaled divider border from 1.866px to 1px while Cairo draws the fractional stroke. Together with line-box rounding this puts the browser strip top about 0.94px below the service layout; this is measured, not compensated away in the images.

**Recommendation:** Montserrat is the best starting point for Ivan's single universal family: it covers all requested accents, uses OFL, needs no mixed-family API, and has the lowest error and nearly identical advances in this run. Self-host the exact three static files and fix baseline/spacing parity before adopting it. Space/Plex is the smallest download if Ivan prefers that two-family look. Sharing bytes alone does not guarantee pixel identity across every browser or platform; this sheet verifies the installed Windows Chrome/Edge against local node-canvas. Ivan makes the final choice.
