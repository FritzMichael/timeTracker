#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

console.log('=== PWA Icon Setup ===\n');

// Check if icons already exist
const icon192Path = path.join(__dirname, 'public', 'icon-192.png');
const icon512Path = path.join(__dirname, 'public', 'icon-512.png');

if (fs.existsSync(icon192Path) && fs.existsSync(icon512Path)) {
  console.log('✓ Icons already exist!');
  console.log('  - public/icon-192.png');
  console.log('  - public/icon-512.png');
  console.log('\nYour PWA should be ready to install on Android!');
  process.exit(0);
}

console.log('⚠ Missing icon files!\n');
console.log('The PWA cannot be installed without these PNG icons:');
console.log('  - public/icon-192.png (192x192 pixels)');
console.log('  - public/icon-512.png (512x512 pixels)\n');

console.log('QUICKEST SOLUTION:');
console.log('1. Open icon-generator.html in your browser');
console.log('2. Click the download links');
console.log('3. Save both files to the public/ folder\n');

console.log('ALTERNATIVE: Use an online PNG converter');
console.log('1. Go to https://svgtopng.com or similar');
console.log('2. Upload public/icon.svg');
console.log('3. Set width to 192, download as icon-192.png');
console.log('4. Set width to 512, download as icon-512.png');
console.log('5. Move both to public/ folder\n');

console.log('After creating the icons, restart your server to test!');
