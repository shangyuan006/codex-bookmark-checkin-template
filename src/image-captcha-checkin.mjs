import { recognizeAlphanumericCaptcha } from './captcha-ocr.mjs';

// The adapter supplies the exact response path and completion reader. Keep
// response bodies and recognized characters in memory only.
export async function submitImageCaptcha(page, { image, input, submit, origin, responsePath,
  readImage, reserve, readCompletion, recognize = recognizeAlphanumericCaptcha,
  classifyRejection = () => false, minConfidence = 60,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), length = 6 }) {
  const diagnostics = { requestCount: 0, responseCount: 0, responseSuccessCount: 0, responseErrorCount: 0 };
  let verificationRejectedCount = 0, requestFailed = false, invalidResponse = false;
  const tasks = new Set();
  const matches = request => {
    try { const url = new URL(request.url());
      return url.origin === origin && url.pathname === responsePath && request.method() === 'POST';
    } catch { return false; }
  };
  const requestHandler = request => { if (matches(request)) diagnostics.requestCount++; };
  const responseHandler = response => {
    if (!matches(response.request())) return;
    diagnostics.responseCount++;
    diagnostics.responseStatus = response.status();
    const task = (async () => {
      const json = await response.json().catch(() => null);
      if (response.status() === 200 && json?.state === 'success') diagnostics.responseSuccessCount++;
      else {
        diagnostics.responseErrorCount++;
        if (!json || typeof json !== 'object') invalidResponse = true;
        else {
          try { if (classifyRejection(json, response.status()) === true) verificationRejectedCount++; }
          catch { invalidResponse = true; }
        }
      }
    })();
    tasks.add(task); void task.finally(() => tasks.delete(task));
  };
  const failedHandler = request => { if (matches(request)) requestFailed = true; };
  const finish = result => ({ ...result, captchaDiagnostics: { ...diagnostics } });
  const recognition = await recognize(await readImage(image), { minLength: length, maxLength: length });
  diagnostics.recognizedLength = String(recognition?.code ?? '').length;
  diagnostics.recognitionConfidence = Math.max(0, Math.min(100, Math.round(Number(recognition?.confidence) || 0)));
  if (!new RegExp(`^[A-Z0-9]{${length}}$`).test(recognition?.code ?? '')
    || !Number.isFinite(recognition?.confidence) || recognition.confidence < Math.max(55, Number(minConfidence) || 60)) {
    return finish({ status: 'interactive_challenge', reason: '图片验证码识别未达到提交要求' });
  }
  page.on('request', requestHandler); page.on('response', responseHandler); page.on('requestfailed', failedHandler);
  try {
    await input.fill(recognition.code);
    await reserve();
    await submit.click();
    await wait(2000);
    await Promise.allSettled([...tasks]);
    // Even an HTTP success must be followed by the site's stable completion
    // control. A click or an empty response never establishes completion.
    const completion = await readCompletion({ serverSuccess: diagnostics.responseSuccessCount === 1 });
    if (['signed', 'already_signed'].includes(completion?.status)) return finish(completion);
    const rejected = diagnostics.requestCount === 1 && diagnostics.responseCount === 1
      && verificationRejectedCount === 1 && diagnostics.responseSuccessCount === 0
      && !requestFailed && !invalidResponse && tasks.size === 0;
    if (rejected) return finish({ status: 'interactive_challenge', submissionAttempted: true,
      failureCode: 'image_captcha_rejected', retryable: false,
      reason: '站点明确拒绝了图片验证码，尚未签到',
      captchaRejection: { submissionsFrozen: false, allRejected: true, requestFailed: false,
        requestCount: 1, rejectionCount: 1, verificationRejectionCount: 1, pendingResponseCount: 0 } });
    return finish({ status: 'interactive_challenge', submissionAttempted: true,
      failureCode: 'image_captcha_submission_unconfirmed', retryable: false,
      reason: '图片验证码已提交，但页面尚未确认签到完成' });
  } finally {
    page.off('request', requestHandler); page.off('response', responseHandler); page.off('requestfailed', failedHandler);
    await Promise.allSettled([...tasks]);
  }
}
