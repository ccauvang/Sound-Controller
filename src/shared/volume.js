// 79 steps: 0-10 by 1, 15-100 by 5, 110-600 by 10 - slider works on index, not on percent
export const VOLUME_STEPS = [
  ...Array.from({ length: 11 }, (_, i) => i),
  ...Array.from({ length: 18 }, (_, i) => 15 + i * 5),
  ...Array.from({ length: 50 }, (_, i) => 110 + i * 10)
];
export const VOLUME_DEFAULT = 100;

export const indexOfVolume = (v) =>
  VOLUME_STEPS.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(VOLUME_STEPS[best] - v) ? i : best), 0);