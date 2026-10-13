import { bindSuccessEvidence } from './checkin-evidence.mjs';
import { configuredSequentialActionTypes } from './sequential-action-evidence.mjs';

// Parent page text cannot attest to every configured action. Reuse the normal
// step verifier in read-only mode, with the same journal and evidence binding.
export async function bindNativeCompletion(result, target, config, verifySteps) {
  if (!['signed', 'already_signed'].includes(result?.status)) return result;
  const requiredActionTypes = configuredSequentialActionTypes(target.origin, config);
  if (requiredActionTypes != null) {
    const steps = await verifySteps?.({ ...config, checkinReadOnly: true });
    if (!steps || !['signed', 'already_signed'].includes(steps.status)) {
      return { ...result, ...steps, origin: target.origin, status: steps?.status ?? 'unconfirmed',
        requiredActionTypes, failureCode: steps?.failureCode ?? 'incomplete_sequential_evidence',
        reason: steps?.reason ?? '原生完成状态尚缺少顺序动作的只读核验证据' };
    }
    result = { ...result, actionResults: steps.actionResults, requiredActionTypes: steps.requiredActionTypes,
      submissionTrackedPerAction: steps.submissionTrackedPerAction,
      ...(steps.historicalSubmissionWarning ? { historicalSubmissionWarning: steps.historicalSubmissionWarning } : {}) };
  }
  return bindSuccessEvidence(result, target, config);
}
