# PWA Installation Instructions

## What was changed:

1. **manifest.json** - Updated with:
   - Added `scope` and `orientation` fields
   - Added `purpose: "any maskable"` to icons for better Android support

2. **index.html** - Added meta tags:
   - Apple touch icon support
   - iOS web app capability tags
   - Better mobile app experience

3. **server.js** - Added:
   - Explicit manifest.json route with correct content-type

4. **sw.js** - Updated cache to include more resources

## Required: Create PNG Icons

**You MUST create the icon files for the PWA to be installable!**

### Quick Method (Recommended):

1. Open `icon-generator.html` in your web browser
2. Click the two download links that appear
3. Save both `icon-192.png` and `icon-512.png` to the `public/` folder

### Alternative Methods:

**Online Converter:**
1. Go to https://www.iloveimg.com/resize-image or similar
2. Upload `public/icon.svg`
3. Resize to 192x192px, download as `icon-192.png`
4. Resize to 512x512px, download as `icon-512.png`
5. Place both in `public/` folder

**Using ImageMagick (if installed):**
```bash
magick convert -background none -resize 192x192 public/icon.svg public/icon-192.png
magick convert -background none -resize 512x512 public/icon.svg public/icon-512.png
```

## Testing PWA Installation:

1. Make sure icons exist in `public/` folder
2. Restart your server
3. Open your site in Chrome on Android
4. Look for "Add to Home Screen" or "Install app" prompt
5. Once installed, NFC tags will open in the dedicated PWA context!

## Troubleshooting:

If the install prompt doesn't appear:
- Check Chrome DevTools > Application > Manifest (should show no errors)
- Ensure you're using HTTPS (required for PWA)
- Clear browser cache and service worker
- Check that both icon files exist and are valid PNG files

## Why This Matters for NFC:

When installed as a PWA, your time tracker will:
- Open in its own window (not a browser tab)
- Maintain a dedicated browsing context
- Keep session state when NFC tags redirect to the app
- Provide a native app-like experience
