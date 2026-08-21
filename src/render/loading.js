import { col2str } from '../screen.js';

/**
 * Load and error states drawn into the character grid itself.
 *
 * A DOM spinner over an ASCII renderer would look borrowed. This costs almost
 * nothing and keeps the whole surface in one idiom.
 */

/**
 * Every row is the same width on purpose. The rows are letterforms sliced
 * horizontally, so they only read as letters while their columns stay in step,
 * and the block below is positioned once for all four rows rather than each
 * row being centred on its own length.
 */
export const BANNER = [
  '   _   ___  ___ ___ ___    ___ ___ _______   __',
  '  /_\\ / __|/ __|_ _|_ _|  / __|_ _|_   _\\ \\ / /',
  ' / _ \\\\__ \\ (__ | | | |  | (__ | |  | |  \\ V / ',
  '/_/ \\_\\___/\\___|___|___|  \\___|___| |_|   |_|  ',
];

const BANNER_W = BANNER[0].length;

const SPIN = ['.  ', '.. ', '...', ' ..', '  .', '   '];

export function drawLoading(screen, { title, detail, t }) {
  const bright = col2str(126, 231, 255);
  const accent = col2str(255, 212, 121);
  // Bright enough to read as letters, dark enough not to compete with the
  // status line, which is the part that actually changes.
  const letters = col2str(58, 132, 152);

  screen.ctx.fillStyle = '#04080c';
  screen.ctx.fillRect(0, 0, screen.width, screen.height);
  screen.clear();

  const mid = Math.floor(screen.outRows / 2);

  // A faint grid of dots, so the frame does not read as a dead canvas.
  for (let y = 0; y < screen.outRows; y += 2) {
    for (let x = (y % 4 === 0) ? 0 : 3; x < screen.cols; x += 6) {
      screen.text(x, y, '.', col2str(10, 30, 38));
    }
  }

  // One offset for the whole block. Centring each row on its own length shears
  // the letters by a column wherever two rows differ in width.
  if (screen.cols >= BANNER_W + 4) {
    const x0 = Math.floor((screen.cols - BANNER_W) / 2);
    // Clear first, or a dot from the grid above lands in the gap between the
    // two words and reads as punctuation.
    screen.clearBox(x0, mid - 5, BANNER_W, BANNER.length);
    for (let i = 0; i < BANNER.length; i++) {
      screen.text(x0, mid - 5 + i, BANNER[i], letters);
    }
  }

  const dots = SPIN[Math.floor(t * 6) % SPIN.length];
  screen.centreText(mid + 1, `${title}${dots}`, bright);
  if (detail) screen.centreText(mid + 3, detail, accent);

  screen.blit();
}

export function drawError(screen, { title, detail, hint }) {
  const red = col2str(255, 138, 108);
  const dim = col2str(24, 88, 104);
  const accent = col2str(255, 212, 121);

  screen.ctx.fillStyle = '#0c0605';
  screen.ctx.fillRect(0, 0, screen.width, screen.height);
  screen.clear();

  const mid = Math.floor(screen.outRows / 2);
  const rule = '-'.repeat(Math.min(screen.cols - 4, 54));

  screen.centreText(mid - 3, rule, dim);
  screen.centreText(mid - 1, title, red);
  if (detail) screen.centreText(mid + 1, detail, accent);
  if (hint) screen.centreText(mid + 3, hint, dim);
  screen.centreText(mid + 5, rule, dim);

  screen.blit();
}
