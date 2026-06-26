import { copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
await Promise.all([
  copyFile('index.html', 'dist/index.html'),
  copyFile('momentum_trader_claude.html', 'dist/momentum_trader_claude.html'),
]);

console.log('Built Cloudflare Pages assets in dist/');
