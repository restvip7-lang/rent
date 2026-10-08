import { readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { populateDemo } from '../demo-data.mjs';
const path=resolve('data/store.json');
const store=populateDemo(JSON.parse(readFileSync(path,'utf8')));
if(process.argv.includes('--apply')){
  const backup=path.replace('store.json',`store.before-demo-${Date.now()}.json`);
  copyFileSync(path,backup);
  writeFileSync(path+'.tmp',JSON.stringify(store,null,2));renameSync(path+'.tmp',path);
  console.log('Saved. Backup:',backup);
}else console.log('Preview only. Stop the server before running with --apply.');
console.log(JSON.stringify(Object.fromEntries(['complexes','apartments','contacts','stays','places','leads'].map(k=>[k,store[k].length]))));
