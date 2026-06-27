'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const extensionDir = path.join(root, 'ES');
const manifest = JSON.parse(
  fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8')
);
const outputDir = path.join(root, 'dist');
const outputPath = path.join(
  outputDir,
  'entry-save-manager-' + manifest.version + '.zip'
);

const files = [
  'manifest.json',
  'shared.js',
  'content.js',
  'inject.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icon48.png',
  'icon128.png',
];

const missing = files.filter((file) => (
  !fs.existsSync(path.join(extensionDir, file))
));
if (missing.length) {
  throw new Error(
    'Release package is missing required files:\n- '
    + missing.join('\n- ')
  );
}

function readPngSize(file) {
  const data = fs.readFileSync(file);
  if (data.length < 24 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(path.basename(file) + ' must be a PNG file.');
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

for (const size of [48, 128]) {
  const iconPath = path.join(extensionDir, 'icon' + size + '.png');
  const dimensions = readPngSize(iconPath);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(
      path.basename(iconPath) + ' must be exactly ' + size + 'x' + size + '.'
    );
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11)
      | (date.getMinutes() << 5)
      | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9)
      | ((date.getMonth() + 1) << 5)
      | date.getDate(),
  };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const data = entry.data;
    const checksum = crc32(data);
    const stamp = dosDateTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const entries = files.map((file) => {
  const fullPath = path.join(extensionDir, file);
  return {
    name: file,
    data: fs.readFileSync(fullPath),
    mtime: fs.statSync(fullPath).mtime,
  };
});

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, createZip(entries));
console.log(outputPath);
