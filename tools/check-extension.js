'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const extensionDir = path.join(root, 'ES');
const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const requiredFiles = new Set([
  'manifest.json',
  'shared.js',
  'content.js',
  'inject.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icon48.png',
  'icon128.png',
]);

for (const script of manifest.content_scripts || []) {
  for (const file of script.js || []) requiredFiles.add(file);
}
for (const file of Object.values(manifest.icons || {})) requiredFiles.add(file);
for (const file of Object.values(manifest.action?.default_icon || {})) {
  requiredFiles.add(file);
}

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(extensionDir, file))) {
    throw new Error('Missing extension file: ' + file);
  }
}

if (manifest.manifest_version !== 3) {
  throw new Error('manifest_version must be 3.');
}
if (manifest.minimum_chrome_version !== '111') {
  throw new Error('minimum_chrome_version must declare Chrome 111+ for MAIN world content scripts.');
}
if (manifest.version !== packageJson.version) {
  throw new Error('manifest and package versions must match.');
}
const badgeMatch = readme.match(/version-([0-9]+\.[0-9]+\.[0-9]+)-blue/);
if (!badgeMatch) {
  throw new Error('README version badge is missing.');
}
if (badgeMatch[1] !== manifest.version) {
  throw new Error('README version badge must match manifest version.');
}
const currentMatch = readme.match(/현재:\s+\*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/);
if (!currentMatch || currentMatch[1] !== manifest.version) {
  throw new Error('README current version must match manifest version.');
}
const changelogMatch = readme.match(/^- \*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/m);
if (!changelogMatch || changelogMatch[1] !== manifest.version) {
  throw new Error('README top changelog version must match manifest version.');
}

if (JSON.stringify(manifest.permissions) !== JSON.stringify([
  'activeTab',
  'scripting',
])) {
  throw new Error('Entry Save must request only activeTab and scripting.');
}
if (manifest.host_permissions && manifest.host_permissions.length) {
  throw new Error('Entry Save must not request host_permissions.');
}
if (JSON.stringify(manifest.icons) !== JSON.stringify({
  48: 'icon48.png',
  128: 'icon128.png',
})) {
  throw new Error('Manifest icons must include only the existing 48/128px icons.');
}
if (JSON.stringify(manifest.action.default_icon) !== JSON.stringify({
  48: 'icon48.png',
  128: 'icon128.png',
})) {
  throw new Error('Action icons must include the 48/128px icons.');
}

for (const size of [48, 128]) {
  const data = fs.readFileSync(path.join(extensionDir, 'icon' + size + '.png'));
  if (data.length < 24
      || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || data.readUInt32BE(16) !== size
      || data.readUInt32BE(20) !== size) {
    throw new Error('icon' + size + '.png must be an exact ' + size + 'px PNG.');
  }
}

const matchValues = [];
for (const script of manifest.content_scripts || []) {
  for (const match of script.matches || []) matchValues.push(match);
}
for (const resource of manifest.web_accessible_resources || []) {
  for (const match of resource.matches || []) matchValues.push(match);
}
if (matchValues.some((match) => (
  match.includes('localhost') || match.includes('127.0.0.1')
))) {
  throw new Error('Release manifest must not include localhost matches.');
}
if (!matchValues.every((match) => (
  match === 'https://playentry.org/*'
  || match === 'https://*.playentry.org/*'
))) {
  throw new Error('Release manifest matches must be limited to playentry.org.');
}

const contentScripts = manifest.content_scripts || [];
if (contentScripts.length !== 2) {
  throw new Error('Entry Save expects ISOLATED and MAIN content script entries.');
}
if (!contentScripts.every((entry) => entry.all_frames === true)) {
  throw new Error('Every content script entry must use all_frames.');
}
if (!contentScripts.some((entry) => entry.world === 'MAIN')) {
  throw new Error('Entry Save currently relies on a MAIN world content script.');
}
const webResources = manifest.web_accessible_resources || [];
if (webResources.length !== 1
    || JSON.stringify(webResources[0].resources) !== JSON.stringify([
      'shared.js',
      'inject.js',
    ])) {
  throw new Error('Only shared.js and inject.js may be web-accessible.');
}

const debugExpectations = {
  'content.js': 'const DEBUG = false;',
  'inject.js': 'const DEBUG = false;',
};
for (const [file, expected] of Object.entries(debugExpectations)) {
  const source = fs.readFileSync(path.join(extensionDir, file), 'utf8');
  if (!source.includes(expected)) {
    throw new Error(file + ' must keep DEBUG disabled for release.');
  }
}

for (const file of ['shared.js', 'content.js', 'inject.js', 'popup.js']) {
  const source = fs.readFileSync(path.join(extensionDir, file), 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(source)) {
    throw new Error(file + ' contains remote-code-compatible evaluation.');
  }
  const result = spawnSync(process.execPath, ['--check', path.join(extensionDir, file)], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(file + ' syntax check failed:\n' + result.stderr);
  }
}

console.log('Entry Save extension check passed.');
