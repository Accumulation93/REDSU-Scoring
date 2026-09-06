'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MINI_ROOT = path.join(ROOT, 'miniprogram');
const INTERACTIVE_ATTR = /\b(bindtap|catchtap|bindlongpress|catchlongpress)\s*=/;
const INPUT_TAGS = new Set(['input', 'textarea', 'picker', 'slider', 'switch', 'checkbox', 'radio']);
const VOID_TAGS = new Set(['input', 'textarea', 'image', 'icon', 'progress', 'slider', 'switch']);
const SHELL_NAMES = ['card', 'section', 'edit-box', 'list-card', 'popup-card', 'modal-card', 'sheet-panel'];
const NON_VISUAL_TARGET = /(mask|canvas|ghost|drag|handle|hit-area|physical-keyboard-capture)/;
const BANNED_COLORS = /#(?:1d4ed8|1e40af|172554)\b/gi;
const LEGACY_OVERLAYS = new Set(['popup-mask', 'modal-mask', 'dialog-layer', 'sheet-layer', 'ui-sheet-overlay']);
const LEGACY_DIALOG_SHELLS = new Set(['popup-card', 'modal-card', 'dialog-panel', 'sheet-panel']);
const LEGACY_COMPLEX_GRIDS = new Set(['task-table', 'result-table', 'popup-table']);
const STANDARD_BUTTON_ROLE = /\b(?:primary-btn|secondary-btn|danger-btn)\b/;
const FULL_SIZE_BUTTON_SELECTOR = /(?:^|[\s,>])button\b|\.(?:primary-btn|secondary-btn|danger-btn|approve-btn|reject-btn|profile-submit-btn|page-submit-btn|template-save-btn|purpose-save-btn|dialog-btn|sigpad-btn|panel-add-btn|hr-action-chip)\b/;
const TAB_RADIUS_SELECTOR = /(?:^|[\s,>])\.(?:tab|feature-tab|rules-tab|app-view-tab|message-tab|auth-tab|ui-tab)(?![A-Za-z0-9_-])/;
const FORBIDDEN_EMOJI_ICON = /(?:\u{1F4CE}|\u{1F4C4}|\u{1F4E4}|\u{1F504}|\u{270F}\u{FE0F}?|\u{2705}|\u{274C}|\u{1F4CC}|\u{21A9}\u{FE0F}?|\u{23F3}|\u{1F512}|\u{1F3C6}|\u{1F534}|\u{1F4AC})/gu;
const COMPACT_META_CLASSES = [
  'status-tag', 'booking-status', 'audit-chip', 'green-chip', 'blue-chip', 'orange-chip',
  'gray-chip', 'red-chip', 'mode-chip', 'venue-tag', 'flow-step-status-tag',
  'permission-count', 'permission-level', 'app-grid-badge', 'hero-badge', 'result-group-mode-chip',
  'action-btn', 'link', 'audit-link-btn', 'flow-action-btn', 'step-action-link',
  'pending-action-link', 'header-nav-btn', 'mark-all-read', 'placement-page-btn', 'cancel-btn',
  'filter-chip', 'chip', 'select-chip', 'grade-chip', 'dept-tab', 'role-pill',
  'audit-file-type', 'flow-separator-text', 'flow-round-badge', 'hero-org-context-action',
  'results-count-chip', 'merit-group-count', 'result-group-count', 'profile-field-type',
  'target-group-label', 'target-identity', 'target-status', 'nav-row-badge', 'dialog-badge',
  'message-switch-badge', 'notification-badge', 'notification-tag', 'portal-organization-meta',
  'message-action', 'message-text-action', 'sheet-link', 'approval-file-btn-preview',
  'approval-file-btn-sign', 'approval-file-btn-stamp', 'sig-source-use-btn', 'stamp-picker-select',
  'detail-status-chip', 'tpl-step-person-tag', 'tpl-step-preview-action', 'approval-designate-tag',
  'permission-hero-badge', 'identity-current-label', 'identity-scope-label', 'selection-status',
  'audit-cond-chip', 'clause-pill-meta', 'hr-import-preview-chip', 'info-chip', 'merit-chip',
  'merit-member-sid-chip', 'merit-summary-total-chip', 'merit-tag', 'preview-chip',
  'stat-card-tip', 'rule-tag', 'score-tag', 'score-label-toggle', 'template-chip', 'year-chip',
  'tl-tag', 'grade-band-bubble', 'profile-account-status', 'profile-session-count',
  'audit-home-card-badge', 'audit-home-card-badge-pending', 'audit-home-card-badge-history',
  'status-chip', 'invite-chip', 'hr-snapshot-type-tag', 'hr-snapshot-required-tag',
  'hr-template-status', 'template-hero-badge', 'hour-chip', 'min-chip', 'duration-chip', 'add-range-btn',
  'merit-edit-btn', 'mini-action-btn', 'placement-mini-btn', 'pending-refresh-btn',
  'tpl-step-toggle', 'rule-list-count', 'hr-member-select', 'csv-mapping-type-tag',
  've-error-type-tag', 'auth-select-box'
];
const COMPACT_META_SELECTOR = new RegExp(`\\.(?:${COMPACT_META_CLASSES.join('|')})\\b`, 'i');
const GLOBAL_STYLE = fs.readFileSync(path.join(MINI_ROOT, 'app.wxss'), 'utf8');
const GLOBAL_MEDIA_520 = /@media\s*\(min-width:\s*520px\)/.test(GLOBAL_STYLE);
const GLOBAL_MEDIA_900 = /@media\s*\(min-width:\s*900px\)/.test(GLOBAL_STYLE);

function hydrateGeneratedLocaleCopy(source, scriptFile) {
  const script = fs.readFileSync(scriptFile, 'utf8');
  const match = script.match(/const\s+localeCopy\s*=\s*require\(\s*(['"])([^'"]+)\1\s*\)/);
  if (!match) return source;
  const localeFile = require.resolve(path.resolve(path.dirname(scriptFile), match[2]));
  delete require.cache[localeFile];
  const localeCopy = require(localeFile);
  return source.replace(/\{\{\s*localeCopy\.([A-Za-z0-9_]+)\s*\}\}/g, (raw, key) => (
    Object.prototype.hasOwnProperty.call(localeCopy, key) ? String(localeCopy[key]) : raw
  ));
}

function scanCompactVisualContract() {
  const findings = [];
  const required = [
    ['手机状态标签舒适密度', /page \.status-tag,[\s\S]*?min-height:\s*46rpx\s*!important[\s\S]*?border-radius:\s*18rpx\s*!important/],
    ['手机文本操作舒适密度', /page text\.action-btn,[\s\S]*?min-height:\s*60rpx\s*!important[\s\S]*?border-radius:\s*18rpx\s*!important/],
    ['手机说明文字舒适行高', /page \.booking-meta,[\s\S]*?line-height:\s*1\.55\s*!important/],
    ['手机基础间距令牌', /--ui-page-padding-top:\s*30rpx[\s\S]*?--ui-page-padding-x:\s*24rpx[\s\S]*?--ui-card-radius:\s*30rpx/],
    ['Pad 竖屏间距令牌', /@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-page-padding-x:\s*22px[\s\S]*?--ui-card-radius:\s*18px/],
    ['Pad 横屏间距令牌', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-page-padding-x:\s*16px[\s\S]*?--ui-card-radius:\s*18px/],
    ['Pad 竖屏独立密度', /@media\s*\(min-width:\s*520px\)\s*and\s*\(max-width:\s*899px\),[\s\S]*?page \.status-tag,[\s\S]*?min-height:\s*28px\s*!important/],
    ['手机按钮圆角令牌', /--ui-control-radius:\s*28rpx/],
    ['手机紧凑控件圆角令牌', /--ui-compact-radius:\s*18rpx/],
    ['手机页签圆角令牌', /--ui-tab-radius:\s*24rpx/],
    ['Pad 竖屏按钮圆角令牌', /@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-control-radius:\s*14px/],
    ['Pad 竖屏紧凑控件圆角令牌', /@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-compact-radius:\s*12px/],
    ['Pad 竖屏页签圆角令牌', /@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-tab-radius:\s*12px/],
    ['Pad 横屏按钮圆角令牌', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-control-radius:\s*12px/],
    ['Pad 横屏紧凑控件圆角令牌', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-compact-radius:\s*11px/],
    ['Pad 横屏页签圆角令牌', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-tab-radius:\s*12px/],
    ['手机全尺寸按钮圆角终审', /page button,[\s\S]*?border-radius:\s*var\(--ui-control-radius,\s*28rpx\)\s*!important/],
    ['Pad 竖屏全尺寸按钮圆角终审', /@media\s*\(min-width:\s*520px\)\s*and\s*\(max-width:\s*899px\),[\s\S]*?page button,[\s\S]*?border-radius:\s*14px\s*!important/],
    ['Pad 横屏全尺寸按钮圆角终审', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?page button,[\s\S]*?border-radius:\s*12px\s*!important/],
    ['手机紧凑控件圆角终审', /page \.status-chip,[\s\S]*?border-radius:\s*var\(--ui-compact-radius,\s*18rpx\)\s*!important/],
    ['Pad 竖屏紧凑控件圆角终审', /page \.status-chip,[\s\S]*?border-radius:\s*12px\s*!important/],
    ['Pad 横屏紧凑控件圆角终审', /page \.status-chip,[\s\S]*?border-radius:\s*11px\s*!important/],
    ['横屏页签高度', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-tab-min-height:\s*50px/],
    ['横屏页签均分', /page \.tabs,[\s\S]*?display:\s*flex\s*!important[\s\S]*?width:\s*100%\s*!important/],
    ['横屏页签点击高度', /page \.tabs\s*>\s*\.tab,[\s\S]*?min-height:\s*50px\s*!important/]
  ];
  for (const [message, pattern] of required) {
    if (!pattern.test(GLOBAL_STYLE)) findings.push({ file: 'miniprogram/app.wxss', message });
  }

  const responsiveContracts = [
    ['miniprogram/subpackages/scoring/pages/admin/admin.wxss', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.auth-personnel-intro\s*\{[\s\S]*?padding:\s*14px 16px/],
    ['miniprogram/subpackages/main/styles/home.wxss', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.profile-security-note,[\s\S]*?padding:\s*14px 16px/],
    ['miniprogram/subpackages/org/pages/identitySwitch/identitySwitch.wxss', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.context-panel\s*\{[\s\S]*?padding:\s*14px 16px/],
    ['miniprogram/subpackages/audit/styles/blue-polish.wxss', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.audit-submission-item,[\s\S]*?padding:\s*12px 14px/],
    ['miniprogram/subpackages/venue/styles/blue-polish.wxss', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.venue-card,[\s\S]*?padding:\s*12px 14px/],
    ['miniprogram/subpackages/scoring/pages/scorerTasks/scorerTasks.wxss', /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.task-col,[\s\S]*?padding:\s*10px 12px/]
  ];
  for (const [file, pattern] of responsiveContracts) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!pattern.test(source)) findings.push({ file, message: '页面局部横屏密度未按设备独立收紧' });
  }

  const pageContracts = [
    [
      'miniprogram/subpackages/venue/pages/venueBooking/venueBooking.wxss',
      /\.duration-chip\.duration-chip-active\s*\{[\s\S]*?background:[^;]+!important[\s\S]*?color:\s*#ffffff\s*!important/,
      '场地快捷时长选中态必须保持蓝底白字，不能被通用白底规则覆盖'
    ],
    [
      'miniprogram/subpackages/main/styles/home.wxss',
      /\.audit-home-card\s*\{[\s\S]*?min-height:\s*108rpx[\s\S]*?padding:\s*22rpx 18rpx/,
      '审核首页入口卡片必须保留对称留白和足够高度'
    ]
  ];
  for (const [file, pattern, message] of pageContracts) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!pattern.test(source)) findings.push({ file, message });
  }

  const styles = walk(MINI_ROOT, '.wxss');
  for (const file of styles) {
    const source = fs.readFileSync(file, 'utf8');
    const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
    let ruleMatch;
    while ((ruleMatch = rulePattern.exec(source))) {
      const selector = ruleMatch[1].trim().replace(/\s+/g, ' ');
      const declarations = ruleMatch[2];
      const radiusMatch = declarations.match(/border-radius\s*:\s*([^;}]+)/i);
      if (radiusMatch && !selector.includes('::')) {
        const val = radiusMatch[1].trim().replace(/!important/gi, '').trim();
        if (val !== '0' && !/var\(/i.test(val) && !/^(?:999r?px|50%)$/i.test(val)) {
          const allowed = new Set();
          if (FULL_SIZE_BUTTON_SELECTOR.test(selector)) {
            allowed.add('28rpx'); allowed.add('14px'); allowed.add('12px');
          }
          if (TAB_RADIUS_SELECTOR.test(selector)) {
            allowed.add('24rpx'); allowed.add('12px');
          }
          if (COMPACT_META_SELECTOR.test(selector)) {
            allowed.add('18rpx'); allowed.add('12px'); allowed.add('11px');
          }
          const decorative = /arrow|chevron|close|clear|dot|node|indicator|spinner|skeleton|avatar|track|handle|mark|accent|step|progress|toggle|timeline|badge|member-select|select-box|pending-entry|time-valid/i.test(selector);
          if (allowed.size && !allowed.has(val) && !decorative) {
            findings.push({
              file: relative(file),
              line: lineAt(source, ruleMatch.index),
              selector,
              message: `控件固定圆角 ${val} 与设备档位不符，应使用令牌或 18rpx/12px/11px（按钮 28rpx/14px/12px，页签 24rpx/12px/12px）`
            });
          }
        }
      }
      if (!COMPACT_META_SELECTOR.test(selector)) continue;
      if (/border-radius\s*:\s*999(?:r?px)\b/i.test(declarations) &&
        !/page\s+(?:text\.)?(?:status-tag|action-btn)/i.test(selector)) {
        const coveredByGlobal = COMPACT_META_CLASSES.some(name => selector.includes(`.${name}`)) &&
          new RegExp(`page[^{}]*\\.${COMPACT_META_CLASSES.find(name => selector.includes(`.${name}`))}[^{}]*\\{[\\s\\S]*?border-radius:\\s*(?:var\\(--ui-compact-radius,[^}]*?\\)|18rpx|12px|11px)\\s*!important`, 'i').test(GLOBAL_STYLE);
        if (!coveredByGlobal) {
          findings.push({
            file: relative(file),
            line: lineAt(source, ruleMatch.index),
            selector,
            message: '文本状态或操作控件仍使用胶囊圆角，且没有全局紧凑规则覆盖'
          });
        }
      }
    }
  }
  return findings;
}

function walk(dir, extension, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, extension, out);
    else if (entry.name.endsWith(extension)) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function lineAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function attrValue(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`));
  return match ? match[2] : '';
}

function classify(tag, className, hoverClass) {
  if (tag === 'button') return 'button';
  if (INPUT_TAGS.has(tag)) return 'field';
  if (/(ui-press-button|button-pressing)/.test(hoverClass)) return 'button';
  if (/(ui-press-card|control-pressing)/.test(hoverClass)) return 'card';
  if (/(ui-press-chip|chip-pressing)/.test(hoverClass)) return 'chip';
  if (/(chip|tab|pill|tag)/.test(className)) return 'chip';
  if (/(card|item|row|entry|tile)/.test(className)) return 'card';
  if (/(link|action|close|clear|btn|button)/.test(className)) return 'inline-action';
  return 'unclassified';
}

function tokenizeWxml(source) {
  const tokens = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      if (end < 0) break;
      tokens.push({ raw: source.slice(start, end + 3), index: start });
      cursor = end + 3;
      continue;
    }
    if (!/[A-Za-z/!]/.test(source[start + 1] || '')) {
      cursor = start + 1;
      continue;
    }
    let quote = '';
    let end = -1;
    for (let index = start + 1; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        end = index;
        break;
      }
    }
    if (end < 0) break;
    const raw = source.slice(start, end + 1);
    tokens.push({ raw, index: start });
    if (/^<wxs\b/.test(raw)) {
      const wxsEnd = source.indexOf('</wxs>', end + 1);
      cursor = wxsEnd >= 0 ? wxsEnd : end + 1;
    } else {
      cursor = end + 1;
    }
  }
  return tokens;
}

function scanWxml(file) {
  const source = fs.readFileSync(file, 'utf8');
  const stack = [];
  const controls = [];
  for (const token of tokenizeWxml(source)) {
    const raw = token.raw;
    if (raw.startsWith('<!--')) continue;
    const close = raw.match(/^<\/([\w-]+)/);
    if (close) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === close[1]) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const start = raw.match(/^<([\w-]+)([\s\S]*?)\/?>(?:\s*)$/);
    if (!start) continue;
    const tag = start[1];
    const attrs = start[2] || '';
    const className = attrValue(attrs, 'class');
    const eventMatch = attrs.match(INTERACTIVE_ATTR);
    const nativeField = INPUT_TAGS.has(tag);
    const interactive = Boolean(eventMatch || nativeField || tag === 'button');
    const ancestor = [...stack].reverse().find(item => item.interactive);

    if (interactive) {
      const hoverClass = attrValue(attrs, 'hover-class');
      const eventType = eventMatch ? eventMatch[1] : tag === 'button' ? 'button' : 'native';
      const hoverStart = attrValue(attrs, 'hover-start-time');
      const hoverStay = attrValue(attrs, 'hover-stay-time');
      controls.push({
        file: relative(file),
        line: lineAt(source, token.index),
        tag,
        className,
        type: classify(tag, className, hoverClass),
        eventType,
        hoverClass,
        hoverStart,
        hoverStay,
        hoverStop: /\bhover-stop-propagation\s*=/.test(attrs),
        nonVisual: NON_VISUAL_TARGET.test(className),
        nestedIn: ancestor ? `${ancestor.tag}.${ancestor.className || '(no-class)'}` : '',
        nestedRisk: Boolean(ancestor && eventType === 'bindtap' && !/\bhover-stop-propagation\s*=/.test(attrs))
      });
    }

    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(tag);
    if (!selfClosing) stack.push({ tag, className, interactive });
  }
  return controls;
}

function classTokens(className) {
  return String(className || '').split(/\s+/).filter(Boolean);
}

function hasClass(className, target) {
  return classTokens(className).includes(target);
}

function ownsVisualSurface(className) {
  return classTokens(className).some(token => (
    token === 'card' ||
    token === 'section' ||
    token === 'edit-box' ||
    token === 'section-control-card' ||
    token.endsWith('-card') ||
    token.endsWith('-panel') ||
    token.endsWith('-surface')
  ));
}

function scanControlSurfaceContracts(file) {
  const source = fs.readFileSync(file, 'utf8');
  const stack = [];
  const findings = [];
  for (const token of tokenizeWxml(source)) {
    const raw = token.raw;
    if (raw.startsWith('<!--')) continue;
    const close = raw.match(/^<\/([\w-]+)/);
    if (close) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === close[1]) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const start = raw.match(/^<([\w-]+)([\s\S]*?)\/?>(?:\s*)$/);
    if (!start) continue;
    const tag = start[1];
    const attrs = start[2] || '';
    const className = attrValue(attrs, 'class');
    const parent = stack[stack.length - 1];
    const visualAncestor = [...stack].reverse().find(item => ownsVisualSurface(item.className));
    const inlineControlRow = [...stack].reverse().find(item => hasClass(item.className, 'ui-inline-control-row'));

    if (hasClass(className, 'section-title') && !visualAncestor) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '页面级 section-title 直接暴露，必须放入至少一层明确的卡片或玻璃控制表面'
      });
    }

    const groupedControl = ['section-title', 'tabs', 'tabs-card', 'toolbar-row', 'button-row', 'audit-filter-bar']
      .some(target => hasClass(className, target));
    if (parent && hasClass(parent.className, 'section-stack') && groupedControl) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: 'section-stack 的标题、页签或成组操作直接暴露，必须由 section-control-card 统一包裹'
      });
    }

    const legacyCardActionGroup = hasClass(className, 'list-actions') ||
      hasClass(className, 'list-actions-below') ||
      hasClass(className, 'rule-list-inline-actions') ||
      hasClass(className, 'hr-member-actions');
    if (legacyCardActionGroup && !hasClass(className, 'card-actions')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '卡片小操作必须使用 card-actions 统一操作行，不得继续保留页面私有排列'
      });
    }

    if (hasClass(className, 'time-filter-row') && !hasClass(className, 'ui-inline-control-row')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '同排日期/时间筛选必须使用 ui-inline-control-row 统一纵向基线'
      });
    }

    if (hasClass(className, 'range-row') && !hasClass(className, 'ui-inline-control-row')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '同排日期/时间范围控件必须使用 ui-inline-control-row，禁止混用完整表单与紧凑控件高度'
      });
    }

    if (hasClass(className, 'rule-filter-row') && !hasClass(className, 'ui-inline-field-row')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '带标签的同行筛选字段必须使用 ui-inline-field-row 对齐实际控件底边'
      });
    }

    if (inlineControlRow &&
        (hasClass(className, 'time-pick') || hasClass(className, 'filter-clear')) &&
        !hasClass(className, 'ui-inline-control')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '同排选择器与清除按钮必须使用 ui-inline-control 共享物理高度，禁止页面 margin 造成错位'
      });
    }

    if (hasClass(className, 'app-view-tabs') && !hasClass(className, 'ui-compact-segmented')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '标题行中的宫格/列表切换必须使用 ui-compact-segmented，不得占用主页签高度'
      });
    }

    if (parent && hasClass(parent.className, 'ui-compact-segmented') &&
        hasClass(className, 'app-view-tab') && !hasClass(className, 'ui-compact-segmented-item')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '紧凑分段切换子项必须使用 ui-compact-segmented-item 共享紧凑高度'
      });
    }

    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(tag);
    if (!selfClosing) stack.push({ tag, className });
  }
  return findings;
}

function scanSelectionCardContracts(file) {
  const source = fs.readFileSync(file, 'utf8');
  const stack = [];
  const findings = [];
  const informationClass = /(?:^|\s)(?:list-name|hr-member-name|eligible-assignment-chip|identity-chip|department-chip|work-group-chip|status-chip)(?:\s|$)/;

  for (const token of tokenizeWxml(source)) {
    const raw = token.raw;
    if (raw.startsWith('<!--')) continue;
    const close = raw.match(/^<\/([\w-]+)/);
    if (close) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag === close[1]) {
          stack.length = index;
          break;
        }
      }
      continue;
    }

    const start = raw.match(/^<([\w-]+)([\s\S]*?)\/?>(?:\s*)$/);
    if (!start) continue;
    const tag = start[1];
    const attrs = start[2] || '';
    const className = attrValue(attrs, 'class');
    const parent = stack[stack.length - 1];
    const selectionAncestor = [...stack].reverse().find(item => item.selectionCard);
    const nameAncestor = [...stack].reverse().find(item => (
      hasClass(item.className, 'list-name') ||
      hasClass(item.className, 'hr-member-name')
    ));

    if (parent && parent.selectionCard) {
      parent.directChildCount += 1;
      if (parent.directChildCount === 1 && !hasClass(className, 'selection-card-toggle')) {
        findings.push({
          file: relative(file),
          line: lineAt(source, token.index),
          message: 'selection-option-card 的第一个可见子项必须是左上 selection-card-toggle'
        });
      }
    }

    const isSelectionControl = hasClass(className, 'select-chip') || hasClass(className, 'hr-member-select');
    if (isSelectionControl && !hasClass(className, 'selection-card-toggle')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '卡片选择控件必须使用 selection-card-toggle，不能建立私有选择状态位置'
      });
    }
    if (isSelectionControl && nameAncestor) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '选择/取消控件禁止嵌入姓名文字，必须独立位于卡片左上'
      });
    }
    if (hasClass(className, 'selection-card-toggle') && !selectionAncestor) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: 'selection-card-toggle 必须属于 selection-option-card，禁止脱离卡片建立悬空选择控件'
      });
    }
    if (hasClass(className, 'selection-card-toggle') && /copy_78564bdb46|已选/.test(raw)) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '选中态操作文案必须是“取消”，不能使用只描述状态的“已选”'
      });
    }
    if (selectionAncestor && hasClass(className, 'card-actions')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '选择卡片禁止混入整行 card-actions/移除操作，取消必须复用左上选择控件'
      });
    }
    if (selectionAncestor && informationClass.test(className) && INTERACTIVE_ATTR.test(attrs) && !hasClass(className, 'selection-card-toggle')) {
      findings.push({
        file: relative(file),
        line: lineAt(source, token.index),
        message: '姓名、身份、部门、职能组、岗位或状态气泡只表达信息，禁止承担选择事件'
      });
    }

    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(tag);
    if (!selfClosing) {
      stack.push({
        tag,
        className,
        selectionCard: hasClass(className, 'selection-option-card'),
        directChildCount: 0
      });
    }
  }

  if (/eligible-assignment-chip-selected|selectedAssignmentPrefix/.test(source)) {
    findings.push({
      file: relative(file),
      message: '岗位信息气泡禁止保存或拼接选择状态；请使用左上 selection-card-toggle'
    });
  }
  return findings;
}

function scanVisibleInternalIds(file) {
  const source = fs.readFileSync(file, 'utf8');
  const tokens = tokenizeWxml(source);
  const findings = [];
  const directInternalIdPattern = /^\s*(?:[\w$]+\.)*(?:openid|hrId|fileId|adminId|departmentId|identityId|workGroupId|submissionId|bookingId|activityId)\s*$/;
  let cursor = 0;
  let insideWxs = false;

  for (const token of tokens) {
    if (!insideWxs && token.index > cursor) {
      const text = source.slice(cursor, token.index);
      for (const expression of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
        if (!directInternalIdPattern.test(expression[1])) continue;
        const offset = cursor + expression.index;
        findings.push({
          file: relative(file),
          line: lineAt(source, offset),
          expression: expression[0].replace(/\s+/g, ' ').trim()
        });
      }
    }

    if (/^<wxs\b/.test(token.raw)) insideWxs = true;
    if (/^<\/wxs\b/.test(token.raw)) insideWxs = false;
    cursor = token.index + token.raw.length;
  }

  return findings;
}

function scanStaticInlineStyles(file) {
  const source = fs.readFileSync(file, 'utf8');
  const findings = [];
  for (const match of source.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/g)) {
    if (/\{\{/.test(match[2])) continue;
    findings.push({
      file: relative(file),
      line: lineAt(source, match.index),
      style: match[2].replace(/\s+/g, ' ').trim()
    });
  }
  return findings;
}

function scanForbiddenEmojiIcons(file) {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(FORBIDDEN_EMOJI_ICON)].map(match => ({
    file: relative(file),
    line: lineAt(source, match.index),
    icon: match[0]
  }));
}

function scanAdminOrgContextContracts() {
  const pages = [
    {
      name: '评分管理',
      wxml: path.join(MINI_ROOT, 'subpackages', 'scoring', 'pages', 'admin', 'admin.wxml'),
      script: path.join(MINI_ROOT, 'subpackages', 'scoring', 'pages', 'admin', 'admin.js')
    },
    {
      name: '场地管理',
      wxml: path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'venueManage', 'venueManage.wxml'),
      script: path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'venueManage', 'venueManage.js')
    }
  ];
  const findings = [];
  for (const page of pages) {
    const markup = fs.readFileSync(page.wxml, 'utf8');
    const checks = [
      ['统一顶部身份卡', /<workspace-hero\b/],
      ['管理端视觉样式', /\btone="admin"/],
      ['工作台品牌名称', /\bapp-name=(?:"WHUSU智慧工作台"|"\{\{[^}]+\}\}")/]
    ];
    for (const [label, pattern] of checks) {
      if (!pattern.test(markup)) findings.push({ page: page.name, message: `缺少${label}` });
    }
  }
  const sharedHero = fs.readFileSync(
    path.join(MINI_ROOT, 'components', 'workspace-hero', 'workspace-hero.wxml'),
    'utf8'
  );
  const sharedHeroScript = fs.readFileSync(
    path.join(MINI_ROOT, 'components', 'workspace-hero', 'workspace-hero.js'),
    'utf8'
  );
  const sharedChecks = [
    ['统一顶部卡缺少姓名', /personName/],
    ['统一顶部卡缺少身份', /identityName/],
    ['统一顶部卡缺少组织', /organizationName/],
    ['统一顶部卡缺少切换入口', /catchtap="onSwitchTap"/],
    ['统一顶部卡未将姓名作为主标题', /class="workspace-person-name"[^>]*>\{\{personName\}\}/],
    ['统一顶部卡未将页面名称降为元数据', /class="workspace-page-name"/]
  ];
  for (const [message, pattern] of sharedChecks) {
    if (!pattern.test(sharedHero)) findings.push({ page: '统一顶部身份卡', message });
  }
  if (!/\/subpackages\/org\/pages\/identitySwitch\/identitySwitch/.test(sharedHeroScript)) {
    findings.push({ page: '统一顶部身份卡', message: '切换入口未指向组织与身份页面' });
  }
  if (/personInitial|workspace-person-avatar|workspace-brand-mark/.test(sharedHero + sharedHeroScript)) {
    findings.push({ page: '统一顶部身份卡', message: '禁止首字头像或装饰性品牌方块' });
  }
  return findings;
}

function scanWorkspaceShellContracts() {
  const config = JSON.parse(fs.readFileSync(path.join(MINI_ROOT, 'app.json'), 'utf8'));
  const routes = [...(config.pages || [])];
  for (const subpackage of config.subPackages || []) {
    for (const page of subpackage.pages || []) routes.push(`${subpackage.root}/${page}`);
  }
  const heroExceptions = new Set([
    'subpackages/main/pages/login/login',
    'subpackages/org/pages/switch/switch',
    'subpackages/venue/pages/venueBookings/venueBookings'
  ]);
  const findings = [];

  for (const route of routes) {
    const jsonFile = path.join(MINI_ROOT, `${route}.json`);
    const wxmlFile = path.join(MINI_ROOT, `${route}.wxml`);
    const scriptFile = path.join(MINI_ROOT, `${route}.js`);
    const pageConfig = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const script = fs.readFileSync(scriptFile, 'utf8');
    const hasStaticTitle = /^.+ - WHUSU智慧工作台$/.test(pageConfig.navigationBarTitleText || '');
    const hasLocaleRuntimeTitle = !pageConfig.navigationBarTitleText &&
      /wx\.setNavigationBarTitle\s*\(\s*\{[\s\S]{0,320}?\btitle\s*:/.test(script);
    if (!hasStaticTitle && !hasLocaleRuntimeTitle) {
      findings.push({
        file: relative(jsonFile),
        message: '页面标题必须使用“子应用名称 - WHUSU智慧工作台”'
      });
    }
    if (heroExceptions.has(route)) continue;
    const markup = fs.readFileSync(wxmlFile, 'utf8');
    if (!/<workspace-hero\b[^>]*\bapp-name=(?:"WHUSU智慧工作台"|"\{\{[^}]+\}\}")/.test(markup)) {
      findings.push({
        file: relative(wxmlFile),
        message: '业务页面缺少统一顶部身份卡'
      });
    }
  }

  const portalStyleFile = path.join(MINI_ROOT, 'subpackages', 'main', 'pages', 'portal', 'portal.wxss');
  const portalStyle = fs.readFileSync(portalStyleFile, 'utf8');
  const padStart = portalStyle.indexOf('@media (min-width: 520px)');
  const landscapeStart = portalStyle.indexOf('@media (min-width: 900px)');
  const phoneStyle = portalStyle.slice(0, padStart);
  const padStyle = portalStyle.slice(padStart, landscapeStart);
  const landscapeStyle = portalStyle.slice(landscapeStart);
  const gridChecks = [
    ['手机宫格必须铺满三列', phoneStyle, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/],
    ['Pad 竖屏宫格必须铺满四列', padStyle, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/],
    ['Pad 横屏宫格必须铺满五列', landscapeStyle, /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/]
  ];
  for (const [message, source, pattern] of gridChecks) {
    if (!pattern.test(source)) findings.push({ file: relative(portalStyleFile), message });
  }
  return findings;
}

function scanVenueFlowVisibilityContract() {
  const file = path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'venueManage', 'venueManage.wxml');
  const scriptFile = path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'venueManage', 'venueManage.js');
  const source = hydrateGeneratedLocaleCopy(fs.readFileSync(file, 'utf8'), scriptFile);
  const findings = [];
  const checks = [
    ['借用规则页缺少审批流程列表', /approvalFlows/],
    ['借用规则页未说明暂无审批流程', /暂无审批流程/],
    ['借用规则页缺少“指定第一步审批人”独立开关', /data-field="allow_designate_first"/],
    ['借用规则页缺少“指定下一步审批人”独立开关', /data-field="allow_designate_next"/]
  ];
  for (const [message, pattern] of checks) {
    if (!pattern.test(source)) findings.push({ file: relative(file), message });
  }
  if (/allow_designate_first[^\n]*\|\|[^\n]*allow_designate_next|allow_designate_next[^\n]*\|\|[^\n]*allow_designate_first/.test(source)) {
    findings.push({ file: relative(file), message: '第一步与下一步指定权限不得合并为同一显示或交互条件' });
  }

  const venueDetailFile = path.join(MINI_ROOT, 'subpackages', 'venue', 'components', 'venueBookingDetail', 'venueBookingDetail.wxml');
  const venueDetailJsonFile = path.join(MINI_ROOT, 'subpackages', 'venue', 'components', 'venueBookingDetail', 'venueBookingDetail.json');
  const venueDetailStyleFile = path.join(MINI_ROOT, 'subpackages', 'venue', 'components', 'venueBookingDetail', 'venueBookingDetail.wxss');
  const auditDetailFile = path.join(MINI_ROOT, 'subpackages', 'audit', 'pages', 'submissionDetail', 'submissionDetail.wxml');
  const sharedStyleFile = path.join(MINI_ROOT, 'subpackages', 'main', 'styles', 'home.wxss');
  const venueDetailSource = fs.readFileSync(venueDetailFile, 'utf8');
  const venueDetailConfig = JSON.parse(fs.readFileSync(venueDetailJsonFile, 'utf8'));
  const venueDetailStyle = fs.readFileSync(venueDetailStyleFile, 'utf8');
  const auditDetailSource = fs.readFileSync(auditDetailFile, 'utf8');
  const sharedStyleSource = fs.readFileSync(sharedStyleFile, 'utf8');
  const expandedClassPattern = /class="[^"]*\bflow-info\b[^"]*\bflow-info-expanded\b/;
  if (!expandedClassPattern.test(venueDetailSource)) {
    findings.push({ file: relative(venueDetailFile), message: '场地借用详情必须把展开状态直接写到可视 flow-info 卡片' });
  }
  if (venueDetailConfig.styleIsolation !== 'apply-shared') {
    findings.push({ file: relative(venueDetailJsonFile), message: '场地借用详情组件必须通过 apply-shared 接收页面级流程卡样式' });
  }
  if (/^\s*@import\s+['"][^'"]*(?:home|blue-polish)\.wxss['"]/m.test(venueDetailStyle)) {
    findings.push({ file: relative(venueDetailStyleFile), message: '自定义详情组件不得导入整份页面级 WXSS，应通过 apply-shared 接收共享样式' });
  }
  if (!expandedClassPattern.test(auditDetailSource)) {
    findings.push({ file: relative(auditDetailFile), message: '审核详情必须把展开状态直接写到可视 flow-info 卡片' });
  }

  const flowMarkupFiles = [
    auditDetailFile,
    venueDetailFile,
    path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'pendingVenueApprovals', 'pendingVenueApprovals.wxml'),
    path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'venueBooking', 'venueBooking.wxml'),
    path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'venueManage', 'venueManage.wxml')
  ];
  for (const flowFile of flowMarkupFiles) {
    const flowSource = fs.readFileSync(flowFile, 'utf8');
    const stack = [];
    for (const token of tokenizeWxml(flowSource)) {
      const raw = token.raw;
      if (raw.startsWith('<!--')) continue;
      const close = raw.match(/^<\/([\w-]+)/);
      if (close) {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          if (stack[index].tag !== close[1]) continue;
          stack.length = index;
          break;
        }
        continue;
      }
      const start = raw.match(/^<([\w-]+)/);
      if (!start) continue;
      const classes = new Set(classList(raw));
      if (classes.has('flow-expand-detail') && !stack.some(item => item.classes.has('flow-info'))) {
        findings.push({
          file: relative(flowFile),
          line: flowSource.slice(0, token.index).split(/\r?\n/).length,
          message: '流程卡展开详情必须位于同一张 flow-info 可视卡片内部'
        });
      }
      if (!/\/\>\s*$/.test(raw)) stack.push({ tag: start[1], classes });
    }
    if (/class="[^"]*\bflow-info-comment\b/.test(flowSource)) {
      findings.push({ file: relative(flowFile), message: '审批意见只能在展开详情内显示，收起态不得重复展示' });
    }
  }
  if (!/\.flow-info\.flow-info-expanded\s*\{/.test(sharedStyleSource) ||
      !/\.flow-node\.flow-node-expanded\s*>\s*\.flow-info/.test(sharedStyleSource)) {
    findings.push({ file: relative(sharedStyleFile), message: '共享流程卡缺少稳定覆盖状态色的展开态选择器' });
  }
  const duplicateFlowStyles = walk(MINI_ROOT, '.wxss').filter(styleFile => {
    if (styleFile === sharedStyleFile) return false;
    const styleSource = fs.readFileSync(styleFile, 'utf8');
    return /^\s*\.flow-info\.flow-info-expanded\s*\{|^\s*\.flow-expand-detail\s*\{/m.test(styleSource);
  });
  for (const duplicateFile of duplicateFlowStyles) {
    findings.push({ file: relative(duplicateFile), message: '流程卡展开样式只能在 main/styles/home.wxss 维护，业务页面不得复制' });
  }
  return findings;
}

function scanLegacyRedirectUi() {
  const directory = path.join(MINI_ROOT, 'subpackages', 'venue', 'pages', 'venueBookings');
  const scriptFile = path.join(directory, 'venueBookings.js');
  const markupFile = path.join(directory, 'venueBookings.wxml');
  const script = fs.readFileSync(scriptFile, 'utf8');
  const markup = fs.readFileSync(markupFile, 'utf8');
  const significantLines = markup.split(/\r?\n/).filter(line => line.trim()).length;
  const findings = [];
  if (!/wx\.redirectTo\(\{\s*url:\s*['"]\/subpackages\/venue\/pages\/venueManage\/venueManage\?tab=bookings['"]/.test(script)) {
    findings.push({ file: relative(scriptFile), message: '旧借用管理入口未跳转到统一管理页' });
  }
  if (significantLines > 12 || /\bwx:for\b/.test(markup) || /\b(?:approve|reject|loadBookings)\b/.test(markup)) {
    findings.push({ file: relative(markupFile), message: '纯跳转页仍残留旧管理界面' });
  }
  return findings;
}

function classList(raw) {
  const match = raw.match(/\bclass\s*=\s*(["'])([\s\S]*?)\1/);
  return match ? match[2].split(/\s+/).filter(Boolean) : [];
}

function scanLayoutContracts(file) {
  const source = fs.readFileSync(file, 'utf8');
  const stack = [];
  const dialogs = [];
  const overlays = [];
  const dialogIssues = [];
  const dataLayoutIssues = [];
  const scrollContractIssues = [];
  const redundantDialogSingleSection = [];

  for (const token of tokenizeWxml(source)) {
    const raw = token.raw;
    if (raw.startsWith('<!--')) continue;
    const close = raw.match(/^<\/([\w-]+)/);
    if (close) {
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index].tag !== close[1]) continue;
        const item = stack[index];
        if (item.contentSurface && !item.contentSurface.isStack &&
          item.contentSurface.directElementChildren === 1 &&
          item.contentSurface.directSections === 1) {
          redundantDialogSingleSection.push({
            file: relative(file),
            line: item.contentSurface.line,
            message: '普通弹窗正文不得只包裹一张同质分区卡；单一表单或详情由正文表面直接承载'
          });
        }
        if (item.overlay) {
          const overlay = item.overlay;
          if (!overlay.hasBlocker) overlay.issues.push('弹窗遮罩缺少独立的全屏触摸阻断层');
          if (!overlay.hasShell) overlay.issues.push('弹窗遮罩缺少位于阻断层上方的窗口外壳');
          if (overlay.blockerIndex != null && overlay.shellIndex != null && overlay.blockerIndex > overlay.shellIndex) {
            overlay.issues.push('触摸阻断层必须位于窗口外壳之前，且与窗口外壳保持同级');
          }
          for (const message of overlay.issues) {
            scrollContractIssues.push({ file: relative(file), line: overlay.line, message });
          }
          overlays.push(overlay);
        }
        if (item.dialog) {
          const dialog = item.dialog;
          const modifiers = ['ui-dialog-shell--compact', 'ui-dialog-shell--complex', 'ui-dialog-shell--wide']
            .filter(name => dialog.classes.has(name));
          const isSignatureCanvasDialog = dialog.classes.has('signature-popup-card');
          if (!isSignatureCanvasDialog && modifiers.length !== 1) dialog.issues.push('弹窗必须且只能声明一个尺寸修饰符');
          const requiresStructure = isSignatureCanvasDialog || dialog.classes.has('ui-dialog-shell--complex') || dialog.classes.has('ui-dialog-shell--wide');
          if (requiresStructure && !dialog.hasHeader) dialog.issues.push('复杂弹窗缺少 ui-dialog-header');
          if (requiresStructure && !dialog.hasBody) dialog.issues.push('复杂弹窗缺少 ui-dialog-body');
          if (dialog.hasBody && !dialog.hasContentSurface) dialog.issues.push('弹窗正文缺少 ui-dialog-content 内容表面');
          if (dialog.classes.has('ui-dialog-shell--compact') && !dialog.hasBody && !dialog.hasCompactContent) {
            dialog.issues.push('短弹窗必须使用 ui-dialog-compact-content 包裹正文');
          }
          for (const message of dialog.issues) {
            dialogIssues.push({ file: relative(file), line: dialog.line, message, className: [...dialog.classes].join(' ') });
          }
          dialogs.push({
            file: relative(file),
            line: dialog.line,
            className: [...dialog.classes].join(' '),
            hasHeader: dialog.hasHeader,
            hasBody: dialog.hasBody,
            hasFooter: dialog.hasFooter
          });
        }
        stack.length = index;
        break;
      }
      continue;
    }

    const open = raw.match(/^<([\w-]+)/);
    if (!open || raw.startsWith('<!')) continue;
    const tag = open[1];
    const classes = new Set(classList(raw));
    const line = lineAt(source, token.index);
    const directParent = stack[stack.length - 1];
    const dialogAncestor = [...stack].reverse().find(item => item.dialog);
    const overlayAncestor = [...stack].reverse().find(item => item.overlay);
    const scrollAncestor = [...stack].reverse().find(item => item.tag === 'scroll-view');

    if (directParent?.contentSurface) {
      directParent.contentSurface.directElementChildren += 1;
      if (classes.has('ui-dialog-section')) directParent.contentSurface.directSections += 1;
    }

    if (tag === 'root-portal') {
      if (relative(file) !== 'miniprogram/components/viewport-portal/viewport-portal.wxml' || !/\benable="\{\{true\}\}"/.test(raw)) {
        dialogIssues.push({ file: relative(file), line, message: '业务页面不得直接声明 root-portal，必须通过按需创建的 viewport-portal 使用', className: '' });
      }
    }
    if (tag === 'viewport-portal' && !/\bwx:if=/.test(raw)) {
      dialogIssues.push({ file: relative(file), line, message: 'viewport-portal 必须直接带 wx:if，关闭弹窗时销毁整个原生脱离层', className: '' });
    }

    if ([...classes].some(name => LEGACY_OVERLAYS.has(name)) &&
      !classes.has('ui-overlay') && !classes.has('ui-sheet-overlay')) {
      dialogIssues.push({ file: relative(file), line, message: '弹窗遮罩缺少 ui-overlay', className: [...classes].join(' ') });
    }
    const isLoginSheet = relative(file) === 'miniprogram/subpackages/main/pages/login/login.wxml' && classes.has('ui-sheet-overlay');
    const isSignatureCanvasOverlay = classes.has('signature-pad-overlay');
    if ((classes.has('ui-overlay') || classes.has('ui-sheet-overlay')) &&
      !isLoginSheet && !isSignatureCanvasOverlay && !stack.some(item => item.tag === 'root-portal' || item.tag === 'viewport-portal')) {
      dialogIssues.push({ file: relative(file), line, message: '弹窗必须由按需创建的 root-portal 提升到页面根层，不能跟随页面滚动', className: [...classes].join(' ') });
    }
    if (isSignatureCanvasOverlay && stack.some(item => item.tag === 'root-portal' || item.tag === 'viewport-portal')) {
      dialogIssues.push({ file: relative(file), line, message: '签名 Canvas 弹窗禁止进入 Portal，必须直接位于页面根节点固定遮罩中', className: [...classes].join(' ') });
    }

    let overlay = null;
    if (classes.has('ui-overlay') || classes.has('ui-sheet-overlay')) {
      overlay = {
        line,
        classes,
        hasBlocker: false,
        hasShell: false,
        blockerIndex: null,
        shellIndex: null,
        issues: []
      };
    } else if (overlayAncestor) {
      const currentOverlay = overlayAncestor.overlay;
      if (classes.has('ui-overlay-blocker')) {
        currentOverlay.hasBlocker = true;
        currentOverlay.blockerIndex = token.index;
        if (stack[stack.length - 1]?.overlay !== currentOverlay) {
          currentOverlay.issues.push(`第 ${line} 行的全屏阻断层必须是遮罩的直接子级`);
        }
        if (tag !== 'view' || !/\bcatchtouchmove\s*=\s*(["'])noop\1/.test(raw)) {
          currentOverlay.issues.push(`第 ${line} 行的全屏阻断层必须使用 view + catchtouchmove=\"noop\"`);
        }
      }
      if (classes.has('ui-dialog-shell') || classes.has('signature-popup-card')) {
        currentOverlay.hasShell = true;
        currentOverlay.shellIndex = token.index;
        if (stack[stack.length - 1]?.overlay !== currentOverlay) {
          currentOverlay.issues.push(`第 ${line} 行的窗口外壳必须与全屏阻断层同级`);
        }
      }
    }

    let dialog = null;
    if (classes.has('ui-dialog-shell') || classes.has('signature-popup-card') || [...classes].some(name => LEGACY_DIALOG_SHELLS.has(name))) {
      dialog = {
        line,
        classes,
        hasHeader: false,
        hasBody: false,
        hasFooter: false,
        hasContentSurface: false,
        hasCompactContent: false,
        issues: classes.has('ui-dialog-shell') || classes.has('signature-popup-card') ? [] : ['弹窗壳缺少 ui-dialog-shell']
      };
    } else if (dialogAncestor) {
      const current = dialogAncestor.dialog;
      if (classes.has('ui-dialog-header')) current.hasHeader = true;
      if (classes.has('ui-dialog-body')) current.hasBody = true;
      if (classes.has('ui-dialog-content')) current.hasContentSurface = true;
      if (classes.has('ui-dialog-compact-content')) current.hasCompactContent = true;
      if (classes.has('ui-dialog-footer')) {
        current.hasFooter = true;
        if (scrollAncestor) current.issues.push(`第 ${line} 行操作栏位于 scroll-view 内`);
      }
    }

    const contentSurface = classes.has('ui-dialog-content') ? {
      line,
      isStack: classes.has('ui-dialog-content--stack'),
      directElementChildren: 0,
      directSections: 0
    } : null;

    if ([...classes].some(name => LEGACY_COMPLEX_GRIDS.has(name)) && !classes.has('ui-data-grid--complex')) {
      dataLayoutIssues.push({ file: relative(file), line, message: '复杂数据表缺少 ui-data-grid--complex' });
    }
    if (classes.has('timetable-scroll') && !classes.has('ui-data-grid--specialized')) {
      dataLayoutIssues.push({ file: relative(file), line, message: '专业时间网格缺少 ui-data-grid--specialized' });
    }

    if ((classes.has('ui-overlay') || classes.has('ui-dialog-shell')) &&
      /\bcatchtouchmove\s*=/.test(raw) && !classes.has('ui-dialog-touch-lock')) {
      scrollContractIssues.push({ file: relative(file), line, message: '弹窗遮罩或外壳不得拦截主体触摸移动' });
    }

    if (tag === 'scroll-view' && classes.has('ui-dialog-body')) {
      const modifiers = ['ui-dialog-scroll--fill', 'ui-dialog-scroll--pane', 'ui-dialog-scroll--x', 'ui-dialog-scroll--both']
        .filter(name => classes.has(name));
      const hasScrollX = /\sscroll-x(?:\s*=|\s|\/?\>)/.test(raw);
      const hasScrollY = /\sscroll-y(?:\s*=|\s|\/?\>)/.test(raw);
      const hasEnhanced = /\benhanced\s*=\s*(["'])\{\{true\}\}\1/.test(raw);
      const hasNestedScroll = /\bnested-scroll-enabled\s*=\s*(["'])\{\{true\}\}\1/.test(raw);
      if (modifiers.length !== 1) {
        scrollContractIssues.push({ file: relative(file), line, message: '弹窗 scroll-view 必须且只能声明一种滚动视口类型' });
      } else if (modifiers[0] === 'ui-dialog-scroll--x' && (!hasScrollX || hasScrollY)) {
        scrollContractIssues.push({ file: relative(file), line, message: '横向滚动视口必须只启用 scroll-x' });
      } else if (modifiers[0] === 'ui-dialog-scroll--both' && (!hasScrollX || !hasScrollY)) {
        scrollContractIssues.push({ file: relative(file), line, message: '专业双向滚动视口必须同时启用 scroll-x 和 scroll-y' });
      } else if (['ui-dialog-scroll--fill', 'ui-dialog-scroll--pane'].includes(modifiers[0]) && !hasScrollY) {
        scrollContractIssues.push({ file: relative(file), line, message: '纵向滚动视口必须启用 scroll-y' });
      }
      if (hasScrollY && (!hasEnhanced || !hasNestedScroll)) {
        scrollContractIssues.push({
          file: relative(file),
          line,
          message: '弹窗纵向滚动区必须启用 enhanced 与 nested-scroll-enabled，保证内层列表优先滚动'
        });
      }
    }

    const selfClosing = raw.endsWith('/>') || VOID_TAGS.has(tag);
    if (!selfClosing) stack.push({ tag, dialog, overlay, contentSurface, conditional: /\bwx:if="\{\{[^}]+\}\}"/.test(raw) });
  }

  return { dialogs, overlays, dialogIssues, dataLayoutIssues, scrollContractIssues, redundantDialogSingleSection };
}

function scanWxss(file) {
  const source = fs.readFileSync(file, 'utf8');
  const shellActive = [];
  const nativeInputFlex = [];
  const unsafeControlEllipsis = [];
  const fixedDataColumns = [];
  const pillButtonRadius = [];
  const stackedButtonMetrics = [];
  const forcedDialogViewport = [];
  const miscenteredDialogShell = [];
  const misalignedTitleAccent = [];
  const rawFontSizes = [];
  const oversizedDecorativeHero = [];
  const forcedContentViewport = [];
  const oversizedContentPadding = [];
  const flattenedDialogSurfaces = [];
  const duplicateDialogWrapperSurfaces = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let ruleMatch;
  while ((ruleMatch = rulePattern.exec(source))) {
    const selector = ruleMatch[1];
    const declarations = ruleMatch[2];
    if (/(?:detail-popup-form|form-body|detail-body|ui-dialog-content)/i.test(selector) &&
      /padding\s*:\s*0(?:\s|;|$)/i.test(declarations) &&
      /background\s*:\s*(?:none|transparent)/i.test(declarations) &&
      /border\s*:\s*(?:none|0)/i.test(declarations)) {
      flattenedDialogSurfaces.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' '),
        message: '弹窗正文分区不得同时清空内边距、背景和边框，避免内容贴边且失去层级'
      });
    }
    if (/\.(?:detail-popup-form|form-body|detail-body)\b/i.test(selector)) {
      const visualSurfaceProperties = [
        /padding\s*:/i,
        /background\s*:/i,
        /border(?:-radius)?\s*:/i,
        /box-shadow\s*:/i
      ].filter(pattern => pattern.test(declarations)).length;
      if (visualSurfaceProperties >= 3) {
        duplicateDialogWrapperSurfaces.push({
          file: relative(file),
          line: lineAt(source, ruleMatch.index),
          selector: selector.trim().replace(/\s+/g, ' '),
          message: '弹窗单一表单或详情包裹层不得重新绘制与正文同质的卡片表面'
        });
      }
    }
    if (
      /\.(?:section-title|list-title|profile-field-title|merit-group-label|rule-panel-title)::before\b/.test(selector) &&
      /content\s*:\s*["']{2}/.test(declarations) &&
      /position\s*:\s*absolute/.test(declarations) &&
      !/display\s*:\s*none/.test(declarations) &&
      (!/top\s*:\s*50%/.test(declarations) || !/transform\s*:\s*translateY\(-50%\)/.test(declarations))
    ) {
      misalignedTitleAccent.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' '),
        message: '标题左侧色条必须相对完整标题块垂直居中，不能使用固定顶部偏移'
      });
    }
    for (const fontSize of declarations.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/gi)) {
      rawFontSizes.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index + fontSize.index),
        selector: selector.trim().replace(/\s+/g, ' '),
        value: `${fontSize[1]}${fontSize[2]}`,
        message: '可见文字和字形必须使用统一语义字阶，禁止页面局部裸写 rpx/px 破坏跨设备比例'
      });
    }
    const ordinaryContentShell = /(card|panel|section|wrapper|wrap|container|hero|banner)/i.test(selector) &&
      !/(^|[\s,>])(?:page|\.page)\b|::(?:before|after)|timetable|signature|canvas|keyboard|ui-data-grid|ui-dialog-scroll|preview|placement/i.test(selector);
    if (ordinaryContentShell) {
      for (const dimension of declarations.matchAll(/(?:^|;)\s*(height|min-height)\s*:\s*(\d+(?:\.\d+)?)(r?px|vh)\b/gi)) {
        const value = Number(dimension[2]);
        const unit = dimension[3].toLowerCase();
        const tooLarge = (unit === 'rpx' && value >= 240) ||
          (unit === 'px' && value >= 180) ||
          (unit === 'vh' && value >= 35);
        if (!tooLarge) continue;
        forcedContentViewport.push({
          file: relative(file),
          line: lineAt(source, ruleMatch.index + dimension.index),
          selector: selector.trim().replace(/\s+/g, ' '),
          value: `${dimension[1]}: ${dimension[2]}${dimension[3]}`,
          message: '普通包裹型控件不得用大块固定/最小高度制造空白，应由内容自然撑开'
        });
      }
      for (const padding of declarations.matchAll(/padding-(top|bottom)\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/gi)) {
        const value = Number(padding[2]);
        const unit = padding[3].toLowerCase();
        if ((unit === 'rpx' && value < 96) || (unit === 'px' && value < 64)) continue;
        oversizedContentPadding.push({
          file: relative(file),
          line: lineAt(source, ruleMatch.index + padding.index),
          selector: selector.trim().replace(/\s+/g, ' '),
          value: `padding-${padding[1]}: ${padding[2]}${padding[3]}`,
          message: '普通包裹型控件不得用异常大的单侧内边距制造无信息空区'
        });
      }
    }
    if (/\.field-input\b/.test(selector) && /display\s*:\s*flex\b/i.test(declarations)) {
      nativeInputFlex.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' ')
      });
    }
    if (/text-overflow\s*:\s*ellipsis\b/i.test(declarations) &&
      /(button|\bbtn\b|picker|action|\btab\b|title|name|result-group-label|app-grid-label|primary-btn|secondary-btn|danger-btn|ui-data-cell--primary|ui-data-cell--action|csv-mapping-primary-text|csv-mapping-picker-value)/i.test(selector)) {
      unsafeControlEllipsis.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' ')
      });
    }
    if (/(csv-mapping-col|task-col|result-col|popup-col)/i.test(selector) &&
      /flex\s*:\s*0\s+0\s+(?:\d+(?:\.\d+)?)(?:r?px)\b/i.test(declarations)) {
      fixedDataColumns.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' ')
      });
    }
    if (FULL_SIZE_BUTTON_SELECTOR.test(selector) &&
      /border-radius\s*:\s*(?:999(?:r?px)|50%)\b/i.test(declarations)) {
      pillButtonRadius.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' '),
        message: '原生文字按钮禁止使用胶囊/圆形半径，请改为 24–28rpx（Pad 11–14px）柔和圆角矩形'
      });
    }
    if (FULL_SIZE_BUTTON_SELECTOR.test(selector)) {
      const minHeight = declarations.match(/min-height\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/i);
      const lineHeight = declarations.match(/line-height\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/i);
      const fixedHeight = declarations.match(/(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/i);
      const paddingShorthand = declarations.match(/(?:^|;)\s*padding\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/i);
      const paddingTop = declarations.match(/padding-top\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/i);
      const paddingBottom = declarations.match(/padding-bottom\s*:\s*(\d+(?:\.\d+)?)(r?px)\b/i);
      const hasFixedVerticalPadding = [paddingShorthand, paddingTop, paddingBottom]
        .some(match => match && Number(match[1]) > 0);
      if (fixedHeight && lineHeight && hasFixedVerticalPadding && fixedHeight[2] === lineHeight[2]) {
        const height = Number(fixedHeight[1]);
        const line = Number(lineHeight[1]);
        if (line >= height * 0.75) {
          stackedButtonMetrics.push({
            file: relative(file),
            line: lineAt(source, ruleMatch.index),
            selector: selector.trim().replace(/\s+/g, ' '),
            message: '文字按钮不得同时设置接近按钮高度的固定行高和非零上下内边距；文本盒会溢出或形成异常留白'
          });
        }
      } else if (minHeight && lineHeight && !fixedHeight && minHeight[2] === lineHeight[2]) {
        const minimum = Number(minHeight[1]);
        const line = Number(lineHeight[1]);
        const absoluteFloor = minHeight[2] === 'px' ? 28 : 44;
        if (line >= absoluteFloor && line >= minimum * 0.75) {
          stackedButtonMetrics.push({
            file: relative(file),
            line: lineAt(source, ruleMatch.index),
            selector: selector.trim().replace(/\s+/g, ' '),
            message: '文字按钮不得用接近最小高度的固定行高；它会与继承的上下内边距叠加并形成异常高按钮'
          });
        }
      }
    }
    if (/(popup|modal|dialog|sheet)/i.test(selector) &&
      /(?:^|;)\s*height\s*:\s*(?:\d+(?:\.\d+)?vh|calc\(\s*100vh\b)/i.test(declarations) &&
      !/(timetable|placement|signature|canvas|keyboard|ui-dialog-shell--wide|ui-dialog-shell--viewport|ui-dialog-scroll--both|sheet-mask|^\s*\.sheet\s*$)/i.test(selector)) {
      forcedDialogViewport.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' '),
        message: '普通内容弹窗不得强制占据固定视口高度；应按内容生长并只在溢出时滚动'
      });
    }
    const isViewportAnchoredDialog = /\.ui-overlay\s*>?\s*\.ui-dialog-shell\b/i.test(selector) &&
      /position\s*:\s*fixed\b/i.test(declarations) &&
      /(?:top\s*:\s*50vh|left\s*:\s*50vw|transform\s*:\s*translate\(\s*-?50%)/i.test(declarations);
    if (/(?:\.ui-dialog-shell\b|\.dialog-panel\b|\.message-switch-dialog\b|\.permission-dialog\b|\.popup-card\b|\.modal-card\b)/i.test(selector) &&
      /position\s*:\s*(?:absolute|fixed)\b/i.test(declarations) &&
      /(?:left|right|inset|transform)\s*:/i.test(declarations) &&
      !isViewportAnchoredDialog &&
      !/(sheet-panel|timetable|placement|signature|canvas|keyboard)/i.test(selector)) {
      miscenteredDialogShell.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' '),
        message: '居中弹窗壳不得自行使用绝对定位或横向锚点；水平和垂直居中必须只由 ui-overlay 负责'
      });
    }
    const transformValue = declarations.match(/transform\s*:\s*([^;]+)/i);
    const animationValue = declarations.match(/animation(?:-name)?\s*:\s*([^;]+)/i);
    const hasMotion = Boolean(
      (transformValue && !/^none\b/i.test(transformValue[1].trim())) ||
      (animationValue && !/^none\b/i.test(animationValue[1].trim()))
    );
    const clearsCenteredDialogTransform = Boolean(
      transformValue && /^none\b/i.test(transformValue[1].trim()) &&
      /\.(?:popup-card|modal-card):active\b/i.test(selector)
    );
    if (clearsCenteredDialogTransform) {
      shellActive.push({
        file: relative(file),
        line: lineAt(source, ruleMatch.index),
        selector: selector.trim().replace(/\s+/g, ' '),
        message: '弹窗按下时不得清除用于视口居中的 transform'
      });
    }
    if (!hasMotion) continue;
    for (const shell of SHELL_NAMES) {
      const pattern = new RegExp(`\\.${shell.replace('-', '\\-')}:active`);
      if (pattern.test(selector)) {
        shellActive.push({
          file: relative(file),
          line: lineAt(source, ruleMatch.index),
          selector: `.${shell}:active`
        });
      }
    }
  }

  for (const media of source.matchAll(/@media\s*\(min-width:\s*900px\)\s*\{([\s\S]*?)(?=\n@media|\s*$)/g)) {
    const mediaBody = media[1];
    const heroRule = /([^{}]*(?:hero|banner|welcome)[^{}]*)\{([^{}]*)\}/gi;
    let heroMatch;
    while ((heroMatch = heroRule.exec(mediaBody))) {
      const declarations = heroMatch[2];
      const forcedHeight = declarations.match(/(?:min-)?height\s*:\s*(\d+(?:\.\d+)?)px\b/i);
      if (!forcedHeight || Number(forcedHeight[1]) < 240) continue;
      oversizedDecorativeHero.push({
        file: relative(file),
        line: lineAt(source, media.index + heroMatch.index),
        selector: heroMatch[1].trim().replace(/\s+/g, ' '),
        value: `${forcedHeight[1]}px`,
        message: 'Pad 横屏装饰性 Hero 不得强占大块固定高度，应由内容和紧凑内边距决定高度'
      });
    }
  }

  return {
    file: relative(file),
    important: (source.match(/!important/g) || []).length,
    transitionAll: (source.match(/transition\s*:\s*all/g) || []).length,
    willChange: (source.match(/will-change\s*:/g) || []).length,
    illegalColors: [...source.matchAll(BANNED_COLORS)].map(match => ({
      file: relative(file),
      line: lineAt(source, match.index),
      color: match[0].toLowerCase()
    })),
    media520: /@media\s*\(min-width:\s*520px\)/.test(source),
    media900: /@media\s*\(min-width:\s*900px\)/.test(source),
    shellActive,
    nativeInputFlex,
    unsafeControlEllipsis,
    fixedDataColumns,
    pillButtonRadius,
    stackedButtonMetrics,
    forcedDialogViewport,
    miscenteredDialogShell,
    misalignedTitleAccent,
    rawFontSizes,
    oversizedDecorativeHero,
    forcedContentViewport,
    oversizedContentPadding,
    flattenedDialogSurfaces,
    duplicateDialogWrapperSurfaces,
    oversizedTimetable: [...source.matchAll(/\.timetable-scroll\s*\{[^{}]*height\s*:\s*(\d{3,})rpx/gi)]
      .filter(match => Number(match[1]) >= 900)
      .map(match => ({ file: relative(file), line: lineAt(source, match.index), height: match[1] + 'rpx' }))
  };
}

const wxmlFiles = walk(MINI_ROOT, '.wxml');
const controls = wxmlFiles.flatMap(scanWxml);
const controlSurfaceIssues = wxmlFiles.flatMap(scanControlSurfaceContracts);
const selectionCardIssues = wxmlFiles.flatMap(scanSelectionCardContracts);
const personnelPickerBase = path.join(MINI_ROOT, 'components', 'personnel-picker', 'personnel-picker');
const personnelPickerMarkup = fs.readFileSync(`${personnelPickerBase}.wxml`, 'utf8');
const personnelPickerStyle = fs.readFileSync(`${personnelPickerBase}.wxss`, 'utf8');
const personnelPickerPages = [
  'subpackages/audit/pages/submissionDetail/submissionDetail',
  'subpackages/scoring/pages/admin/admin',
  'subpackages/workspace/pages/home/home',
  'subpackages/venue/pages/venueBooking/venueBooking',
  'subpackages/venue/pages/pendingVenueApprovals/pendingVenueApprovals'
];
if (!/<viewport-portal\b/.test(personnelPickerMarkup) ||
    !/class="ui-overlay-blocker"\s+catchtouchmove="noop"/.test(personnelPickerMarkup) ||
    !/class="[^"]*personnel-picker-shell[^"]*popup-card[^"]*ui-dialog-shell/.test(personnelPickerMarkup) ||
    !/class="[^"]*personnel-picker-header[^"]*popup-header[^"]*ui-dialog-header/.test(personnelPickerMarkup) ||
    !/class="[^"]*personnel-picker-close[^"]*popup-close/.test(personnelPickerMarkup) ||
    !/class="[^"]*ui-dialog-body[^"]*"/.test(personnelPickerMarkup) ||
    !/class="[^"]*ui-dialog-footer[^"]*"/.test(personnelPickerMarkup) ||
    !/class="select-chip[^\"]*selection-card-toggle/.test(personnelPickerMarkup) ||
    !/\.personnel-picker-shell\.popup-card\s*\{[^}]*padding:\s*var\(--ui-dialog-padding[^}]*background:\s*linear-gradient[^}]*box-shadow:/s.test(personnelPickerStyle) ||
    !/\.personnel-picker-stack\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--ui-dialog-section-gap/s.test(personnelPickerStyle) ||
    !/\.personnel-picker-card-content\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s.test(personnelPickerStyle) ||
    !/@media\s*\(min-width:\s*520px\)\s*and\s*\(max-width:\s*899px\)/.test(personnelPickerStyle) ||
    !/@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)/.test(personnelPickerStyle)) {
  selectionCardIssues.push({
    file: 'miniprogram/components/personnel-picker/',
    message: '共享人员选择器缺少白色弹窗表面、分区留白、正文宽度保护、三段式结构、左上选择控件或三设备响应式契约'
  });
}
for (const pageBase of personnelPickerPages) {
  const markup = fs.readFileSync(path.join(MINI_ROOT, `${pageBase}.wxml`), 'utf8');
  const config = fs.readFileSync(path.join(MINI_ROOT, `${pageBase}.json`), 'utf8');
  if (!/<personnel-picker\b/.test(markup) || !/"personnel-picker"\s*:\s*"\/components\/personnel-picker\/personnel-picker"/.test(config)) {
    selectionCardIssues.push({
      file: `miniprogram/${pageBase}`,
      message: '人员选择页面必须注册并使用全局 personnel-picker，禁止恢复页面私有弹窗'
    });
  }
}
for (const file of wxmlFiles) {
  if (relative(file) === 'miniprogram/components/personnel-picker/personnel-picker.wxml') continue;
  const source = fs.readFileSync(file, 'utf8');
  if (/\bperson-picker-item\b/.test(source)) {
    selectionCardIssues.push({
      file: relative(file),
      message: '已退役的 person-picker-item 禁止继续使用；人员选择必须接入 personnel-picker'
    });
  }
}
for (const file of walk(MINI_ROOT, '.wxss')) {
  if (relative(file) === 'miniprogram/components/personnel-picker/personnel-picker.wxss') continue;
  const source = fs.readFileSync(file, 'utf8');
  if (/\.person-picker-(?:card|list|item|name|id|main|assignment)\b/.test(source)) {
    selectionCardIssues.push({
      file: relative(file),
      message: '已退役的页面私有人员选择器样式禁止保留；人员选择样式只能由 personnel-picker 维护'
    });
  }
}
const visibleInternalIds = wxmlFiles.flatMap(scanVisibleInternalIds);
const staticInlineStyles = wxmlFiles.flatMap(scanStaticInlineStyles);
const layoutContracts = wxmlFiles.map(scanLayoutContracts);
const styles = walk(MINI_ROOT, '.wxss').map(scanWxss);
const compactVisualContractIssues = scanCompactVisualContract();
const dialogGeometryOwnerCount = [...GLOBAL_STYLE.matchAll(/^\s*\.ui-overlay\s*\{/gm)].length;
const landscapeTabTokenCount = [...GLOBAL_STYLE.matchAll(/--ui-tab-min-height:\s*50px\s*;/g)].length;
const duplicateGlobalUiContracts = [
  ...(dialogGeometryOwnerCount === 1 ? [] : [{
    file: 'miniprogram/app.wxss',
    message: `ui-overlay 物理视口定位必须只有一个全局定义，当前为 ${dialogGeometryOwnerCount} 个`
  }]),
  ...(landscapeTabTokenCount === 1 ? [] : [{
    file: 'miniprogram/app.wxss',
    message: `Pad 横屏页签高度令牌必须只有一个定义，当前为 ${landscapeTabTokenCount} 个`
  }])
];
const nativeButtonRoleIssues = controls.filter(item => item.tag === 'button' && !STANDARD_BUTTON_ROLE.test(item.className));
const forbiddenEmojiIcons = [
  ...wxmlFiles,
  ...walk(MINI_ROOT, '.wxss'),
  ...walk(MINI_ROOT, '.js')
].flatMap(scanForbiddenEmojiIcons);
const adminOrgContextIssues = scanAdminOrgContextContracts();
const workspaceShellIssues = scanWorkspaceShellContracts();
const venueFlowVisibilityIssues = scanVenueFlowVisibilityContract();
const legacyRedirectUiIssues = scanLegacyRedirectUi();
const missingFeedback = controls.filter(item => (
  !['field'].includes(item.type) &&
  !item.nonVisual &&
  !item.hoverClass &&
  item.eventType !== 'catchtap'
));
const nestedRisks = controls.filter(item => item.nestedRisk && !item.nonVisual);
const unclassified = controls.filter(item => item.type === 'unclassified' && !item.nonVisual);
const timingMismatches = controls.filter(item => (
  !item.nonVisual && item.hoverClass && (item.hoverStart !== '0' || item.hoverStay !== '160')
));
const shellActive = styles.flatMap(item => item.shellActive);
const nativeInputFlex = styles.flatMap(item => item.nativeInputFlex);
const oversizedTimetable = styles.flatMap(item => item.oversizedTimetable);
const illegalColors = styles.flatMap(item => item.illegalColors);
const dialogs = layoutContracts.flatMap(item => item.dialogs);
const dialogIssues = layoutContracts.flatMap(item => item.dialogIssues);
const dataLayoutIssues = layoutContracts.flatMap(item => item.dataLayoutIssues);
const scrollContractIssues = layoutContracts.flatMap(item => item.scrollContractIssues);
const redundantDialogSingleSection = layoutContracts.flatMap(item => item.redundantDialogSingleSection);
const unsafeControlEllipsis = styles.flatMap(item => item.unsafeControlEllipsis);
const fixedDataColumns = styles.flatMap(item => item.fixedDataColumns);
const pillButtonRadius = styles.flatMap(item => item.pillButtonRadius);
const stackedButtonMetrics = styles.flatMap(item => item.stackedButtonMetrics);
const forcedDialogViewport = styles.flatMap(item => item.forcedDialogViewport);
const miscenteredDialogShell = styles.flatMap(item => item.miscenteredDialogShell);
const misalignedTitleAccent = styles.flatMap(item => item.misalignedTitleAccent);
const rawFontSizes = styles.flatMap(item => item.rawFontSizes);
const oversizedDecorativeHero = styles.flatMap(item => item.oversizedDecorativeHero);
const forcedContentViewport = styles.flatMap(item => item.forcedContentViewport);
const oversizedContentPadding = styles.flatMap(item => item.oversizedContentPadding);
const flattenedDialogSurfaces = styles.flatMap(item => item.flattenedDialogSurfaces);
const duplicateDialogWrapperSurfaces = styles.flatMap(item => item.duplicateDialogWrapperSurfaces);
const missingStableDialogSystem = !(
  /\.ui-dialog-body\s*\{[\s\S]*?flex:\s*1\s+1\s+auto;[\s\S]*?min-height:\s*0;/m.test(GLOBAL_STYLE) &&
  /\.ui-dialog-footer\s*\{[\s\S]*?flex:\s*0\s+0\s+auto;[\s\S]*?padding-bottom:\s*0;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s+\.ui-dialog-shell\.ui-dialog-shell--complex\s*\{[^}]*height:\s*auto\s*!important;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s+\.ui-dialog-shell\.ui-dialog-shell--viewport\s*\{[^}]*height:\s*calc\(100vh[^}]*!important;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s+\.ui-dialog-shell\.ui-dialog-shell--complex\s*>\s*\.ui-dialog-body\s*\{[^}]*flex:\s*0\s+1\s+auto\s*!important;[^}]*max-height:\s*calc\(100vh/m.test(GLOBAL_STYLE)
);
const missingDialogCenteringSystem = !(
  /^\s*\.ui-overlay\s*\{[\s\S]*?position:\s*fixed\s*!important;[\s\S]*?width:\s*100vw\s*!important;[\s\S]*?height:\s*100vh\s*!important;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s+\.ui-dialog-shell\s*\{[\s\S]*?position:\s*fixed\s*!important;[\s\S]*?top:\s*50vh\s*!important;[\s\S]*?left:\s*50vw\s*!important;[\s\S]*?transform:\s*translate\(\s*-50%\s*,\s*-50%\s*\)\s*!important;/m.test(GLOBAL_STYLE)
);
const missingDialogGestureSystem = !(
  /page\s*\{[\s\S]*?touch-action:\s*manipulation;[\s\S]*?-webkit-text-size-adjust:\s*100%;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s*\{[\s\S]*?touch-action:\s*manipulation\s*!important;[\s\S]*?-webkit-text-size-adjust:\s*100%;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s+\.ui-overlay-blocker\s*\{[^}]*touch-action:\s*none\s*!important;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s+\.ui-dialog-shell\s*\{[\s\S]*?touch-action:\s*auto\s*!important;[\s\S]*?-webkit-text-size-adjust:\s*100%;/m.test(GLOBAL_STYLE)
);
const missingDialogScrollSystem = !(
  /scroll-view\.ui-dialog-scroll--fill\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;[^}]*max-height:\s*56vh;/m.test(GLOBAL_STYLE) &&
  /scroll-view\.ui-dialog-scroll--pane\s*\{[^}]*min-height:\s*120rpx;/m.test(GLOBAL_STYLE) &&
  /scroll-view\.ui-dialog-scroll--x\s*\{[^}]*height:\s*auto;/m.test(GLOBAL_STYLE) &&
  /scroll-view\.ui-dialog-scroll--both\s*\{[^}]*height:\s*64vh;/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay\s+scroll-view\.ui-dialog-scroll--fill,[\s\S]*?touch-action:\s*pan-y\s*!important;/m.test(GLOBAL_STYLE) &&
  !/scroll-view\.ui-dialog-scroll--(?:fill|both)\s*\{[^}]*(?:^|;)\s*height:\s*0\s*;/m.test(GLOBAL_STYLE)
);
const missingDialogInteriorSystem = !(
  /--ui-dialog-padding:\s*32rpx/.test(GLOBAL_STYLE) &&
  /--ui-dialog-body-padding:\s*18rpx/.test(GLOBAL_STYLE) &&
  /--ui-dialog-section-padding:\s*22rpx/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-dialog-padding:\s*24px[\s\S]*?--ui-dialog-body-padding:\s*14px[\s\S]*?--ui-dialog-section-padding:\s*16px/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-dialog-padding:\s*22px[\s\S]*?--ui-dialog-body-padding:\s*12px[\s\S]*?--ui-dialog-section-padding:\s*14px/.test(GLOBAL_STYLE) &&
  /\.ui-dialog-content[^\{]*\{[^}]*padding:\s*var\(--ui-dialog-body-padding(?:,\s*18rpx)?\)/m.test(GLOBAL_STYLE) &&
  /\.ui-dialog-section,[\s\S]*?\.ui-dialog-compact-content\s*\{[^}]*padding:\s*var\(--ui-dialog-section-padding(?:,\s*22rpx)?\)/m.test(GLOBAL_STYLE) &&
  /\.ui-dialog-content--stack[^\{]*\{[^}]*background:\s*transparent;[^}]*border-color:\s*transparent;[^}]*box-shadow:\s*none;/m.test(GLOBAL_STYLE) &&
  /\.ui-dialog-stack\s*\{[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/m.test(GLOBAL_STYLE)
);
const missingDialogPortalTokenSystem = !(
  /page,\s*\.ui-overlay,\s*\.ui-sheet-overlay\s*\{[\s\S]*?--ui-dialog-width-inset:\s*32rpx;[\s\S]*?--ui-dialog-height-inset:\s*72rpx;/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*520px\)[\s\S]*?page,\s*\.ui-overlay,\s*\.ui-sheet-overlay\s*\{[\s\S]*?--ui-dialog-width-inset:\s*40px;[\s\S]*?--ui-dialog-height-inset:\s*48px;/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?page,\s*\.ui-overlay,\s*\.ui-sheet-overlay\s*\{[\s\S]*?--ui-dialog-width-inset:\s*48px;[\s\S]*?--ui-dialog-height-inset:\s*48px;/.test(GLOBAL_STYLE) &&
  /width:\s*calc\(100vw\s*-\s*var\(--ui-dialog-width-inset,\s*32rpx\)\)\s*!important;/.test(GLOBAL_STYLE) &&
  /max-height:\s*calc\(100vh\s*-\s*var\(--ui-dialog-height-inset,\s*72rpx\)/.test(GLOBAL_STYLE)
);
const adminStyle = fs.readFileSync(path.join(MINI_ROOT, 'subpackages', 'scoring', 'pages', 'admin', 'admin.wxss'), 'utf8');
const missingResponsiveDataSystem = !(
  /\.csv-mapping-row\s*\{[\s\S]*?display:\s*grid;/m.test(adminStyle) &&
  /\.csv-mapping-row-header\s*\{[\s\S]*?display:\s*none;/m.test(adminStyle) &&
  /@media\s*\(min-width:\s*520px\)[\s\S]*?grid-template-columns:[\s\S]*?minmax\(180px,\s*1\.35fr\)/m.test(adminStyle) &&
  /\.task-table\.ui-data-grid--complex\s*>\s*\.ui-data-row--header/.test(GLOBAL_STYLE)
);
const missingDeviceSystem = !(
  /--ui-control-height:\s*44px/.test(GLOBAL_STYLE) &&
  /--ui-type-body:\s*16px/.test(GLOBAL_STYLE) &&
  /--ui-font-md:\s*var\(--ui-type-body\)/.test(GLOBAL_STYLE) &&
  /input\.field-input[\s\S]*display:\s*block\s*!important/.test(GLOBAL_STYLE)
);
const typeScale = [
  ['micro', '10px', '10.5px', '12px', '12.5px'],
  ['caption', '11px', '11.5px', '13px', '13.5px'],
  ['meta', '12px', '12.5px', '14px', '14.5px'],
  ['label', '12.5px', '13px', '14.5px', '15px'],
  ['control', '13px', '13.5px', '15px', '15.5px'],
  ['body', '13.5px', '14px', '16px', '16.5px'],
  ['emphasis', '14px', '14.5px', '16.5px', '17px'],
  ['value', '15px', '15.5px', '17.5px', '18px'],
  ['section', '16px', '17px', '19px', '20px'],
  ['page', '24px', '25.5px', '29px', '30px']
];
const missingTypographySystem = typeScale.some(([name, compactPhone, phone, pad, largePad]) => {
  const indexes = [compactPhone, phone, pad, largePad].map(value => GLOBAL_STYLE.indexOf(`--ui-type-${name}: ${value};`));
  return indexes.some(index => index < 0) || indexes.some((index, position) => position > 0 && index <= indexes[position - 1]);
}) || !(
  /--ui-type-dialog:\s*var\(--ui-type-section\)/.test(GLOBAL_STYLE) &&
  /--ui-dialog-title-size:\s*15px/.test(GLOBAL_STYLE) &&
  /--ui-dialog-body-size:\s*12\.5px/.test(GLOBAL_STYLE) &&
  /--ui-dialog-meta-size:\s*11\.5px/.test(GLOBAL_STYLE) &&
  /--ui-dialog-control-size:\s*12\.5px/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*390px\)\s*and\s*\(max-width:\s*519px\)[\s\S]*?--ui-dialog-title-size:\s*15\.5px[\s\S]*?--ui-dialog-body-size:\s*13px/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-dialog-title-size:\s*17px[\s\S]*?--ui-dialog-body-size:\s*14\.5px/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-dialog-title-size:\s*17\.5px[\s\S]*?--ui-dialog-body-size:\s*15px/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*390px\)\s*and\s*\(max-width:\s*519px\)/.test(GLOBAL_STYLE) &&
  /@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-type-body:\s*16\.5px/.test(GLOBAL_STYLE) &&
  /page \.hero-title,[\s\S]*?font-size:\s*var\(--ui-type-page\)\s*!important/.test(GLOBAL_STYLE) &&
  /page \.section-title,[\s\S]*?font-size:\s*var\(--ui-type-section\)\s*!important/.test(GLOBAL_STYLE) &&
  /page \.list-title,[\s\S]*?font-size:\s*var\(--ui-type-value\)\s*!important/.test(GLOBAL_STYLE) &&
  /page \.list-desc,[\s\S]*?font-size:\s*var\(--ui-type-meta\)\s*!important/.test(GLOBAL_STYLE)
);
const missingTabSizeSystem = !(
  /--ui-tab-font-size:\s*var\(--ui-type-control\)/.test(GLOBAL_STYLE) &&
  /--ui-tab-min-height:\s*76rpx/.test(GLOBAL_STYLE) &&
  /--ui-tab-min-height:\s*40px/.test(GLOBAL_STYLE) &&
  /--ui-tab-min-height:\s*50px/.test(GLOBAL_STYLE) &&
  /--ui-tab-sidebar-min-height:\s*40px/.test(GLOBAL_STYLE) &&
  /\.message-tab\s*\{[\s\S]*?min-height:\s*var\(--ui-tab-min-height/.test(GLOBAL_STYLE) &&
  /\.tabs\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;/s.test(adminStyle) &&
  /\.tab\s*\{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0;[^}]*white-space:\s*nowrap;/s.test(adminStyle)
);
const homeStyle = fs.readFileSync(path.join(MINI_ROOT, 'subpackages', 'main', 'styles', 'home.wxss'), 'utf8');
if (!/\.selection-option-card\s*>\s*\.selection-card-toggle\s*\{[^}]*flex:\s*none;[^}]*align-self:\s*flex-start;[^}]*min-width:/s.test(homeStyle) ||
    !/\.selection-option-card\s*>\s*\.list-main,[\s\S]*?\.selection-option-card\s*>\s*\.audit-person-info\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/s.test(homeStyle) ||
    !/@media\s*\(min-width:\s*520px\)\s*and\s*\(max-width:\s*899px\)[\s\S]*?\.selection-option-card\s*>\s*\.selection-card-toggle\s*\{[^}]*min-width:\s*48px;/s.test(homeStyle) ||
    !/@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?\.selection-option-card\s*>\s*\.selection-card-toggle\s*\{[^}]*min-width:\s*44px;/s.test(homeStyle)) {
  selectionCardIssues.push({
    file: 'miniprogram/subpackages/main/styles/home.wxss',
    message: '缺少卡片式选择器左上固定选择控件、可收缩正文或 Pad 独立宽度契约'
  });
}
if (!/\.section-control-card\s*\{[\s\S]*?background:\s*linear-gradient/.test(homeStyle)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/subpackages/main/styles/home.wxss',
    message: '缺少 section-control-card 玻璃控制表面基准'
  });
}
if (!/\.card-actions\s*\{[^}]*justify-content:\s*flex-end[^}]*border-top:/s.test(homeStyle) ||
    !/\.card-actions\s*>\s*\.link,[\s\S]*?border-radius:\s*var\(--ui-control-radius\)/.test(homeStyle)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/subpackages/main/styles/home.wxss',
    message: '缺少以人事成员卡片为基准的 card-actions/card action chip 统一样式'
  });
}
if (/\.audit-template-actions\s*\{[^}]*position:\s*absolute/s.test(adminStyle)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/subpackages/scoring/pages/admin/admin.wxss',
    message: '审核模板编辑/删除操作禁止绝对定位到展开按钮同一行'
  });
}
if (!/--ui-inline-control-height:\s*56rpx/.test(GLOBAL_STYLE) ||
    !/@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-inline-control-height:\s*32px/.test(GLOBAL_STYLE) ||
    !/\.ui-inline-control-row\s*\{[^}]*align-items:\s*center/s.test(GLOBAL_STYLE) ||
    !/\.ui-inline-field-row\s*\{[^}]*align-items:\s*flex-end/s.test(GLOBAL_STYLE) ||
    !/\.ui-inline-control\s*\{[\s\S]*?height:\s*var\(--ui-inline-control-height/s.test(GLOBAL_STYLE) ||
    !/\.ui-inline-field-row \.compact-picker-value,[\s\S]*?\.ui-inline-field-row \.field-input\s*\{[\s\S]*?height:\s*var\(--ui-inline-control-height/s.test(GLOBAL_STYLE)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/app.wxss',
    message: '缺少同排控件共享物理高度与垂直基线的 ui-inline-control 契约'
  });
}
if (!/\.ui-compact-segmented\s*\{[\s\S]*?width:\s*auto\s*!important/s.test(GLOBAL_STYLE) ||
    !/\.ui-compact-segmented\s*>\s*\.ui-compact-segmented-item\s*\{[\s\S]*?--ui-compact-height/s.test(GLOBAL_STYLE)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/app.wxss',
    message: '缺少标题行紧凑分段切换 ui-compact-segmented 契约'
  });
}
const portalStyle = fs.readFileSync(path.join(MINI_ROOT, 'subpackages', 'main', 'pages', 'portal', 'portal.wxss'), 'utf8');
const portalWxml = fs.readFileSync(path.join(MINI_ROOT, 'subpackages', 'main', 'pages', 'portal', 'portal.wxml'), 'utf8');
const messageCenterBase = path.join(MINI_ROOT, 'subpackages', 'message', 'pages', 'messageCenter', 'messageCenter');
const messageCenterStyle = fs.readFileSync(`${messageCenterBase}.wxss`, 'utf8');
const messageCenterWxml = fs.readFileSync(`${messageCenterBase}.wxml`, 'utf8');
const uiIconStyle = fs.readFileSync(path.join(MINI_ROOT, 'components', 'ui-icon', 'ui-icon.wxss'), 'utf8');
const uiIconWxml = fs.readFileSync(path.join(MINI_ROOT, 'components', 'ui-icon', 'ui-icon.wxml'), 'utf8');
if (!/wx:if="\{\{sizeRole\}\}"/.test(uiIconWxml) ||
    !/ui-icon-size-\{\{sizeRole\}\}/.test(uiIconWxml) ||
    !/@media\s*\(min-width:\s*520px\)[\s\S]*?ui-icon-size-message-leading[\s\S]*?width:\s*28px/.test(uiIconStyle) ||
    !/@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?ui-icon-size-message-leading[\s\S]*?width:\s*24px/.test(uiIconStyle) ||
    !/max-width:\s*100%/.test(uiIconStyle) || !/max-height:\s*100%/.test(uiIconStyle)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/components/ui-icon/',
    message: 'ui-icon 缺少手机/Pad 竖屏/Pad 横屏语义尺寸和槽位防溢出契约'
  });
}
if (!/sizeRole="message-leading"/.test(portalWxml) ||
    !/sizeRole="message-meta"/.test(portalWxml) ||
    !/sizeRole="message-trailing"/.test(portalWxml) ||
    !/class="portal-message-context-line"/.test(portalWxml) ||
    !/class="portal-session-footer"/.test(portalWxml) ||
    !/\.portal-message-metadata\s*\{[^}]*display:\s*grid/s.test(portalStyle) ||
    /\.portal-message-metadata\s*\{[^}]*flex-wrap:/s.test(portalStyle) ||
    !/\.portal-organization-meta\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s.test(portalStyle) ||
    !/\.portal-organization-name\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0/s.test(portalStyle) ||
    !/\.actions\s*\{[^}]*gap:\s*var\(--ui-page-action-gap\)/s.test(portalStyle) ||
    !/\.page-footer\s*\{[^}]*margin-top:\s*var\(--ui-footer-gap\)/s.test(portalStyle)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/subpackages/main/pages/portal/',
    message: '门户媒体行、完整组织行、底部操作或品牌页脚间距契约缺失'
  });
}
if (!/sizeRole="message-leading"/.test(messageCenterWxml) ||
    !/sizeRole="message-meta"/.test(messageCenterWxml) ||
    !/class="message-context-line"/.test(messageCenterWxml) ||
    !/\.message-metadata\s*\{[^}]*display:\s*grid/s.test(messageCenterStyle) ||
    /\.message-metadata\s*\{[^}]*flex-wrap:/s.test(messageCenterStyle) ||
    !/\.organization-meta\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0/s.test(messageCenterStyle) ||
    !/\.organization-meta-name\s*\{[^}]*flex:\s*1[^}]*min-width:\s*0/s.test(messageCenterStyle)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/subpackages/message/pages/messageCenter/',
    message: '消息中心媒体行或完整组织语义行契约缺失'
  });
}
if (!/--ui-page-action-gap:\s*20rpx/.test(GLOBAL_STYLE) ||
    !/--ui-footer-gap:\s*32rpx/.test(GLOBAL_STYLE) ||
    !/@media\s*\(min-width:\s*520px\)[\s\S]*?--ui-page-action-gap:\s*14px[\s\S]*?--ui-footer-gap:\s*24px/.test(GLOBAL_STYLE) ||
    !/@media\s*\(min-width:\s*900px\)\s*and\s*\(orientation:\s*landscape\)[\s\S]*?--ui-page-action-gap:\s*12px[\s\S]*?--ui-footer-gap:\s*20px/.test(GLOBAL_STYLE)) {
  controlSurfaceIssues.push({
    file: 'miniprogram/app.wxss',
    message: '缺少页面主操作和品牌页脚的三设备专用间距令牌'
  });
}
const adminPermissionsStyle = fs.readFileSync(
  path.join(MINI_ROOT, 'subpackages', 'org', 'pages', 'adminPermissions', 'adminPermissions.wxss'),
  'utf8'
);
const unstableSummaryGrid = !(
  /\.info-grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/m.test(homeStyle) &&
  /\.info-grid\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/m.test(portalStyle) &&
  !/@media\s*\(max-width:\s*360px\)\s*\{[\s\S]*?\.info-block\s*\{[^}]*width:\s*100%/m.test(homeStyle)
);
const typographyRoleDrift = !(
  /\.ui-overlay \.popup-title,[\s\S]*?\.ui-sheet-overlay \.permission-dialog-title\s*\{[\s\S]*?font-size:\s*var\(--ui-dialog-title-size\)\s*!important/m.test(GLOBAL_STYLE) &&
  /\.ui-overlay \.ui-dialog-body\s*\{[^}]*font-size:\s*var\(--ui-dialog-body-size\)\s*!important/m.test(GLOBAL_STYLE) &&
  GLOBAL_STYLE.includes('.ui-sheet-overlay .sheet-note') &&
  /font-size:\s*var\(--ui-dialog-meta-size\)\s*!important/.test(GLOBAL_STYLE) &&
  /\.permission-hero-title\s*\{[^}]*font-size:\s*var\(--ui-type-page/m.test(adminPermissionsStyle) &&
  !/\.permission-hero-title\s*\{\s*font-size:\s*38px/m.test(adminPermissionsStyle)
);
const remoteAssets = walk(MINI_ROOT, '.wxml').flatMap(file => {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/\bsrc\s*=\s*(["'])https?:\/\/[^"']+\1/g)].map(match => ({
    file: relative(file),
    line: lineAt(source, match.index),
    source: match[0]
  }));
});

const signaturePadSourcePath = path.join(MINI_ROOT, 'subpackages', 'audit', 'components', 'signaturePad', 'signaturePad.js');
const signaturePadSource = fs.readFileSync(signaturePadSourcePath, 'utf8');
const signaturePadWxmlPath = path.join(MINI_ROOT, 'subpackages', 'audit', 'components', 'signaturePad', 'signaturePad.wxml');
const signaturePadWxml = fs.readFileSync(signaturePadWxmlPath, 'utf8');
const signaturePadStylePath = path.join(MINI_ROOT, 'subpackages', 'audit', 'components', 'signaturePad', 'signaturePad.wxss');
const signaturePadStyle = fs.readFileSync(signaturePadStylePath, 'utf8');
const signaturePageBase = path.join(MINI_ROOT, 'subpackages', 'audit', 'pages', 'submissionDetail', 'submissionDetail');
const signaturePageSource = fs.readFileSync(`${signaturePageBase}.js`, 'utf8');
const signatureCoordinateIssues = [];
if (!/select\('#sigSurface'\)\.fields\(\{\s*size:\s*true,\s*rect:\s*true\s*\}\)/.test(signaturePadSource)) {
  signatureCoordinateIssues.push({ file: relative(signaturePadSourcePath), message: '签名板必须读取普通视图白板的视口绝对 rect' });
}
if (!/screenX:\s*clamp\(screenX,\s*rect\.left,\s*rect\.right\)/.test(signaturePadSource) ||
  !/screenY:\s*clamp\(screenY,\s*rect\.top,\s*rect\.bottom\)/.test(signaturePadSource) ||
  !/screenX1:\s*from\.screenX/.test(signaturePadSource) || !/screenY2:\s*to\.screenY/.test(signaturePadSource)) {
  signatureCoordinateIssues.push({ file: relative(signaturePadSourcePath), message: '签名触点和线段事实数据必须保存为视口绝对 screenX/screenY' });
}
if (/Number\(t\.(?:x|y|pageX|pageY)\)/.test(signaturePadSource)) {
  signatureCoordinateIssues.push({ file: relative(signaturePadSourcePath), message: '签名板禁止直接使用 Touch.x/y 或 pageX/pageY' });
}
if (!/id="sigSurface"/.test(signaturePadWxml) || !/<view[\s\S]*class="sigpad-ink-segment"/.test(signaturePadWxml)) {
  signatureCoordinateIssues.push({ file: relative(signaturePadWxmlPath), message: '可视白板和实时笔迹必须使用普通 view' });
}
if (!/<canvas[^>]*id="sigExportCanvas"[^>]*class="sigpad-export-canvas"[^>]*><\/canvas>/.test(signaturePadWxml) ||
  /<canvas[^>]*(?:touchstart|touchmove)/.test(signaturePadWxml)) {
  signatureCoordinateIssues.push({ file: relative(signaturePadWxmlPath), message: '原生 Canvas 只能作为不可交互的隐藏导出器' });
}
if (!/\.sigpad-export-canvas\s*\{[^}]*width:\s*1px;[^}]*height:\s*1px;[^}]*opacity:\s*0;/s.test(signaturePadStyle)) {
  signatureCoordinateIssues.push({ file: relative(signaturePadStylePath), message: '导出 Canvas 必须保持 1px、透明且不可交互' });
}
// 页面可以为了让审批卡、步骤编辑器等普通内容进入视口而滚动；签名坐标契约
// 只禁止在打开签名板时把页面强制滚回顶部，借此掩盖坐标系混用。
if (/pageScrollTo\s*\(\s*\{[^}]*scrollTop\s*:\s*0\s*(?:,|})/s.test(signaturePageSource)) {
  signatureCoordinateIssues.push({ file: relative(`${signaturePageBase}.js`), message: '签名坐标禁止通过强制页面滚动归零实现' });
}

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    wxmlFiles: wxmlFiles.length,
    wxssFiles: styles.length,
    controls: controls.length,
    missingFeedback: missingFeedback.length,
    nestedRisks: nestedRisks.length,
    unclassified: unclassified.length,
    timingMismatches: timingMismatches.length,
    shellActive: shellActive.length,
    nativeInputFlex: nativeInputFlex.length,
    oversizedTimetable: oversizedTimetable.length,
    missingDeviceSystem: missingDeviceSystem ? 1 : 0,
    missingTypographySystem: missingTypographySystem ? 1 : 0,
    missingTabSizeSystem: missingTabSizeSystem ? 1 : 0,
    unstableSummaryGrid: unstableSummaryGrid ? 1 : 0,
    typographyRoleDrift: typographyRoleDrift ? 1 : 0,
    transitionAll: styles.reduce((sum, item) => sum + item.transitionAll, 0),
    willChange: styles.reduce((sum, item) => sum + item.willChange, 0),
    illegalColors: illegalColors.length,
    remoteAssets: remoteAssets.length,
    visibleInternalIds: visibleInternalIds.length,
    nativeButtonRoleIssues: nativeButtonRoleIssues.length,
    forbiddenEmojiIcons: forbiddenEmojiIcons.length,
    adminOrgContextIssues: adminOrgContextIssues.length,
    workspaceShellIssues: workspaceShellIssues.length,
    venueFlowVisibilityIssues: venueFlowVisibilityIssues.length,
    legacyRedirectUiIssues: legacyRedirectUiIssues.length,
    staticInlineStyles: staticInlineStyles.length,
    dialogs: dialogs.length,
    dialogIssues: dialogIssues.length,
    dataLayoutIssues: dataLayoutIssues.length,
    scrollContractIssues: scrollContractIssues.length,
    redundantDialogSingleSection: redundantDialogSingleSection.length,
    unsafeControlEllipsis: unsafeControlEllipsis.length,
    fixedDataColumns: fixedDataColumns.length,
    pillButtonRadius: pillButtonRadius.length,
    stackedButtonMetrics: stackedButtonMetrics.length,
    forcedDialogViewport: forcedDialogViewport.length,
    miscenteredDialogShell: miscenteredDialogShell.length,
    misalignedTitleAccent: misalignedTitleAccent.length,
    rawFontSizes: rawFontSizes.length,
    oversizedDecorativeHero: oversizedDecorativeHero.length,
    forcedContentViewport: forcedContentViewport.length,
    oversizedContentPadding: oversizedContentPadding.length,
    flattenedDialogSurfaces: flattenedDialogSurfaces.length,
    duplicateDialogWrapperSurfaces: duplicateDialogWrapperSurfaces.length,
    missingStableDialogSystem: missingStableDialogSystem ? 1 : 0,
    missingDialogCenteringSystem: missingDialogCenteringSystem ? 1 : 0,
    missingDialogGestureSystem: missingDialogGestureSystem ? 1 : 0,
    missingDialogScrollSystem: missingDialogScrollSystem ? 1 : 0,
    missingDialogInteriorSystem: missingDialogInteriorSystem ? 1 : 0,
    missingDialogPortalTokenSystem: missingDialogPortalTokenSystem ? 1 : 0,
    missingResponsiveDataSystem: missingResponsiveDataSystem ? 1 : 0,
    compactVisualContractIssues: compactVisualContractIssues.length,
    duplicateGlobalUiContracts: duplicateGlobalUiContracts.length,
    signatureCoordinateIssues: signatureCoordinateIssues.length,
    selectionCardIssues: selectionCardIssues.length,
    controlSurfaceIssues: controlSurfaceIssues.length,
    important: styles.reduce((sum, item) => sum + item.important, 0),
    missingTabletPortrait: styles.filter(item => !item.media520).length,
    missingTabletLandscape: styles.filter(item => !item.media900).length
  },
  controls,
  missingFeedback,
  nestedRisks,
  unclassified,
  timingMismatches,
  shellActive,
  nativeInputFlex,
  oversizedTimetable,
  illegalColors,
  remoteAssets,
  visibleInternalIds,
  nativeButtonRoleIssues,
  forbiddenEmojiIcons,
  adminOrgContextIssues,
  workspaceShellIssues,
  venueFlowVisibilityIssues,
  legacyRedirectUiIssues,
  staticInlineStyles,
  dialogs,
  dialogIssues,
  dataLayoutIssues,
  scrollContractIssues,
  redundantDialogSingleSection,
  unsafeControlEllipsis,
  fixedDataColumns,
  pillButtonRadius,
  stackedButtonMetrics,
  forcedDialogViewport,
  miscenteredDialogShell,
  misalignedTitleAccent,
  rawFontSizes,
  oversizedDecorativeHero,
  forcedContentViewport,
  oversizedContentPadding,
  flattenedDialogSurfaces,
  duplicateDialogWrapperSurfaces,
  missingTypographySystem,
  missingTabSizeSystem,
  unstableSummaryGrid,
  typographyRoleDrift,
  compactVisualContractIssues,
  duplicateGlobalUiContracts,
  signatureCoordinateIssues,
  selectionCardIssues,
  controlSurfaceIssues,
  styles
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log('WHUSU Smart Workspace UI audit');
  console.table(report.summary);
  console.log('\nHighest-risk files:');
  const riskByFile = new Map();
  for (const item of [...missingFeedback, ...nestedRisks, ...unclassified, ...nativeButtonRoleIssues, ...forbiddenEmojiIcons, ...workspaceShellIssues, ...pillButtonRadius, ...stackedButtonMetrics, ...forcedDialogViewport, ...miscenteredDialogShell, ...misalignedTitleAccent, ...rawFontSizes, ...oversizedDecorativeHero, ...forcedContentViewport, ...oversizedContentPadding, ...flattenedDialogSurfaces, ...duplicateDialogWrapperSurfaces, ...redundantDialogSingleSection, ...compactVisualContractIssues, ...duplicateGlobalUiContracts, ...selectionCardIssues, ...controlSurfaceIssues]) {
    riskByFile.set(item.file, (riskByFile.get(item.file) || 0) + 1);
  }
  console.table([...riskByFile.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([file, risks]) => ({ file, risks })));
}

if (process.argv.includes('--strict')) {
  const failed = report.summary.missingFeedback || report.summary.nestedRisks || report.summary.timingMismatches || report.summary.shellActive ||
    report.summary.nativeInputFlex || report.summary.oversizedTimetable || report.summary.missingDeviceSystem ||
    report.summary.missingTypographySystem || report.summary.missingTabSizeSystem || report.summary.unstableSummaryGrid || report.summary.typographyRoleDrift ||
    report.summary.transitionAll || report.summary.willChange || report.summary.illegalColors || report.summary.remoteAssets ||
    report.summary.visibleInternalIds ||
    report.summary.nativeButtonRoleIssues || report.summary.forbiddenEmojiIcons ||
    report.summary.adminOrgContextIssues || report.summary.workspaceShellIssues || report.summary.venueFlowVisibilityIssues || report.summary.legacyRedirectUiIssues ||
    report.summary.staticInlineStyles ||
    report.summary.dialogIssues || report.summary.dataLayoutIssues || report.summary.scrollContractIssues || report.summary.redundantDialogSingleSection || report.summary.unsafeControlEllipsis ||
    report.summary.fixedDataColumns || report.summary.pillButtonRadius || report.summary.stackedButtonMetrics || report.summary.forcedDialogViewport || report.summary.miscenteredDialogShell || report.summary.misalignedTitleAccent || report.summary.rawFontSizes || report.summary.oversizedDecorativeHero || report.summary.forcedContentViewport || report.summary.oversizedContentPadding || report.summary.flattenedDialogSurfaces || report.summary.duplicateDialogWrapperSurfaces || report.summary.missingStableDialogSystem || report.summary.missingDialogCenteringSystem || report.summary.missingDialogGestureSystem || report.summary.missingDialogScrollSystem || report.summary.missingDialogInteriorSystem || report.summary.missingDialogPortalTokenSystem ||
    report.summary.missingResponsiveDataSystem || report.summary.compactVisualContractIssues || report.summary.duplicateGlobalUiContracts ||
    report.summary.signatureCoordinateIssues || report.summary.selectionCardIssues || report.summary.controlSurfaceIssues;
  process.exitCode = failed ? 1 : 0;
}
