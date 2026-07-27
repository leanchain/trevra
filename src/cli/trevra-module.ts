import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { communityModuleManifestSchema, moduleReleaseSigningPayload } from '../server/registry/service.js';

const [command='help',...args]=process.argv.slice(2);
try{
  if(command==='keygen'){
    const prefix=resolve(args[0]??'trevra-publisher');
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    const privatePath=`${prefix}.private.pem`;const publicPath=`${prefix}.public.pem`;
    await writeFile(privatePath,privateKey.export({type:'pkcs8',format:'pem'}));
    await writeFile(publicPath,publicKey.export({type:'spki',format:'pem'}));
    await chmod(privatePath,0o600);await chmod(publicPath,0o644);
    print({privateKey:privatePath,publicKey:publicPath,fingerprint:createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')});
  }else if(command==='sign'){
    const [manifestPath,sbomPath,privateKeyPath]=args;
    if(!manifestPath||!sbomPath||!privateKeyPath)throw new Error('Usage: npm run module -- sign <manifest.json> <sbom.json> <private-key.pem>');
    const manifest=communityModuleManifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));
    const sbom=JSON.parse(await readFile(sbomPath,'utf8')) as Record<string,unknown>;
    const payload=moduleReleaseSigningPayload(manifest,sbom);
    const signature=sign(null,Buffer.from(payload),await readFile(privateKeyPath)).toString('base64');
    print({moduleId:manifest.id,version:manifest.version,signature,signaturePayloadHash:createHash('sha256').update(payload).digest('hex')});
  }else if(command==='verify'){
    const [manifestPath,sbomPath,publicKeyPath,signature]=args;
    if(!manifestPath||!sbomPath||!publicKeyPath||!signature)throw new Error('Usage: npm run module -- verify <manifest.json> <sbom.json> <public-key.pem> <base64-signature>');
    const manifest=communityModuleManifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));
    const sbom=JSON.parse(await readFile(sbomPath,'utf8')) as Record<string,unknown>;
    const payload=moduleReleaseSigningPayload(manifest,sbom);
    print({valid:verify(null,Buffer.from(payload),await readFile(publicKeyPath),Buffer.from(signature,'base64')),moduleId:manifest.id,version:manifest.version});
  }else{
    process.stdout.write([
      'Trevra module publisher CLI','',
      '  keygen [path-prefix]','  sign <manifest.json> <sbom.json> <private-key.pem>',
      '  verify <manifest.json> <sbom.json> <public-key.pem> <base64-signature>','',
      'Private keys remain local. Trevra receives only the public key and release signature.',''
    ].join('\n'));
  }
}catch(error){process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;}
function print(value:unknown){process.stdout.write(`${JSON.stringify(value,null,2)}\n`);}
