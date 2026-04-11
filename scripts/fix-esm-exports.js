#!/usr/bin/env node
// Fix ESM packages that have incomplete exports for Node.js 25 compatibility
// Many packages only define "import" export but miss "default" which tsx needs

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function fixExports(pkgJsonPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    if (!pkg.exports || typeof pkg.exports !== 'object') return false;
    if (!pkg.type || pkg.type !== 'module') return false;
    
    const pkgName = pkg.name;
    let fixed = false;
    
    // Check if exports has mixed '.' and non-'.' keys (invalid in Node 25)
    const keys = Object.keys(pkg.exports);
    const hasDotKeys = keys.some(k => k.startsWith('.'));
    const hasNonDotKeys = keys.some(k => !k.startsWith('.'));
    
    if (hasNonDotKeys && !hasDotKeys) {
      // Convert conditional exports to use '.' wrapper
      const oldExports = { ...pkg.exports };
      delete pkg.exports;
      pkg.exports = { '.': {}, './package.json': './package.json' };
      
      for (const [key, value] of Object.entries(oldExports)) {
        if (key === './package.json') {
          pkg.exports['./package.json'] = value;
        } else if (typeof value === 'string') {
          pkg.exports['.'][key] = { import: value, default: value };
          fixed = true;
        } else if (typeof value === 'object' && value !== null) {
          // Add default to nested conditionals
          if (value.import && !value.default) {
            value.default = value.import;
          }
          pkg.exports['.'][key] = value;
          fixed = true;
        }
      }
    } else if (hasDotKeys) {
      // Just need to add 'default' to nested conditionals
      function addDefaultToConditional(obj) {
        if (typeof obj !== 'object' || obj === null) return false;
        let didFix = false;
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'types' || key === 'require' || key === 'default') continue;
          if (typeof value === 'string') {
            obj.default = value;
            didFix = true;
          } else if (typeof value === 'object' && value !== null) {
            if (value.import && !value.default) {
              value.default = value.import;
              didFix = true;
            }
            if (addDefaultToConditional(value)) didFix = true;
          }
        }
        return didFix;
      }
      
      if (pkg.exports['.']) {
        if (addDefaultToConditional(pkg.exports['.'])) fixed = true;
      }
    }
    
    // Simple case: only "import" at root (no '.')
    if (pkg.exports.import && !pkg.exports['.']) {
      const importPath = pkg.exports.import;
      pkg.exports = {
        '.': { 'import': importPath, 'default': importPath },
        './package.json': './package.json'
      };
      fixed = true;
    }
    
    if (fixed) {
      if (!pkg.exports['./package.json']) {
        pkg.exports['./package.json'] = './package.json';
      }
      fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
      console.log(`✓ Fixed exports for ${pkgName}`);
      return true;
    }
  } catch (err) {
    // ignore
  }
  return false;
}

function scanNodeModules(dir) {
  const packages = [];
  
  function scan(currentDir) {
    if (!fs.existsSync(currentDir)) return;
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name === '.cache') continue;
      const fullPath = path.join(currentDir, entry.name);
      
      if (entry.isDirectory()) {
        const pkgJson = path.join(fullPath, 'package.json');
        if (fs.existsSync(pkgJson)) {
          if (fixExports(pkgJson)) {
            packages.push(entry.name);
          }
        }
        // Also scan nested node_modules
        const nestedNm = path.join(fullPath, 'node_modules');
        if (fs.existsSync(nestedNm)) {
          scan(nestedNm);
        }
      }
    }
  }
  
  scan(dir);
  return packages;
}

const nmPath = path.join(ROOT, 'node_modules');
console.log('Fixing ESM exports for Node.js 25 compatibility...');
const fixed = scanNodeModules(nmPath);
console.log(`Done! Fixed ${fixed.length} packages: ${fixed.join(', ') || 'none'}`);
