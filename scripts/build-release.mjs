import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const outDir = path.join(root, 'build', manifest.id);

execSync('npm run build', { cwd: root, stdio: 'inherit' });

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of ['main.js', 'manifest.json', 'styles.css']) {
	const src = path.join(root, file);
	if (!existsSync(src)) continue;
	copyFileSync(src, path.join(outDir, file));
}

console.log(`Built plugin to ${outDir}`);
