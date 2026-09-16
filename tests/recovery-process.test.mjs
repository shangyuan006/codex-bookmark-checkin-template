import test from 'node:test';
import assert from 'node:assert/strict';
import {runRecoveryProcess,terminateRecoveryTree,captureRecoveryTree} from '../src/recovery-process.mjs';
test('recovery captures output and preserves successful completion',async()=>{
  const result=await runRecoveryProcess(process.execPath,['-e','process.stdout.write("completed")'],{timeout:5000});
  assert.equal(result.stdout,'completed');
});
test('timeout closes the browser before terminating the helper and its descendants',async()=>{
  const order=[];
  let failure;
  await assert.rejects(runRecoveryProcess(process.execPath,['-e',`
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid); setInterval(()=>{},1000);
  `],{timeout:1500,beforeTerminate:async()=>order.push('close-browser'),terminateTree:async pid=>{
    order.push('terminate-tree'); await terminateRecoveryTree(pid);
  }}),error=>{failure=error;return error.code==='ETIMEDOUT'&&!error.cleanupFailed;});
  assert.deepEqual(order,['close-browser','terminate-tree']);
  const pid=Number(failure.stdout.trim());
  assert.ok(pid>0);
  let alive=true;
  for(let i=0;i<20&&alive;i++){
    try{process.kill(pid,0);await new Promise(resolve=>setTimeout(resolve,50));}catch{alive=false;}
  }
  assert.equal(alive,false,'timed-out helper must not leave its descendant running');
});
test('failed graceful cleanup is exposed so callers cannot launch the next recovery',async()=>{
  await assert.rejects(runRecoveryProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{
    timeout:500,beforeTerminate:async()=>{throw new Error('occupied');},
  }),error=>error.code==='ETIMEDOUT'&&error.cleanupFailed===true);
});

test('a detached descendant is cleaned even when the parent exits during graceful cleanup', {skip:process.platform!=='win32'}, async()=>{
  let parentPid, failure;
  try {
    await assert.rejects(runRecoveryProcess(process.execPath,['-e',`
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
      child.unref(); console.log(child.pid); setInterval(()=>{},1000);
    `],{
      timeout:1500,
      captureTree:async pid=>{parentPid=pid;return captureRecoveryTree(pid);},
      beforeTerminate:async()=>{process.kill(parentPid);await new Promise(r=>setTimeout(r,300));},
    }),error=>{failure=error;return error.code==='ETIMEDOUT'&&!error.cleanupFailed;});
    const pid=Number(failure.stdout.trim());
    assert.ok(pid>0);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  } finally {
    const pid=Number(failure?.stdout?.trim());
    if(pid>0){try{process.kill(pid,0);await terminateRecoveryTree(pid);}catch{}}
  }
});
