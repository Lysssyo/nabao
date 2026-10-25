import { cp, mkdir, readdir, rm } from 'node:fs/promises';
const target = new URL('../../backend/src/main/resources/static/admin/', import.meta.url);
const source = new URL('../dist/', import.meta.url);
await mkdir(target, { recursive: true });
// This directory contains only this application's generated output.
for (const name of await readdir(target)) await rm(new URL(name, target), { recursive: true, force: true });
await cp(source, target, { recursive: true });
console.log('Vue production build synced to backend static/admin.');
