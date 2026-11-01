/** Tiny demo game: a 5x3 board where three or more matching symbols from the left on a row win. */
export const COLS = 5;
export const ROWS = 3;
export const CELL = 150;

export const SYMBOLS = {
  ruby: { key: 'gem', tint: 0xffffff, size: 1.2 },
  amethyst: { key: 'gem', tint: 0xb4a0ff, size: 1.2 },
  coin: { key: 'coin', tint: 0xffffff, size: 0.95 },
} as const;
export type SymbolId = keyof typeof SYMBOLS;
const IDS = Object.keys(SYMBOLS) as SymbolId[];

export const LAND_TIME = 0.5;
export const delayOf = (col: number, row: number) => col * 140 + (ROWS - 1 - row) * 55;

const random = (): SymbolId => IDS[Math.floor(Math.random() * IDS.length)];
const emptyWins = () => Array.from({ length: COLS }, () => Array<boolean>(ROWS).fill(false));

export const game = $state({
  spinId: 0,
  spinning: false,
  grid: Array.from({ length: COLS }, () => Array.from({ length: ROWS }, random)),
  wins: emptyWins(),
  host: 'idle' as 'idle' | 'cheer',
  message: 'SPIN을 눌러 보세요',
  landEvents: 0,
});

export function spin() {
  if (game.spinning) return;
  game.spinning = true;
  game.spinId++;
  game.wins = emptyWins();
  game.host = 'idle';
  game.message = '...';
  const grid = Array.from({ length: COLS }, () => Array.from({ length: ROWS }, random));
  // Half of the spins get a line so the win animation shows up often.
  if (Math.random() < 0.55) {
    const row = Math.floor(Math.random() * ROWS);
    const length = 3 + Math.floor(Math.random() * 3);
    const symbol = random();
    for (let c = 0; c < length; c++) grid[c][row] = symbol;
    if (length < COLS && grid[length][row] === symbol) grid[length][row] = IDS[(IDS.indexOf(symbol) + 1) % IDS.length];
  }
  game.grid = grid;
  const total = delayOf(COLS - 1, 0) + LAND_TIME * 1000 + 150;
  setTimeout(evaluate, total);
}

function evaluate() {
  const wins = emptyWins();
  let count = 0;
  for (let r = 0; r < ROWS; r++) {
    let n = 1;
    while (n < COLS && game.grid[n][r] === game.grid[0][r]) n++;
    if (n >= 3) {
      for (let c = 0; c < n; c++) wins[c][r] = true;
      count += n;
    }
  }
  game.wins = wins;
  game.host = count ? 'cheer' : 'idle';
  game.message = count ? `당첨! 심볼 ${count}개` : '아쉽네요. 다시 돌려 보세요';
  game.spinning = false;
}
