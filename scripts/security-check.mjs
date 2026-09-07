import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Report paths and rule names only. Never echo matched credential content.
const candidates = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
const rules = [
  ['provider credential', /\bsk-(?:or-v1-)?[a-zA-Z0-9_-]{24,}\b/],
  ['GitHub credential', /\b(?:gh[pousr]_[a-zA-Z0-9]{24,}|github_pat_[a-zA-Z0-9_]{30,})\b/],
  ['Google credential', /\bAIza[a-zA-Z0-9_-]{30,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
if (process.argv.includes('--build') && fs.existsSync('dist')) {
  for (const entry of fs.readdirSync('dist',{recursive:true,withFileTypes:true})) if(entry.isFile()) candidates.push(path.join(entry.parentPath,entry.name));
}
let checked=0;
const failures=[];
for(const file of new Set(candidates)){
  if(!/\.(?:[cm]?[jt]sx?|vue|json|toml|ya?ml|html|css|md|ps1|txt)$/.test(file)||!fs.existsSync(file)) continue;
  const text=fs.readFileSync(file,'utf8');checked++;
  for(const [name,pattern] of rules) if(pattern.test(text))failures.push({file,rule:name});
}
if(failures.length){console.error(JSON.stringify({status:'FAIL',files:failures}));process.exitCode=1;}
else console.log(`Secret-pattern scan passed: ${checked} source/build text files. Pattern scanning does not replace independent security review.`);
