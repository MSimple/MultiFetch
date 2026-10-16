'use strict';

// Extension i18n. Two locales (zh-CN / en) with en fallback, matching the
// desktop app's approach. The active locale follows the browser UI language by
// default and can be pinned in the options page (settings.locale = 'auto' |
// 'zh-CN' | 'en'). Loaded into the service worker, popup and options page via
// importScripts / <script>; UMD wrapper keeps it node-testable.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.DMQ = Object.assign(root.DMQ || {}, { i18n: factory(root) });
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  const CATALOGS = {
    'zh-CN': {
      'ext.name': 'downloadmgr Capture',
      'popup.selectAll': '全选',
      'popup.deselectAll': '取消全选',
      'popup.clear': '清空',
      'popup.send': '发送到应用',
      'popup.takeover': '接管浏览器下载（视频 / 音频 / 安装包…）',
      'popup.options': '选项 / 配对 / 接管规则…',
      'popup.empty': '本页暂未嗅探到资源。播放视频、点击下载链接后再打开这里。',
      'popup.appOffline': '应用未运行',
      'popup.online': '应用在线 · 端口 {0}',
      'popup.unpaired': '未配对',
      'popup.sentCount': '已发送 {0} 项',
      'popup.queuedCount': '应用未运行，已暂存 {0} 项',
      'popup.sendFailed': '发送失败',
      'popup.unknownSize': '未知大小',

      'cat.video': '视频',
      'cat.audio': '音频',
      'cat.archive': '压缩包',
      'cat.program': '程序/安装包',
      'cat.document': '文档',
      'cat.model': '大模型',
      'cat.image': '图片',
      'cat.file': '文件',

      'popup.search.placeholder': '搜索名称或链接…',
      'popup.filter.all': '全部',
      'popup.noMatch': '没有匹配的资源',
      'popup.sort.order': '默认顺序',
      'popup.sort.size': '大小',
      'popup.sort.name': '名称',
      'popup.sort.type': '类型',

      'options.title': 'downloadmgr Capture 选项',
      'options.subtitle': '浏览器捕获与下载接管设置',
      'options.pair.title': '配对',
      'options.pair.auto': '连接应用（自动配对）',
      'options.pair.autoHint': '应用正在运行即可，无需配对码',
      'options.pair.manualHint':
        '自动配对不可用时（应用里关闭了该功能、或本扩展被撤销），到桌面应用「设置 → 浏览器捕获」生成配对码，在下方输入（5 分钟内有效）。',
      'options.pair.code': '配对码（手动）',
      'options.pair.pairBtn': '配对',
      'options.pair.port': '端口',
      'options.pair.portHint': '应用默认 8787；扩展会在 {0}–{1} 范围内自动发现应用。',
      'options.pair.token': '令牌（手动粘贴）',
      'options.takeover.title': '下载接管',
      'options.takeover.hint':
        '开启后，浏览器里触发的下载会交给应用下载（仅在应用在线且已配对时生效；应用不在时浏览器照常下载）。',
      'options.takeover.enable': '接管下载',
      'options.takeover.categories': '接管类别',
      'options.takeover.customExt': '追加扩展名',
      'options.takeover.customExtPlaceholder': '如 psd, sketch（逗号分隔）',
      'options.takeover.minSize': '体积下限（MB，0 为不限）',
      'options.takeover.ignore': '排除列表（每行一个域名或 URL 片段：不嗅探、不接管）',
      'options.locale': '界面语言',
      'options.locale.auto': '跟随浏览器',
      'options.save': '保存',
      'options.saved': '已保存',
      'options.restore': '恢复默认',
      'options.restoreConfirm': '恢复下载接管的默认设置？配对与端口不受影响。',
      'options.status.online': '应用在线（端口 {0}）',
      'options.status.pairedSuffix': ' · 已配对',
      'options.status.unpairedSuffix': ' · 未配对',
      'options.status.offline': '应用未运行',
      'options.connected': '已连接（端口 {0}）',
      'options.revoked': '本扩展已被撤销：请用下方配对码手动恢复',
      'options.autopairDisabled': '应用已关闭自动配对：请用下方配对码',
      'options.connectFailed': '连接失败：{0}',
      'options.needCode': '请输入 6 位配对码',
      'options.paired': '配对成功（端口 {0}）',
      'options.badCode': '配对码错误或已过期',
      'options.pairFailed': '配对失败：{0}',

      'menu.downloadLink': '用 downloadmgr 下载此链接',
      'menu.sendPage': '把本页资源全部发给 downloadmgr',
      'menu.takeover': '接管下载（视频 / 音频 / 安装包…）',

      'notify.noResources': '本页暂未嗅探到资源。播放视频或点击下载后再试。',
      'notify.takeoverOn': '已开启下载接管',
      'notify.takeoverOff': '已关闭下载接管',
      'notify.unpaired.title': 'downloadmgr：未配对',
      'notify.unpaired.body':
        '自动配对未成功。请在应用「设置→浏览器捕获」生成配对码，在扩展选项页手动配对。',
      'notify.offline.title': 'downloadmgr：应用未运行',
      'notify.offline.body': '已暂存 {0} 项并尝试启动应用，稍后自动送达。',
      'notify.sent.title': '已发送到 downloadmgr',
      'notify.sent.many': '已发送 {0} 个资源',

      'content.downloadVideo': '⬇ 下载该视频',
      'content.sending': '发送中…',
      'content.sent': '已发送 ✓',
      'content.sendFailed': '发送失败',
    },
    en: {
      'ext.name': 'downloadmgr Capture',
      'popup.selectAll': 'Select all',
      'popup.deselectAll': 'Deselect all',
      'popup.clear': 'Clear',
      'popup.send': 'Send to app',
      'popup.takeover': 'Take over browser downloads (video / audio / installers…)',
      'popup.options': 'Options / pairing / rules…',
      'popup.empty': 'No resources sniffed on this page yet. Play a video or click a download link, then reopen.',
      'popup.appOffline': 'App not running',
      'popup.online': 'App online · port {0}',
      'popup.unpaired': 'Not paired',
      'popup.sentCount': 'Sent {0} item(s)',
      'popup.queuedCount': 'App offline, queued {0} item(s)',
      'popup.sendFailed': 'Send failed',
      'popup.unknownSize': 'Unknown size',

      'cat.video': 'Video',
      'cat.audio': 'Audio',
      'cat.archive': 'Archive',
      'cat.program': 'Program',
      'cat.document': 'Document',
      'cat.model': 'Model',
      'cat.image': 'Image',
      'cat.file': 'File',

      'popup.search.placeholder': 'Search name or URL…',
      'popup.filter.all': 'All',
      'popup.noMatch': 'No matching resources',
      'popup.sort.order': 'Default',
      'popup.sort.size': 'Size',
      'popup.sort.name': 'Name',
      'popup.sort.type': 'Type',

      'options.title': 'downloadmgr Capture options',
      'options.subtitle': 'Browser capture & download takeover settings',
      'options.pair.title': 'Pairing',
      'options.pair.auto': 'Connect app (auto-pair)',
      'options.pair.autoHint': 'Just needs the app running — no code required',
      'options.pair.manualHint':
        'If auto-pair is unavailable (disabled in the app, or this extension was revoked), generate a code in the desktop app\u2019s Settings \u2192 Browser capture and enter it below (valid 5 minutes).',
      'options.pair.code': 'Pairing code (manual)',
      'options.pair.pairBtn': 'Pair',
      'options.pair.port': 'Port',
      'options.pair.portHint': 'App default 8787; the extension auto-discovers within {0}\u2013{1}.',
      'options.pair.token': 'Token (paste manually)',
      'options.takeover.title': 'Download takeover',
      'options.takeover.hint':
        'When on, downloads started in the browser are handed to the app (only while the app is online and paired; otherwise the browser downloads as usual).',
      'options.takeover.enable': 'Take over downloads',
      'options.takeover.categories': 'Categories',
      'options.takeover.customExt': 'Extra extensions',
      'options.takeover.customExtPlaceholder': 'e.g. psd, sketch (comma-separated)',
      'options.takeover.minSize': 'Minimum size (MB, 0 = no limit)',
      'options.takeover.ignore': 'Exclude list (one hostname or URL fragment per line: never sniff, never take over)',
      'options.locale': 'Interface language',
      'options.locale.auto': 'Follow browser',
      'options.save': 'Save',
      'options.saved': 'Saved',
      'options.restore': 'Restore defaults',
      'options.restoreConfirm': 'Restore default download-takeover settings? Pairing and port are kept.',
      'options.status.online': 'App online (port {0})',
      'options.status.pairedSuffix': ' · paired',
      'options.status.unpairedSuffix': ' · not paired',
      'options.status.offline': 'App not running',
      'options.connected': 'Connected (port {0})',
      'options.revoked': 'This extension was revoked: recover with the code below',
      'options.autopairDisabled': 'Auto-pair is disabled in the app: use the code below',
      'options.connectFailed': 'Connect failed: {0}',
      'options.needCode': 'Enter the 6-digit code',
      'options.paired': 'Paired (port {0})',
      'options.badCode': 'Wrong or expired code',
      'options.pairFailed': 'Pairing failed: {0}',

      'menu.downloadLink': 'Download this link with downloadmgr',
      'menu.sendPage': 'Send all page resources to downloadmgr',
      'menu.takeover': 'Take over downloads (video / audio / installers…)',

      'notify.noResources': 'No resources sniffed on this page. Play a video or click a download, then retry.',
      'notify.takeoverOn': 'Download takeover enabled',
      'notify.takeoverOff': 'Download takeover disabled',
      'notify.unpaired.title': 'downloadmgr: not paired',
      'notify.unpaired.body':
        'Auto-pair failed. Generate a code in the app\u2019s Settings \u2192 Browser capture and pair manually on the options page.',
      'notify.offline.title': 'downloadmgr: app not running',
      'notify.offline.body': 'Queued {0} item(s) and tried to launch the app; they\u2019ll be delivered shortly.',
      'notify.sent.title': 'Sent to downloadmgr',
      'notify.sent.many': 'Sent {0} items',

      'content.downloadVideo': '⬇ Download this video',
      'content.sending': 'Sending…',
      'content.sent': 'Sent ✓',
      'content.sendFailed': 'Send failed',
    },
  };

  const FALLBACK = 'en';
  let locale = FALLBACK;

  function normalize(l) {
    const s = String(l || '').toLowerCase();
    if (s.startsWith('zh')) return 'zh-CN';
    return FALLBACK;
  }

  function browserLang() {
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n && chrome.i18n.getUILanguage) {
        return chrome.i18n.getUILanguage();
      }
    } catch {
      /* not an extension context */
    }
    try {
      return navigator.language;
    } catch {
      return FALLBACK;
    }
  }

  /** Resolve a stored preference ('auto' | locale) to a concrete locale. */
  function pick(pref) {
    return !pref || pref === 'auto' ? browserLang() : pref;
  }

  function setLocale(l) {
    locale = normalize(l);
    return locale;
  }

  function current() {
    return locale;
  }

  function t(key, ...args) {
    const table = CATALOGS[locale] || {};
    let s = table[key];
    if (s === undefined) s = CATALOGS[FALLBACK][key];
    if (s === undefined) s = key;
    args.forEach((a, i) => {
      s = s.split(`{${i}}`).join(String(a));
    });
    return s;
  }

  /** Fill [data-i18n*] nodes under root (default: document). */
  function fill(root) {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return;
    for (const node of scope.querySelectorAll('[data-i18n]')) node.textContent = t(node.getAttribute('data-i18n'));
    for (const node of scope.querySelectorAll('[data-i18n-title]')) node.title = t(node.getAttribute('data-i18n-title'));
    for (const node of scope.querySelectorAll('[data-i18n-placeholder]')) {
      node.placeholder = t(node.getAttribute('data-i18n-placeholder'));
    }
    for (const node of scope.querySelectorAll('[data-i18n-aria-label]')) {
      node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
    }
  }

  /** Read the stored preference (if storage is present) and apply it. */
  async function init() {
    try {
      const s = await root.DMQ.storage.getSettings();
      setLocale(pick(s.locale));
    } catch {
      setLocale(pick(null));
    }
    return locale;
  }

  return { t, setLocale, current, pick, init, normalize, fill, CATALOGS };
});
