import test from 'node:test';
import assert from 'node:assert/strict';
import {successSummary} from './success-summary.mjs';
const identity={version:'1.0.0-rc.1',status:'PASS',sourceRevision:'a'.repeat(40),sourceTreeSha256:'b'.repeat(64),artifacts:['GoalPort.exe','resources/app.asar','resources/goalport-core.exe'].map(path=>({path,sha256:'c'.repeat(64)}))};
test('success export binds package bytes and omits raw report fields',()=>{
 const report={status:'PASS',mode:'normal',identity,profile:'private-data-not-for-summary',events:['private-data-not-for-summary']};
 const summary=successSummary(identity,{normal:report,synthetic:{...report,mode:"synthetic-test"}});
 assert.equal(summary.smoke.normal,'PASS');
 assert.equal(JSON.stringify(summary).includes('private-data-not-for-summary'),false);
});
test('failure and a successful smoke from different bytes are refused',()=>{
 const normal={status:'PASS',mode:'normal',identity};
 assert.throws(()=>successSummary(identity,{normal,synthetic:{status:'FAIL',identity}}));
 const foreign=structuredClone(normal);foreign.mode='synthetic-test';foreign.identity.artifacts[0].sha256='d'.repeat(64);
 assert.throws(()=>successSummary(identity,{normal,synthetic:foreign}),/bytes differ/);
});

test('one normal report cannot stand in for synthetic smoke',()=>{const report={status:'PASS',mode:'normal',identity};assert.throws(()=>successSummary(identity,{normal:report,synthetic:report}),/mode differs/);});
