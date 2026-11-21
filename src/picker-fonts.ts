/** Offline picker catalogue. See assets/fonts/picker/SOURCES.md for provenance and omissions. */
const catalogue = [
  ['Montserrat', 'Montserrat', [300, 400, 700]],
  ['Playfair Display', 'PlayfairDisplay', [400, 700]],
  ['Oswald', 'Oswald', [300, 400, 700]],
  ['Source Sans Pro', 'SourceSansPro', [300, 400, 700]],
  ['Raleway', 'Raleway', [300, 400, 700]],
  ['Lato', 'Lato', [300, 400, 700]],
  ['Merriweather', 'Merriweather', [300, 400, 700]],
  ['Bebas neue', 'BebasNeue', [400]],
] as const;

export const PICKER_FONTS = catalogue.map(([value, stem, weights]) => ({
  value,
  faces: weights.map(weight => ({
    family: `MapVibe Picker ${stem} ${weight}`,
    weight: String(weight),
    staticFile: `picker/${stem}-${weight === 300 ? 'Light' : weight === 700 ? 'Bold' : 'Regular'}.ttf`,
    variableFile: `picker/${stem}-${weight === 300 ? 'Light' : weight === 700 ? 'Bold' : 'Regular'}.ttf`,
  })),
}));

export function resolvePickerFont(value: string) {
  const name = (value || '').trim();
  const font = PICKER_FONTS.find(f => f.value.toLowerCase() === name.toLowerCase());
  if (!font && name && name.toLowerCase() !== 'roboto') {
    console.warn(name.toLowerCase() === 'noto sans jp'
      ? '[fonts] Noto Sans JP is blocked pending a static TTF source; falling back to Roboto'
      : '[fonts] Unknown picker family; falling back to Roboto');
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
