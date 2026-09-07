// Local, versioned output only. Does not publish, overwrite prior Releases, or include local records.
import {packager} from '@electron/packager';
import {existsSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const releaseRoot='D:/天音次元社团网站/releases/stock-manager-0.2.0';
const variant=process.argv[2] ?? 'portable';
if(!/^(?:build\d+\/)?portable$/.test(variant))throw new Error('Expected a versioned portable output name.');
const destination=path.join(releaseRoot,variant);
if(existsSync(destination))throw new Error('Versioned package directory already exists; inspect it before another build.');
const dirs=await packager({dir:root,name:'Amane Stock Manager',platform:'win32',arch:'x64',out:destination,prune:true,overwrite:false,
  ...(existsSync(path.join(root,'assets/app.ico')) ? {icon:path.join(root,'assets/app.ico')} : {}),
  ignore:entry=>!!entry && !/^\/(out|assets|node_modules)(\/|$)|^\/package(?:-lock)?\.json$/.test(entry.replaceAll('\\','/'))});
console.log(JSON.stringify({version:'0.2.0',packaged:dirs,publication:false}));
