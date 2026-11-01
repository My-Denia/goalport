import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPackage} from './verify-package.mjs';

export function successSummary(identity, reports) {
  if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(identity.version??'') || identity.status!=='PASS' || !/^[a-f0-9]{40}$/.test(identity.sourceRevision) || !/^[a-f0-9]{64}$/.test(identity.sourceTreeSha256)) throw Error('Verified package identity required');
  const hashes={};
  for(const name of ['GoalPort.exe','resources/app.asar','resources/goalport-core.exe']) {
    const hash=identity.artifacts.find(a=>a.path===name)?.sha256;
    if(!/^[a-f0-9]{64}$/.test(hash??''))throw Error('Package component hash missing');
    hashes[name]=hash;
  }
  for(const mode of ['normal','synthetic']) {
    const report=reports[mode];
    if(report?.mode!==(mode==='normal'?'normal':'synthetic-test'))throw Error('Smoke mode differs');
    if(report?.status!=='PASS'||report.identity?.sourceTreeSha256!==identity.sourceTreeSha256)throw Error('Smoke did not pass for this package');
    for(const [name,hash] of Object.entries(hashes))if(report.identity.artifacts?.find(a=>a.path===name)?.sha256!==hash)throw Error('Smoke package bytes differ');
  }
  return {schemaVersion:1,status:'PASS',version:identity.version,sourceRevision:identity.sourceRevision,sourceTreeSha256:identity.sourceTreeSha256,components:hashes,smoke:{normal:'PASS',synthetic:'PASS'},scope:'Packaged synthetic Runtime checks; not real provider acceptance'};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [pkg,normal,synthetic,out]=process.argv.slice(2);
  if(!out)throw Error('Usage: success-summary.mjs package normal-report synthetic-report output');
  const summary=successSummary(verifyPackage(pkg),{normal:JSON.parse(readFileSync(normal,'utf8')),synthetic:JSON.parse(readFileSync(synthetic,'utf8'))});
  writeFileSync(out,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
}
