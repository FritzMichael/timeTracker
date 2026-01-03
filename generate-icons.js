// Simple script to generate PWA icons
const fs = require('fs');
const path = require('path');

// Create a simple SVG icon
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="128" fill="#2563eb"/>
  <circle cx="256" cy="256" r="180" fill="none" stroke="#ffffff" stroke-width="20"/>
  <line x1="256" y1="256" x2="256" y2="140" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>
  <line x1="256" y1="256" x2="340" y2="256" stroke="#ffffff" stroke-width="16" stroke-linecap="round"/>
  <circle cx="256" cy="256" r="12" fill="#ffffff"/>
  <text x="256" y="430" font-family="Arial, sans-serif" font-size="80" font-weight="bold" fill="#ffffff" text-anchor="middle">TT</text>
</svg>`;

// Save the SVG
fs.writeFileSync(path.join(__dirname, 'public', 'icon.svg'), iconSvg);

console.log('SVG icon created at public/icon.svg');
console.log('\nTo generate PNG icons, you can use:');
console.log('1. Online converter like https://cloudconvert.com/svg-to-png');
console.log('2. Or install sharp: npm install sharp');
console.log('\nFor now, create a simple placeholder using canvas...');

// Create simple HTML canvas-based icons
const canvasScript = `
<!DOCTYPE html>
<html>
<head><title>Icon Generator</title></head>
<body>
<h2>Generating icons...</h2>
<canvas id="canvas192" width="192" height="192"></canvas>
<canvas id="canvas512" width="512" height="512"></canvas>
<div id="links"></div>
<script>
function generateIcon(canvasId, size) {
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext('2d');
  
  // Background
  ctx.fillStyle = '#2563eb';
  ctx.roundRect(0, 0, size, size, size/4);
  ctx.fill();
  
  // Clock circle
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = size/25;
  ctx.beginPath();
  ctx.arc(size/2, size/2, size*0.35, 0, Math.PI * 2);
  ctx.stroke();
  
  // Clock hands
  ctx.lineCap = 'round';
  ctx.lineWidth = size/32;
  // Hour hand
  ctx.beginPath();
  ctx.moveTo(size/2, size/2);
  ctx.lineTo(size/2, size*0.27);
  ctx.stroke();
  // Minute hand
  ctx.beginPath();
  ctx.moveTo(size/2, size/2);
  ctx.lineTo(size*0.66, size/2);
  ctx.stroke();
  
  // Center dot
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(size/2, size/2, size/42, 0, Math.PI * 2);
  ctx.fill();
  
  // Text
  ctx.font = 'bold ' + (size/6.4) + 'px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('TT', size/2, size*0.84);
  
  // Create download link
  canvas.toBlob(function(blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'icon-' + size + '.png';
    link.textContent = 'Download icon-' + size + '.png';
    link.style.display = 'block';
    link.style.margin = '10px';
    document.getElementById('links').appendChild(link);
  });
}

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    this.beginPath();
    this.moveTo(x+r, y);
    this.arcTo(x+w, y, x+w, y+h, r);
    this.arcTo(x+w, y+h, x, y+h, r);
    this.arcTo(x, y+h, x, y, r);
    this.arcTo(x, y, x+w, y, r);
    this.closePath();
    return this;
  };
}

generateIcon('canvas192', 192);
generateIcon('canvas512', 512);

document.body.innerHTML += '<p>Open each link above and save the files to the public/ folder</p>';
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(__dirname, 'icon-generator.html'), canvasScript);
console.log('Icon generator HTML created at icon-generator.html');
console.log('Open this file in a browser to download the icon files.');
