import { reconcileCheckinResult } from './checkin-evidence.mjs';

// Adapters own protocol/UI facts. This boundary owns reconciliation and metrics.
export async function runCheckinAdapter(adapter, context, {now=Date.now}={}) {
  const started=now();
  const capability=await adapter.detect(context);
  if(capability?.supported!==true) return {fallback:true,metrics:{adapter:adapter.id,durationMs:now()-started,requests:capability?.requests??0,pageLoads:0}};
  const observation=await adapter.execute(context,capability);
  const verified=await adapter.verify(observation,context);
  const result=reconcileCheckinResult(verified);
  return {result,fallback:!result&&!observation?.submissionAttempted,metrics:{adapter:adapter.id,durationMs:now()-started,requests:observation?.requests??capability.requests??0,pageLoads:0}};
}
