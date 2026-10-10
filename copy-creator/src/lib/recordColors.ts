/** Legacy gray means automatic; custom saved colors retain their exact value. */
export const recordTones = ["#598c7b", "#7486b5", "#b58b51", "#af7590", "#5d96ad", "#a17caf", "#b77663", "#879954"];
export function recordGroupColor(id: string, color: string): string {
  if (color.toLowerCase() !== "#8e8e93") return color;
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = (hash ^ (hash >>> 16)) >>> 0;
  // Stable across sorting, filtering and reloads; many hues for legacy groups.
  const hue = hash % 360;
  const channel = (offset: number) => {
    const k = (offset + hue / 30) % 12;
    return Math.round(255 * (.54 - .22 * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
