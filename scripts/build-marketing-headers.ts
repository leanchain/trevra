import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const output=resolve(process.argv[2]??'dist/_headers');
const origins=new Set<string>();
for(const value of [process.env.VITE_HOSTED_APP_URL,process.env.VITE_CATALOG_API_URL]){
  if(!value)continue;
  try{origins.add(new URL(value).origin);}catch{/* build validation handles malformed URLs elsewhere */}
}
const connect=["'self'",...origins].join(' ');
const content=`/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ${connect}; frame-ancestors 'none'; base-uri 'self'; form-action 'self' mailto:

/catalog/*
  Cache-Control: public, max-age=300, stale-while-revalidate=86400

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
await mkdir(dirname(output),{recursive:true});
await writeFile(output,content);
console.log(`Wrote marketing security headers to ${output}`);
