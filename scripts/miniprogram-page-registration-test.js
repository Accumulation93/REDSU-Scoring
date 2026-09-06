'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// 用真实依赖图加载每个页面；不把 Node 的 require 或微信 API 通配代理交给业务代码。
// 此检查验证注册与兼容补丁，不冒充鸿蒙引擎或真机渲染验收。
const root = path.resolve(__dirname, '../miniprogram');
const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const routes = (appConfig.pages || []).slice();
(appConfig.subPackages || []).forEach(function(bundle) {
  bundle.pages.forEach(function(page) { routes.push(bundle.root + '/' + page); });
});

function checkPage(route, fallback) {
  const registrations = [];
  const cache = new Map();
  let app = { globalData: {} };
  const context = vm.createContext({
    console,
    wx: {},
    getApp() { return app; },
    getCurrentPages() { return []; },
    App(value) { app = value; },
    Page(value) { registrations.push(value); },
    Component(value) { return value; },
    Behavior(value) { return value; },
    setTimeout() { throw new Error('注册期间不得启动定时任务'); },
    setInterval() { throw new Error('注册期间不得启动轮询'); },
    clearTimeout() {},
    clearInterval() {}
  });
  if (fallback) {
    vm.runInContext([
      'Number.isFinite = undefined;',
      'String.prototype.includes = undefined;',
      'String.prototype.padStart = undefined;',
      'String.prototype.padEnd = undefined;',
      'Array.prototype.includes = undefined;',
      'Array.prototype.find = undefined;',
      'Promise.prototype.finally = undefined;'
    ].join('\n'), context);
  }
  function load(base) {
    const filename = path.extname(base) ? base : base + '.js';
    const relative = path.relative(root, filename);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '依赖不得越过主包根目录');
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const source = fs.readFileSync(filename, 'utf8');
    if (filename.endsWith('.json')) module.exports = JSON.parse(source);
    else {
      const factory = vm.runInContext('(function(require,module,exports){\n' + source + '\n})', context, { filename });
      factory(function(request) {
        assert.ok(request.startsWith('.'), '禁止依赖宿主或未打包的运行时模块：' + request);
        return load(path.resolve(path.dirname(filename), request));
      }, module, module.exports);
    }
    return module.exports;
  }
  load(path.join(root, 'app.js'));
  const components = new Set();
  function loadComponents(config, directory) {
    Object.values(config.usingComponents || {}).forEach(function(request) {
      const base = request.startsWith('/') ? path.join(root, request.slice(1)) : path.resolve(directory, request);
      if (components.has(base)) return;
      components.add(base);
      const child = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
      loadComponents(child, path.dirname(base));
      load(base);
    });
  }
  loadComponents(appConfig, root);
  const base = path.join(root, route);
  loadComponents(JSON.parse(fs.readFileSync(base + '.json', 'utf8')), path.dirname(base));
  load(base);
  assert.strictEqual(registrations.length, 1, route + ' 必须恰好注册一次');
  assert.ok(registrations[0].data || typeof registrations[0].onLoad === 'function', route + ' 必须包含页面定义');
}

routes.forEach(function(route) {
  checkPage(route, false);
  checkPage(route, true);
});
console.log('真实依赖图页面注册检查通过：' + routes.length + ' 个页面，正常及缺少可补齐 API 两组环境。');
