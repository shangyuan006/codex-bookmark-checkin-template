import { CHECKIN_CONTRACT } from './checkin-contract.generated.mjs';

const categories = new Set(['connection_failed', 'target_missing', 'target_unavailable',
  'page_unstable', 'process_timeout', 'process_failed', 'invalid_output', 'inspection_failed']);
const phases = new Set(['connection', 'page_selection', 'page_observation', 'process', 'output']);
const reasons = {
  connection_failed: '无法连接项目浏览器，保留窗口等待接续',
  target_missing: '项目浏览器中未找到目标标签页，未重新打开或提交',
  target_unavailable: '目标标签页暂时不可用，保留会话等待复核',
  page_unstable: '目标页面在限定时间内未稳定，保留窗口等待复核',
  process_timeout: '同页接续进程超时，保留提交保护和项目窗口',
  process_failed: '同页接续进程异常退出，保留提交保护和项目窗口',
  invalid_output: '同页接续进程未返回有效结果，保留提交保护和项目窗口',
  inspection_failed: '同页接续检查异常，保留提交保护和项目窗口',
};

export function nativeInspectionError(category, phase) {
  const error = new Error('Native inspection failed');
  error.inspectionCategory = categories.has(category) ? category : 'inspection_failed';
  error.inspectionPhase = phases.has(phase) ? phase : 'page_observation';
  return error;
}

export function nativeInspectionFailure(error, phase = 'process') {
  const category = categories.has(error?.inspectionCategory) ? error.inspectionCategory
    : error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'process_failed'
      : error?.killed === true || error?.code === 'ETIMEDOUT' ? 'process_timeout'
        : Number.isInteger(error?.code) || ['ENOENT', 'EPERM', 'EACCES'].includes(error?.code)
          ? 'process_failed' : 'inspection_failed';
  const diagnostics = { category,
    phase: phases.has(error?.inspectionPhase) ? error.inspectionPhase : phases.has(phase) ? phase : 'process' };
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255) diagnostics.exitCode = error.code;
  // Never include messages, stdout, stderr, stacks, URLs or command arguments.
  return { status: 'needs_attention', failureCode: `manual_continuation_${category}`,
    reason: reasons[category], retryable: false, continuationDiagnostics: diagnostics };
}

export function parseNativeInspectionOutput(stdout) {
  let result;
  try { result = JSON.parse(stdout); } catch { throw nativeInspectionError('invalid_output', 'output'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || ![...CHECKIN_CONTRACT.statuses, 'ready', 'not_signed'].includes(result.status)) {
    throw nativeInspectionError('invalid_output', 'output');
  }
  return result;
}
