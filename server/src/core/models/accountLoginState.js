// 仅供服务端固定 SQL 别名使用：账号可以通过任一种当前可用的登录凭据进入。
// 不读取或解密微信标识，更不以其确定人员；用于最后管理员及启动保护。
function usableLoginCredentialSql(accountAlias) {
  if (!['a', 'account_row'].includes(accountAlias)) throw new Error('Unsupported account SQL alias');
  return `(EXISTS (
    SELECT 1 FROM account_wechat_bindings login_binding
     WHERE login_binding.account_id = ${accountAlias}.id
       AND login_binding.app_id = 'whusu-smart-workspace' AND login_binding.status = 'active'
  ) OR EXISTS (
    SELECT 1 FROM account_recovery_credentials login_credential
     JOIN auth_policy login_policy ON login_policy.id = 'default' AND login_policy.allow_passphrase = 1
    WHERE login_credential.account_id = ${accountAlias}.id
      AND login_credential.method = 'passphrase' AND login_credential.status = 'active'
      AND (login_credential.locked_until IS NULL OR login_credential.locked_until <= NOW())
  ))`;
}

module.exports = { usableLoginCredentialSql };
