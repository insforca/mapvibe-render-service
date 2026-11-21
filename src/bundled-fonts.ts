/** Exact family aliases shared by startup registration and offline canvas tests. */
export const BUNDLED_FONTS = [
    // Plex Light already has a distinct name-table family; no byte edits needed.
    { family: 'Space Grotesk', weight: '700', staticFile: 'SpaceGrotesk-Bold.ttf', variableFile: 'SpaceGrotesk-Bold.ttf' },
    { family: 'IBM Plex Mono Light', weight: '300', staticFile: 'IBMPlexMono-Light.ttf', variableFile: 'IBMPlexMono-Light.ttf' },
    { family: 'IBM Plex Mono', weight: '400', staticFile: 'IBMPlexMono-Regular.ttf', variableFile: 'IBMPlexMono-Regular.ttf' },
    { family: 'Roboto Light', weight: '300', staticFile: 'Roboto-Light.ttf',    variableFile: 'Roboto-Light.ttf' },
    { family: 'Roboto',       weight: '400', staticFile: 'Roboto-Regular.ttf',  variableFile: 'Roboto-Regular.ttf' },
    { family: 'Roboto',       weight: '700', staticFile: 'Roboto-Bold.ttf',     variableFile: 'Roboto-Bold.ttf' },
  ];
