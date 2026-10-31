// Fonts bundled with the app (all OFL or Apache-2.0, see LICENSES.md) and caption style presets.
export const FONTS = [['Montserrat', 'Montserrat Black', 800], ['Anton', 'Anton', 400], ['Bebas Neue', 'Bebas Neue', 400], ['Poppins', 'Poppins Bold', 800], ['Inter', 'Inter', 700], ['Permanent Marker', 'Marker', 400]];
export const CAPTION_PRESETS = [
  { id: 'preset-bold', name: 'Bold pop', preset: true, madeBy: 'bot', style: { font: 'Montserrat', weight: 800, size: 72, color: '#ffffff', outline: '#000000', outlineW: 6, bg: '', y: 0.66, upper: true, highlight: true, hiColor: '#ffd43b', hiPop: true } },
  { id: 'preset-clean', name: 'Clean box', preset: true, madeBy: 'bot', style: { font: 'Inter', weight: 700, size: 58, color: '#ffffff', outline: '#000000', outlineW: 0, bg: '#000000b3', y: 0.7, upper: false, highlight: false, hiColor: '#4dabf7', hiPop: false } },
  { id: 'preset-tall', name: 'Tall', preset: true, madeBy: 'bot', style: { font: 'Anton', weight: 400, size: 84, color: '#ffffff', outline: '#000000', outlineW: 5, bg: '', y: 0.62, upper: true, highlight: true, hiColor: '#69db7c', hiPop: false } },
  { id: 'preset-marker', name: 'Marker', preset: true, madeBy: 'bot', style: { font: 'Permanent Marker', weight: 400, size: 70, color: '#fff3bf', outline: '#000000', outlineW: 5, bg: '', y: 0.68, upper: false, highlight: true, hiColor: '#ff6b9d', hiPop: true } },
];
export const TEXT_PRESETS = [
  { name: 'Title', style: { font: 'Anton', weight: 400, size: 120, color: '#ffffff', stroke: '#000000', strokeW: 5, shadow: true, bg: '' } },
  { name: 'Label', style: { font: 'Inter', weight: 700, size: 64, color: '#111111', stroke: '#000000', strokeW: 0, shadow: false, bg: '#ffffffee' } },
  { name: 'Bold', style: { font: 'Montserrat', weight: 800, size: 90, color: '#ffd43b', stroke: '#000000', strokeW: 6, shadow: true, bg: '' } },
  { name: 'Hand', style: { font: 'Permanent Marker', weight: 400, size: 88, color: '#ffffff', stroke: '#000000', strokeW: 3, shadow: true, bg: '' } },
];
