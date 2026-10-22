import { readAfterNavigation } from './page-state-read.mjs';

const MIGRATED = /(?:本站|本网站|本網站|站点|站點|网站|網站|域名|服务|服務)\s*(?:已经|已經|已)\s*(?:迁移|遷移|搬迁|搬遷|更换|更換)|\b(?:site|website|domain|service)\s+(?:has\s+)?(?:been\s+)?(?:moved|migrated|relocated)\b/i;
const REDIRECT_COPY = /自动跳转|自動跳轉|新(?:的)?(?:地址|网址|網址|域名)|前往新|automatically redirect|new (?:address|domain|website)/i;
const MIGRATION_LEAD = /^(?:本站|本网站|本網站|站点|站點|网站|網站|域名|服务|服務|(?:this\s+)?(?:site|website|domain|service)\b)/i;

function originOnly(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function requiresBookmarkReview(result) {
  return ['site_migration', 'bookmark_origin_changed'].includes(result?.failureCode);
}

export function siteMigrationResult({ title = '', bodyText = '', url = '', destinationOrigins = [] } = {}) {
  const body = String(bodyText).replace(/\s+/g, ' ').trim();
  // A historical migration announcement inside an otherwise normal console
  // must not hide its check-in controls. Require a migration title or a short,
  // dedicated migration page with an explicit new-address/redirect message.
  if (!MIGRATED.test(String(title).slice(0, 300))
    && !(body.length <= 2000 && MIGRATION_LEAD.test(body) && MIGRATED.test(body.slice(0, 250)) && REDIRECT_COPY.test(body))) return null;
  const observedOrigin = originOnly(url);
  const destinations = [...new Set(destinationOrigins.map(originOnly).filter(origin => origin && origin !== observedOrigin))];
  return {
    status: 'needs_attention', failureCode: 'site_migration', retryable: false,
    reason: '页面明确提示站点已迁移；请核对并更新收藏地址，不自动登录或签到迁移目标',
    ...(observedOrigin ? {url:observedOrigin} : {}),
    ...(destinations.length === 1 ? {migration:{destinationOrigin:destinations[0]}} : {}),
  };
}

export function unapprovedBookmarkRedirect(rawUrl, target) {
  const observedOrigin = originOnly(rawUrl);
  if (observedOrigin && (target.allowedOrigins ?? [target.origin]).includes(observedOrigin)) return null;
  return {
    status: 'needs_attention', failureCode: 'bookmark_origin_changed', retryable: false,
    reason: '页面已跳转到收藏夹目标未授权的域名；请先核对收藏地址，不转入自动登录或人工登录窗口',
    ...(observedOrigin ? {migration:{destinationOrigin:observedOrigin}} : {}),
  };
}

export async function inspectSiteMigrationPage(page, target) {
  const redirected = unapprovedBookmarkRedirect(page.url(), target);
  if (redirected) return redirected;
  try {
    const snapshot = await readAfterNavigation(page, () => page.evaluate(() => {
      const destinations = [...document.querySelectorAll('a[href]')].slice(0, 40).map(link => {
        try {
          const url = new URL(link.href);
          return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : null;
        } catch { return null; }
      }).filter(Boolean);
      return {title:document.title, bodyText:(document.body?.innerText ?? '').slice(0, 30001),
        url:location.origin, destinationOrigins:[...new Set(destinations)]};
    }));
    return unapprovedBookmarkRedirect(page.url(), target) ?? siteMigrationResult(snapshot);
  } catch (error) {
    const redirect = unapprovedBookmarkRedirect(page.url(), target);
    if (redirect) return redirect;
    throw error;
  }
}
