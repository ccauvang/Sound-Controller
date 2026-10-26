const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

// script lives in build/, project root is one level up
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(__dirname, 'dist');
const INCLUDE = ['src', 'assets'];
const PKG = 'sound-controller-eq';
const MANIFEST = 'manifest.json';

if (!fs.existsSync(path.join(ROOT, MANIFEST))) {
    console.error(`missing ${MANIFEST}`);
    process.exit(1);
};

// same filter as .gitignore - _metadata is injected by chrome on unpacked load, test* are local scratch files
const skip = (src) => {
    const base = path.basename(src);
    return base !== '_metadata' && !base.startsWith('test');
}

fs.rmSync(DIST, { recursive: true, force: true });

const version = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST), 'utf8')).version;
if (!version) {
    console.error(`no version in ${MANIFEST}`);
    process.exit(1);
}

// unpacked copy is kept for "Load unpacked" in chrome and edge, the zip is what the stores take
const stage = path.join(DIST, 'chrome');
fs.mkdirSync(stage, { recursive: true });

for (const dir of INCLUDE) {
    fs.cpSync(path.join(ROOT, dir), path.join(stage, dir), { recursive: true, filter: skip });
}

fs.copyFileSync(path.join(ROOT, MANIFEST), path.join(stage, 'manifest.json'));

const zip = new AdmZip();
zip.addLocalFolder(stage);
const out = path.join(DIST, `${PKG}-${version}.zip`);
zip.writeZip(out);
console.log(`built ${path.relative(ROOT, out)}`);
