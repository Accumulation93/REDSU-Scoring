'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const pageRoot = __dirname;
const wxml = fs.readFileSync(path.join(pageRoot, 'home.wxml'), 'utf8');
const wxss = fs.readFileSync(path.join(pageRoot, 'home.wxss'), 'utf8');
const loginJs = fs.readFileSync(path.resolve(pageRoot, '../../../main/pages/login/login.js'), 'utf8');

test('普通用户保存口令与保存人事信息复用同一标准主按钮规格', () => {
  const passphraseStart = wxml.indexOf('class="profile-passphrase-form"');
  const passphraseEnd = wxml.indexOf('</view>', passphraseStart);
  const passphraseForm = wxml.slice(passphraseStart, passphraseEnd);
  assert.match(passphraseForm, /profile-submit-btn profile-passphrase-submit/);
  assert.doesNotMatch(passphraseForm, /profile-account-action/);
  assert.match(wxss, /\.profile-passphrase-form\s*\{[\s\S]*flex-direction:\s*column/);
  assert.match(wxss, /\.profile-passphrase-submit\s*\{[\s\S]*flex:\s*none;[\s\S]*min-width:\s*100%;[\s\S]*max-width:\s*100%/);
});

test('口令登录独立认证，只有确认绑定时才获取微信 code', () => {
  assert.match(loginJs, /function requestWechatLoginCode\(\)/);
  const loginStart = loginJs.indexOf('async onPasswordLogin()');
  const loginEnd = loginJs.indexOf('async bindPasswordWechat()', loginStart);
  assert(loginStart >= 0 && loginEnd > loginStart);
  const passwordLogin = loginJs.slice(loginStart, loginEnd);
  assert.doesNotMatch(passwordLogin, /requestWechatLoginCode\(|wx\.login\(/);
  assert.match(passwordLogin, /passphrase:\s*this\.data\.password,[\s\S]*requestBindingOffer:\s*true/);
  assert.match(loginJs.slice(loginEnd), /requiresWechatCode\s*\?\s*await requestWechatLoginCode\(\)/);
});
