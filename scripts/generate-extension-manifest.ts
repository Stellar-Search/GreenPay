/**
 * Generates extension/manifest.json with connect-src URLs
 * derived from the active network manifest.
 *
 * Run: npx ts-node scripts/generate-extension-manifest.ts
 *
 * NEVER hand-edit the connect-src list — run this script instead.
 */

import { getActiveManifest, getConnectSrcUrls } from '../config/networks';
import baseManifest from '../extension/manifest.base.json';
import * as fs from 'fs';
import * as path from 'path';

const manifest = getActiveManifest();
const connectSrcUrls = getConnectSrcUrls(manifest);

const extensionManifest = {
  ...baseManifest,
  content_security_policy: {
    extension_pages: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      `connect-src 'self' ${connectSrcUrls.join(' ')}`,
      "img-src 'self' data:",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  },
};

const outputPath = path.join(__dirname, '../extension/manifest.json');
fs.writeFileSync(outputPath, JSON.stringify(extensionManifest, null, 2));

console.log(`Generated extension/manifest.json for ${manifest.network}`);
console.log(`connect-src: ${connectSrcUrls.join(' ')}`);
