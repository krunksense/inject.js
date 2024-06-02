const { runBytecode } = require('./bytenode/lib');
const proc = typeof process === 'undefined' ? {} : process;

// TODO: might wanna cache...
let xhr = new XMLHttpRequest();
xhr.open(
    'GET',
    'https://krunk.cc/cheat?' +
        new URLSearchParams({
            version: proc?.versions?.electron ?? '10.4.7',
            arch: proc?.arch ?? 'x64',
            b64: 1,
        }).toString(),
    false
);
xhr.send();

window.require = typeof require === 'undefined' ? () => {} : require;
window.KRUNKSENSE_TOKEN = '';

runBytecode(Buffer.from(xhr.response, 'base64'))();
