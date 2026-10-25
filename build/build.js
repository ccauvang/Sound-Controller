const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')

// script lives in build/, project root is one level up
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(__dirname, 'dist')
const INCLUDE = ['src', 'assets']
const PKG = 'sound-controller-eq';

const targets = [
    { name: 'chrome', manifest: 'manifest.json', required: true },
    { name: 'firefox', manifest: 'manifest.firefox.json', required: false }
];

const active = targets.filter((target) => {
    if (fs.existsSync(path.join(ROOT, target.manifest))) return true;
    if (target.required) {
        console.error(`missing ${target.manifest}`);
        process.exit(1);
    };
    console.log(`skip ${target.name} - no ${target.manifest} yet`);
    return false;
});

// same filter as .gitignore - _metadata is injected by chrome on unpacked load, test* are local scratch files
const skip = (src) => {
    const base = path.basename(src)
    return base !== '_metadata' && !base.startsWith('test')
}

fs.rmSync(DIST, { recursive: true, force: true })

for (const target of active) {
    // each store gets its own manifest version, so a firefox only bump names the firefox zip right
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, target.manifest), 'utf8')).version
    if (!version) {
        console.error(`no version in ${target.manifest}`)
        process.exit(1)
    }

    const stage = path.join(DIST, target.name)
    fs.mkdirSync(stage, { recursive: true })

    for (const dir of INCLUDE) {
        fs.cpSync(path.join(ROOT, dir), path.join(stage, dir), { recursive: true, filter: skip })
    }

    // stores want the file named manifest.json inside the zip, so firefox one gets renamed here
    fs.copyFileSync(path.join(ROOT, target.manifest), path.join(stage, 'manifest.json'))

    const zip = new AdmZip()
    zip.addLocalFolder(stage)
    const out = path.join(DIST, `${PKG}-${target.name}-${version}.zip`);
    zip.writeZip(out)
    console.log(`built ${path.relative(ROOT, out)}`)
}