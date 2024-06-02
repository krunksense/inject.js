'use strict';

const { ok } = require('assert').strict;
const { brotliCompressSync, brotliDecompressSync } = require('zlib');
const fs = require('fs');
const vm = require('vm');
const v8 = require('v8');
const path = require('path');
const Module = require('module');
const { spawn } = require('child_process');

v8.setFlagsFromString('--no-lazy');

if (Number.parseInt(process.versions.node, 10) >= 12) {
  v8.setFlagsFromString('--no-flush-bytecode'); // Thanks to A-Parser (@a-parser)
}

const COMPILED_EXTNAME = '.jsc';
const MAGIC_NUMBER = Buffer.from([0xde, 0xc0]);
const ZERO_LENGTH_EXTERNAL_REFERENCE_TABLE = Buffer.alloc(2);
const sheBangRegex = /^#!.*/;

function generateScript (cachedData, filename) {
  if (!isBufferV8Bytecode(cachedData)) {
    // Try to decompress as Brotli
    cachedData = brotliDecompressSync(cachedData);

    ok(isBufferV8Bytecode(cachedData), 'Invalid bytecode buffer');
  }

  fixBytecode(cachedData);

  const length = readSourceHash(cachedData);

  let dummyCode = '';

  if (length > 1) {
    dummyCode = '"' + '\u200b'.repeat(length - 2) + '"'; // "\u200b" Zero width space
  }

  const script = new vm.Script(dummyCode, { cachedData, filename });

  if (script.cachedDataRejected) {
    throw new Error('Invalid or incompatible cached data (cachedDataRejected)');
  }

  return script;
}

function isBufferV8Bytecode (buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    !buffer.subarray(0, 2).equals(ZERO_LENGTH_EXTERNAL_REFERENCE_TABLE) &&
    buffer.subarray(2, 4).equals(MAGIC_NUMBER)
  );

  // TODO: check that code start + payload size = buffer length. See
  //       https://github.com/bytenode/bytenode/issues/210#issuecomment-1605691369
}

/**
 * Generates v8 bytecode buffer.
 * @param   {string} javascriptCode JavaScript source that will be compiled to bytecode.
 * @param   {boolean} compress Compress the bytecode.
 * @returns {Buffer} The generated bytecode.
 */
const compileCode = function (javascriptCode, compress) {
  if (typeof javascriptCode !== 'string') {
    throw new Error(`javascriptCode must be string. ${typeof javascriptCode} was given.`);
  }

  const script = new vm.Script(javascriptCode, {
    produceCachedData: true
  });

  let bytecodeBuffer = (script.createCachedData && script.createCachedData.call)
    ? script.createCachedData()
    : script.cachedData;

  if (compress) bytecodeBuffer = brotliCompressSync(bytecodeBuffer);

  return bytecodeBuffer;
};

/**
 * This function runs the compileCode() function (above)
 * via a child process using Electron as Node
 * @param {string} javascriptCode
 * @param {object} [options] - optional options object
 * @param {string} [options.electronPath] - optional path to Electron executable, defaults to the installed node_modules/electron
 * @param {boolean} [options.compress]
 * @returns {Promise<Buffer>} - returns a Promise which resolves in the generated bytecode.
 */
const compileElectronCode = function (javascriptCode, options) {
  return new Promise((resolve, reject) => {
    function onEnd () {
      if (options.compress) data = brotliCompressSync(data);

      resolve(data);
    }

    /** @type {string} */
    const electronExecutablePath = require('electron');
    options = options || {};

    let data = Buffer.from([]);

    const electronPath = options.electronPath ? path.normalize(options.electronPath) : electronExecutablePath;
    if (!fs.existsSync(electronPath)) {
      throw new Error('Electron not found');
    }
    const bytenodePath = path.join(__dirname, 'cli.js');

    // create a subprocess in which we run Electron as our Node and V8 engine
    // running Bytenode to compile our code through stdin/stdout
    const child = spawn(electronPath, [bytenodePath, '--compile', '--no-module', '-'], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    if (child.stdin) {
      child.stdin.write(javascriptCode);
      child.stdin.end();
    }

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        data = Buffer.concat([data, chunk]);
      });
      child.stdout.on('error', (err) => {
        console.error(err);
      });
      child.stdout.on('end', onEnd);
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        console.error('Error: ', chunk.toString());
      });
      child.stderr.on('error', (err) => {
        console.error('Error: ', err);
      });
    }

    child.addListener('message', (message) => console.log(message));
    child.addListener('error', err => console.error(err));

    child.on('error', (err) => reject(err));
    child.on('exit', onEnd);
  });
};

// TODO: rewrite this function
const fixBytecode = function (bytecodeBuffer) {
  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error('bytecodeBuffer must be a buffer object.');
  }

  const dummyBytecode = compileCode('"ಠ_ಠ"');
  const version = parseFloat(process.version.slice(1, 5));

  if (process.version.startsWith('v8.8') || process.version.startsWith('v8.9')) {
    // Node is v8.8.x or v8.9.x
    dummyBytecode.subarray(16, 20).copy(bytecodeBuffer, 16);
    dummyBytecode.subarray(20, 24).copy(bytecodeBuffer, 20);
  } else if (version >= 12 && version <= 20) {
    dummyBytecode.subarray(12, 16).copy(bytecodeBuffer, 12);
  } else {
    dummyBytecode.subarray(12, 16).copy(bytecodeBuffer, 12);
    dummyBytecode.subarray(16, 20).copy(bytecodeBuffer, 16);
  }
};

// TODO: rewrite this function
const readSourceHash = function (bytecodeBuffer) {
  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error('bytecodeBuffer must be a buffer object.');
  }

  if (process.version.startsWith('v8.8') || process.version.startsWith('v8.9')) {
    // Node is v8.8.x or v8.9.x
    // eslint-disable-next-line no-return-assign
    return bytecodeBuffer.subarray(12, 16).reduce((sum, number, power) => sum += number * Math.pow(256, power), 0);
  } else {
    // eslint-disable-next-line no-return-assign
    return bytecodeBuffer.subarray(8, 12).reduce((sum, number, power) => sum += number * Math.pow(256, power), 0);
  }
};

/**
 * Runs v8 bytecode buffer and returns the result.
 * @param   {Buffer} bytecodeBuffer The buffer object that was created using compileCode function.
 * @returns {any}    The result of the very last statement executed in the script.
 */
const runBytecode = function (bytecodeBuffer) {
  if (!Buffer.isBuffer(bytecodeBuffer)) {
    throw new Error('bytecodeBuffer must be a buffer object.');
  }

  const script = generateScript(bytecodeBuffer);

  return script.runInThisContext();
};

/**
 * Compiles JavaScript file to .jsc file.
 * @param   {object|string} args
 * @param   {string}          args.filename The JavaScript source file that will be compiled
 * @param   {boolean}         [args.compileAsModule=true] If true, the output will be a commonjs module
 * @param   {boolean}         [args.compress=false] If true, compress the output bytecode
 * @param   {string}          [args.output=filename.jsc] The output filename. Defaults to the same path and name of the original file, but with `.jsc` extension.
 * @param   {boolean}         [args.electron=false] If true, compile code for Electron.
 * @param   {string}          [args.electronPath] (optional) path to Electron executable. When present, the `electron` argument is ignored.
 * @param   {boolean|string}  [args.createLoader=false] If true, create a CommonJS loader file. As a string, select between 'module' or 'commonjs' loader.
 * @param   {boolean}         [args.loaderFilename='%.loader.js'] Filename or pattern for generated loader files. Defaults to originalFilename.loader.js. Use % as a substitute for originalFilename.
 * @param   {string}        [output] The output filename. (Deprecated: use args.output instead)
 * @returns {Promise<string>}        A Promise which returns the compiled filename
 */
const compileFile = async function (args, output) {
  let filename, compileAsModule, compress, electron, createLoader, loaderFilename, electronPath;

  if (typeof args === 'string') {
    filename = args;
    compileAsModule = true;
    compress = false;
    electron = false;
    createLoader = false;
  } else if (typeof args === 'object') {
    filename = args.filename;
    compileAsModule = args.compileAsModule !== false;
    compress = args.compress;
    electron = args.electron || !!args.electronPath;
    electronPath = args.electronPath;
    createLoader = args.createLoader;
    loaderFilename = args.loaderFilename;
    if (loaderFilename && !createLoader) createLoader = true;
  }

  if (typeof filename !== 'string') {
    throw new Error(`filename must be a string. ${typeof filename} was given.`);
  }

  if (createLoader && typeof createLoader !== 'string') {
    createLoader = 'commonjs';
  }

  // @ts-ignore
  const compiledFilename = args.output || output || filename.slice(0, -path.extname(filename).length) + COMPILED_EXTNAME;

  if (typeof compiledFilename !== 'string') {
    throw new Error(`output must be a string. ${typeof compiledFilename} was given.`);
  }

  const javascriptCode = fs.readFileSync(filename, 'utf-8');

  const sheBang = javascriptCode.match(sheBangRegex);
  let code = javascriptCode.replace(sheBangRegex, '');

  if (compileAsModule) {
    code = Module.wrap(code);
  }

  let bytecodeBuffer;

  if (electron) {
    bytecodeBuffer = await compileElectronCode(code, compress, { electronPath });
  } else {
    bytecodeBuffer = compileCode(code, compress);
  }

  fs.writeFileSync(compiledFilename, bytecodeBuffer);

  if (createLoader) {
    addLoaderFile(compiledFilename, loaderFilename, createLoader, sheBang);
  }

  return compiledFilename;
};

/**
 * Runs .jsc file and returns the result.
 * @param   {string} filename
 * @returns {any}    The result of the very last statement executed in the script.
 */
const runBytecodeFile = function (filename) {
  if (typeof filename !== 'string') {
    throw new Error(`filename must be a string. ${typeof filename} was given.`);
  }

  const bytecodeBuffer = fs.readFileSync(filename);

  return runBytecode(bytecodeBuffer);
};

Module._extensions[COMPILED_EXTNAME] = function (fileModule, filename) {
  const bytecodeBuffer = fs.readFileSync(filename);

  const script = generateScript(bytecodeBuffer, filename);

  /*
  This part is based on:
  https://github.com/zertosh/v8-compile-cache/blob/7182bd0e30ab6f6421365cee0a0c4a8679e9eb7c/v8-compile-cache.js#L158-L178
  */

  function require (id) {
    return fileModule.require(id);
  }
  require.resolve = function (request, options) {
    // @ts-ignore
    return Module._resolveFilename(request, fileModule, false, options);
  };
  if (process.mainModule) {
    require.main = process.mainModule;
  }

  // @ts-ignore
  require.extensions = Module._extensions;
  // @ts-ignore
  require.cache = Module._cache;

  const compiledWrapper = script.runInThisContext({
    filename: filename,
    lineOffset: 0,
    columnOffset: 0,
    displayErrors: true
  });

  const dirname = path.dirname(filename);

  const args = [fileModule.exports, require, fileModule, filename, dirname, process, global];

  return compiledWrapper.apply(fileModule.exports, args);
};

/**
 * Add a loader file for a given .jsc file
 * @param {String} fileToLoad path of the .jsc file we're loading
 * @param {String} loaderFilename - optional pattern or name of the file to write - defaults to filename.loader.js. Patterns: "%" represents the root name of .jsc file.
 * @param {string} type select between 'module' or 'commonjs' loader.
 */
const addLoaderFile = function (fileToLoad, loaderFilename, type, sheBang) {
  let loaderFilePath;
  if (typeof loaderFilename === 'boolean' || loaderFilename === undefined || loaderFilename === '') {
    loaderFilePath = fileToLoad.replace('.jsc', '.loader.js');
  } else {
    loaderFilename = loaderFilename.replace('%', path.parse(fileToLoad).name);
    loaderFilePath = path.join(path.dirname(fileToLoad), loaderFilename);
  }
  const loaderCode = type === 'module' ? loaderCodeModule : loaderCodeCommonJS;
  const relativePath = path.relative(path.dirname(loaderFilePath), fileToLoad);
  const code = loaderCode('./' + relativePath, sheBang, loaderFilePath);
  fs.writeFileSync(loaderFilePath, code);
};

const loaderCodeCommonJS = function (targetPath, sheBang) {
  const lines = [
    `require('bytenode')`,
    ``,
    `module.exports = require('${targetPath}')`
  ];

  if (sheBang) lines.unshift(sheBang, '')

  return lines.join('\n')
};

const loaderCodeModule = function (targetPath, sheBang, loaderFilePath) {
  let { default: defaultExport, ...namedExports } = require(loaderFilePath)

  defaultExport = defaultExport ? 'default: defaultExport' : ''
  namedExports = Object.keys(namedExports)

  const lines = [
    `import { createRequire } from 'node:module'`,
    ``,
    `import 'bytenode'`,
    ``,
    ``,
    `const require = createRequire(import.meta.url)`,
    ``
  ]

  if (sheBang) lines.unshift(sheBang, '')

  let exports = [].concat(namedExports)
  if (defaultExport) exports.unshift(defaultExport)
  exports = exports.join(', ')

  if (!exports)
    lines.push(`require('${targetPath}')`)
  else {
    lines.push(`const {${exports}} = require('${targetPath}')`, ``, ``)

    if (defaultExport) lines.push('export default defaultExport')
    if (namedExports.length) lines.push(`export { ${namedExports} }`)
  }

  return lines.join('\n');
};

global.bytenode = {
  compileCode,
  compileFile,
  compileElectronCode,
  runBytecode,
  runBytecodeFile,
  addLoaderFile,
  loaderCode: loaderCodeCommonJS,
  loaderCodeCommonJS,
  loaderCodeModule
};

module.exports = global.bytenode;