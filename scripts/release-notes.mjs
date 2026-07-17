import { releaseNotes, verifyRelease } from './verify-release.mjs';

const tagIndex = process.argv.indexOf('--tag');
const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : '';
const version = await verifyRelease(tag);
process.stdout.write(await releaseNotes(version));
