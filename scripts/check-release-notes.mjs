import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateReleaseNotes } from './generate-update-manifest.mjs';

export async function checkReleaseNotes(version, releaseNotesPath = 'release-notes.json') {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('A stable semantic release version is required');
  const notesPath = resolve(releaseNotesPath);
  const value = JSON.parse(await readFile(notesPath, 'utf8'));
  return validateReleaseNotes(value, version).current;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkReleaseNotes(process.argv[2], process.argv[3] ?? 'release-notes.json');
}
