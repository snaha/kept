import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path'
import { buildConfiguration } from './build-configuration.mjs'
import { signingConfiguration, macDownloadNotice } from './mac-distribution.mjs'

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const channel = process.env.MUSIC_CHANNEL === 'preview' ? 'preview' : 'stable';
const commit = process.env.MUSIC_COMMIT || process.env.GITHUB_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0;
const run = process.env.GITHUB_RUN_NUMBER || '0';
const version = channel === 'preview' ? `${pkg.version}-preview.${run}.${commit.slice(0, 7)}` : pkg.version;
const configuration = buildConfiguration(pkg, channel, version, process.env)
const { productName } = configuration
const { developerSigned, notarizationConfigured } = signingConfiguration(process.env)
const info = { dirty, version, channel, productName, commit, branch, builtAt: new Date().toISOString(), runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '', developerSigned, notarizationConfigured };
await writeFile(path.join(root, 'build-info.json'), JSON.stringify(info, undefined, 2));
await writeFile(path.join(root, 'builder-config.json'), JSON.stringify(configuration, undefined, 2))
console.log(`${productName} ${version} (${commit.slice(0, 7)}) · ${notarizationConfigured && developerSigned ? 'Developer ID + notarization configured (verification pending)' : channel === 'preview' ? macDownloadNotice(false) : 'local development configuration; stable Mac downloads require signing and notarization'}`)
