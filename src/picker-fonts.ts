/** Offline picker catalogue. See assets/fonts/picker/SOURCES.md for provenance. */
const catalogue = [
  ['Montserrat', 'Montserrat', [300, 400, 700], 'ttf'],
  ['Playfair Display', 'PlayfairDisplay', [400, 700], 'ttf'],
  ['Oswald', 'Oswald', [300, 400, 700], 'ttf'],
  ['Source Sans Pro', 'SourceSansPro', [300, 400, 700], 'ttf'],
  ['Raleway', 'Raleway', [300, 400, 700], 'ttf'],
  ['Lato', 'Lato', [300, 400, 700], 'ttf'],
  ['Merriweather', 'Merriweather', [300, 400, 700], 'ttf'],
  ['Noto Sans JP', 'NotoSansJP', [300, 400, 700], 'otf'],
  ['Bebas neue', 'BebasNeue', [400], 'ttf'],
] as const;

export const PICKER_FONTS = catalogue.map(([value, stem, weights, extension]) => ({
  value,
  faces: weights.map(weight => {
    const file = `picker/${stem}-${weight === 300 ? 'Light' : weight === 700 ? 'Bold' : 'Regular'}.${extension}`;
    return {
      family: `MapVibe Picker ${stem} ${weight}`,
      weight: String(weight),
      staticFile: file,
      variableFile: file,
    };
  }),
}));

export function resolvePickerFont(value: string) {
  const name = (value || '').trim();
  const font = PICKER_FONTS.find(f => f.value.toLowerCase() === name.toLowerCase());
  if (!font && name && name.toLowerCase() !== 'roboto') {
    console.warn('[fonts] Unknown picker family; falling back to Roboto');
  }
  return font;
}

/** CSS Fonts weight matching for the supplied sets: 300 -> 400 if no Light;
 * 700 -> 400 for the single-face Bebas set. Preserve requested CSS weights so
 * the backend may synthesize bold as a browser does for a 400-only @font-face.
 */
export function pickerFamily(font: (typeof PICKER_FONTS)[number], weight: number): string {
  const face = font.faces.find(f => Number(f.weight) === weight) ?? font.faces.find(f => f.weight === '400')!;
  return `"${face.family}"`;
}
