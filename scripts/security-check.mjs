import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// Report paths and rule names only. Never echo matched credential content.
const candidates = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], {encoding:'utf8'}).split('\0').filter(Boolean);
const rules = [
  ['provider credential', /\bsk-(?:or-v1-)?[a-zA-Z0-9_-]{24,}\b/],
  ['GitHub credential', /\b(?:gh[pousr]_[a-zA-Z0-9]{24,}|github_pat_[a-zA-Z0-9_]{30,})\b/],
  ['Google credential', /\bAIza[a-zA-Z0-9_-]{30,}\b/],
  ['Supabase server credential', /\bsb_secret_[a-zA-Z0-9_-]{15,}\b/],
  ['literal Speech credential', /AZURE_SPEECH_KEY\s*['"]?\s*[:=]\s*['"][a-fA-F0-9]{32,64}['"]/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
if (process.argv.includes('--build') && fs.existsSync('dist')) {
  for (const entry of fs.readdirSync('dist',{recursive:true,withFileTypes:true})) if(entry.isFile()) candidates.push(path.join(entry.parentPath,entry.name));
}
let checked=0;
const failures=[];
for(const file of new Set(candidates)){
  const name = path.basename(file);
  if ((name.startsWith('.env') && name !== '.env.example') || /\.(?:pem|key|p12|pfx)$/i.test(name)) {
    failures.push({ file, rule: 'environment or credential container must not be versioned or deployed' });
    continue; // Never open possible credential containers to report a finding.
  }
  if(!/\.(?:[cm]?[jt]sx?|vue|json|map|sql|toml|ya?ml|html|css|md|ps1|txt|env\.example)$/.test(file)||!fs.existsSync(file)) continue;
  const text=fs.readFileSync(file,'utf8');checked++;
  for(const [name,pattern] of rules) if(pattern.test(text))failures.push({file,rule:name});
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+\b/g)) {
    try {
      if (JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')).role === 'service_role') {
        failures.push({ file, rule: 'privileged Supabase JWT' }); break;
      }
    } catch { /* Non-JWT text is not evidence of a credential. */ }
  }
}
if(failures.length){console.error(JSON.stringify({status:'FAIL',files:failures}));process.exitCode=1;}
else console.log(`Secret-pattern scan passed: ${checked} source/build text files. Pattern scanning does not replace independent security review.`);
