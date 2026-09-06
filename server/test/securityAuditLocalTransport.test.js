'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/security-audit.js'), 'utf8');
const context = {};
vm.runInNewContext(source.slice(source.indexOf('const RULES = ['), source.indexOf('\nfunction addFinding'))
  + '\nthis.rules = RULES;', context);
const rule = context.rules.find(item => item.id === 'insecure-http');
function allowed(input, file) { return rule.allow({ input: "'" + input, index: 0 }, file); }
assert.equal(allowed('http://127.0.0.1:123/api', 'server/test/upload.test.js'), true);
assert.equal(allowed('http://127.0.0.1:123/api', 'server/src/upload.js'), false);
assert.equal(allowed('http://127.0.0.1:123/api', 'miniprogram/utils/upload.js'), false);
const external = new URL('http://127.0.0.1/api');
external.hostname = '127.0.0.1.example.com';
assert.equal(allowed(external.href, 'server/test/upload.test.js'), false);
external.hostname = 'example.com';
assert.equal(allowed(external.href, 'server/test/upload.test.js'), false);
console.log('安全审计回环例外测试通过：只允许服务端隔离测试，不放行生产和外部 HTTP');
