const STORAGE_KEY = 'roleProfiles';
const ACTIVE_ROLE_KEY = 'activeRole';

const ROLE_MAP = {
  user: {
    key: 'user',
    badge: '普通用户',
    loginFunction: 'userLogin',
    bindFunction: 'bindUserInfo',
    title: '普通用户登录',
    subtitle: '使用微信授权后进入普通用户端，未完成资料匹配时再补充姓名和学号。',
    loginButtonText: '普通用户登录',
    bindTitle: '补充普通用户信息',
    bindButtonText: '确认提交'
  },
  admin: {
    key: 'admin',
    badge: '管理员',
    loginFunction: 'adminLogin',
    bindFunction: 'bindAdminInfo',
    title: '管理员登录',
    subtitle: '管理员使用邀请码完成验证后进入管理端，支持普通管理员与超级管理员两种类别。',
    loginButtonText: '管理员登录',
    bindTitle: '补充管理员信息',
    bindButtonText: '确认提交'
  }
};

function normalizeProfile(user) {
  return {
    name: user.name || user['姓名'] || '',
    studentId: user.studentId || user['学号'] || '',
    department: user.department || user['所属部门'] || '',
    identity: user.identity || user['身份'] || '',
    workGroup: user.workGroup || user['工作分工（职能组）'] || '',
    adminLevel: user.adminLevel || ''
  };
}

Page({
  data: {
    activeRole: 'user',
    roleTitle: ROLE_MAP.user.title,
    roleSubtitle: ROLE_MAP.user.subtitle,
    roleBadge: ROLE_MAP.user.badge,
    loginButtonText: ROLE_MAP.user.loginButtonText,
    bindTitle: ROLE_MAP.user.bindTitle,
    bindButtonText: ROLE_MAP.user.bindButtonText,
    showInviteCode: false,
    sheetClass: 'sheet',
    showBind: false,
    loading: false,
    name: '',
    studentId: '',
    inviteCode: ''
  },

  onLoad() {
    this.syncRoleCopy(this.data.activeRole);
  },

  onShow() {
    const storedRole = wx.getStorageSync(ACTIVE_ROLE_KEY);
    if (storedRole && ROLE_MAP[storedRole] && storedRole !== this.data.activeRole) {
      this.syncRoleCopy(storedRole);
    }
  },

  syncRoleCopy(role) {
    const currentRole = ROLE_MAP[role] ? role : 'user';
    const config = ROLE_MAP[currentRole];

    this.setData({
      activeRole: currentRole,
      roleTitle: config.title,
      roleSubtitle: config.subtitle,
      roleBadge: config.badge,
      loginButtonText: config.loginButtonText,
      bindTitle: config.bindTitle,
      bindButtonText: config.bindButtonText,
      showInviteCode: currentRole === 'admin',
      sheetClass: 'sheet',
      showBind: false,
      name: '',
      studentId: '',
      inviteCode: ''
    });
  },

  switchRole(e) {
    const { role } = e.currentTarget.dataset;
    if (!role || role === this.data.activeRole || !ROLE_MAP[role]) {
      return;
    }

    this.syncRoleCopy(role);
  },

  onName(e) {
    this.setData({ name: e.detail.value.trim() });
  },

  onStudentId(e) {
    this.setData({ studentId: e.detail.value.trim() });
  },

  onInviteCode(e) {
    this.setData({ inviteCode: e.detail.value.trim().toUpperCase() });
  },

  closeBind() {
    this.setData({
      showBind: false,
      sheetClass: 'sheet',
      name: '',
      studentId: '',
      inviteCode: ''
    });
  },

  onLogin() {
    if (this.data.loading) {
      return;
    }

    const config = ROLE_MAP[this.data.activeRole];

    this.setData({ loading: true });

    wx.cloud.callFunction({
      name: config.loginFunction,
      success: (res) => {
        this.handleLoginResult(config.key, res.result);
      },
      fail: () => {
        wx.showToast({
          title: '登录失败',
          icon: 'error'
        });
      },
      complete: () => {
        this.setData({ loading: false });
      }
    });
  },

  handleLoginResult(role, result) {
    if (!result || !result.status) {
      wx.showToast({
        title: '登录异常',
        icon: 'error'
      });
      return;
    }

    if (result.status === 'login_success') {
      this.saveProfile(role, result.user);
      wx.showToast({
        title: '登录成功',
        icon: 'success'
      });
      wx.redirectTo({
        url: '/pages/home/home'
      });
      return;
    }

    if (result.status === 'need_bind') {
      this.setData({
        showBind: true,
        sheetClass: 'sheet sheet-show'
      });
      return;
    }

    wx.showToast({
      title: result.message || '暂时无法登录',
      icon: 'none'
    });
  },

  onBind() {
    if (this.data.loading) {
      return;
    }

    const { name, studentId, inviteCode, activeRole } = this.data;

    if (!name || !studentId) {
      wx.showToast({
        title: '请填写姓名和学号',
        icon: 'none'
      });
      return;
    }

    if (activeRole === 'admin' && !inviteCode) {
      wx.showToast({
        title: '请输入邀请码',
        icon: 'none'
      });
      return;
    }

    const config = ROLE_MAP[activeRole];
    const payload = {
      name,
      studentId
    };

    if (activeRole === 'admin') {
      payload.inviteCode = inviteCode;
    }

    this.setData({ loading: true });

    wx.cloud.callFunction({
      name: config.bindFunction,
      data: payload,
      success: (res) => {
        this.handleBindResult(activeRole, res.result);
      },
      fail: () => {
        wx.showToast({
          title: '提交失败',
          icon: 'error'
        });
      },
      complete: () => {
        this.setData({ loading: false });
      }
    });
  },

  handleBindResult(role, result) {
    if (!result || !result.status) {
      wx.showToast({
        title: '提交异常',
        icon: 'error'
      });
      return;
    }

    if (result.status === 'bind_success') {
      this.saveProfile(role, result.user);
      this.setData({
        showBind: false,
        sheetClass: 'sheet',
        name: '',
        studentId: '',
        inviteCode: ''
      });
      wx.showToast({
        title: '提交成功',
        icon: 'success'
      });
      wx.redirectTo({
        url: '/pages/home/home'
      });
      return;
    }

    if (result.status === 'invalid_params') {
      wx.showToast({
        title: '请补全信息',
        icon: 'none'
      });
      return;
    }

    wx.showToast({
      title: result.message || '信息不匹配',
      icon: 'none'
    });
  },

  saveProfile(role, user) {
    const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
    roleProfiles[role] = normalizeProfile(user);
    wx.setStorageSync(STORAGE_KEY, roleProfiles);
    wx.setStorageSync(ACTIVE_ROLE_KEY, role);
  }
});
