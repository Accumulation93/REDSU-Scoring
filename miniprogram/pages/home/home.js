const STORAGE_KEY = 'roleProfiles';
const ACTIVE_ROLE_KEY = 'activeRole';
const LEADER_IDENTITIES = ['部门主要负责人', '部门负责人'];

function shouldShowWorkGroup(user) {
  if (!user || !user.workGroup) {
    return false;
  }

  return LEADER_IDENTITIES.indexOf(user.identity) === -1;
}

function getDisplayIdentity(user, activeRole) {
  if (!user) {
    return '未登录';
  }

  if (activeRole === 'admin') {
    return user.adminLevel === 'super_admin' ? '超级管理员' : '普通管理员';
  }

  return user.identity || '未设置身份';
}

Page({
  data: {
    user: null,
    activeRole: '',
    hasUser: false,
    isAdminRole: false,
    showWorkGroup: false,
    heroName: '欢迎使用',
    heroIdentity: '未登录',
    heroSubtitle: '请先完成登录',
    currentActivity: null,
    currentActivityText: '暂无评分活动',
    targetList: [],
    selectedTargetId: '',
    targetsLoading: false,
    targetsEmptyText: '暂无被评分人',
    showUnbindDialog: false,
    unbindLoading: false
  },

  onShow() {
    this.refreshCurrentUser();
    this.loadCurrentActivity();
  },

  refreshCurrentUser() {
    const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
    let activeRole = wx.getStorageSync(ACTIVE_ROLE_KEY) || '';

    if (!roleProfiles[activeRole]) {
      const roleList = Object.keys(roleProfiles);
      activeRole = roleList.length ? roleList[0] : '';
      if (activeRole) {
        wx.setStorageSync(ACTIVE_ROLE_KEY, activeRole);
      } else {
        wx.removeStorageSync(ACTIVE_ROLE_KEY);
      }
    }

    const currentUser = activeRole ? roleProfiles[activeRole] : null;
    const isAdminRole = activeRole === 'admin';

    this.setData({
      activeRole,
      user: currentUser,
      hasUser: !!currentUser,
      isAdminRole,
      showWorkGroup: shouldShowWorkGroup(currentUser),
      heroName: currentUser ? currentUser.name : '欢迎使用',
      heroIdentity: getDisplayIdentity(currentUser, activeRole),
      heroSubtitle: currentUser ? '当前已进入对应身份首页' : '请先完成登录',
      targetList: [],
      selectedTargetId: '',
      targetsEmptyText: '暂无被评分人',
      targetsLoading: false
    });

    if (currentUser && activeRole === 'user') {
      this.fetchRateTargets(activeRole);
    }
  },

  loadCurrentActivity() {
    wx.cloud.callFunction({
      name: 'getCurrentScoreActivity',
      success: (res) => {
        const result = res.result || {};
        const activity = result.activity || null;
        this.setData({
          currentActivity: activity,
          currentActivityText: activity ? activity.name : '暂无评分活动'
        });
      },
      fail: () => {
        this.setData({
          currentActivity: null,
          currentActivityText: '暂无评分活动'
        });
      }
    });
  },

  fetchRateTargets(role) {
    this.setData({
      targetsLoading: true,
      targetList: [],
      selectedTargetId: '',
      targetsEmptyText: '正在加载被评分人'
    });

    wx.cloud.callFunction({
      name: 'getRateTargets',
      data: { role },
      success: (res) => {
        const result = res.result || {};

        if (result.status !== 'success') {
          this.setData({
            targetList: [],
            targetsEmptyText: result.message || '暂无符合规则的被评分人'
          });
          return;
        }

        if (result.scorer) {
          this.updateStoredProfile(role, result.scorer);
        }

        const currentUser = result.scorer || this.data.user;

        this.setData({
          user: currentUser,
          showWorkGroup: shouldShowWorkGroup(currentUser),
          heroName: currentUser ? currentUser.name : this.data.heroName,
          heroIdentity: getDisplayIdentity(currentUser, role),
          targetList: result.targets || [],
          targetsEmptyText: (result.targets || []).length ? '' : '暂无符合规则的被评分人'
        });
      },
      fail: () => {
        this.setData({
          targetList: [],
          targetsEmptyText: '加载被评分人失败'
        });
      },
      complete: () => {
        this.setData({
          targetsLoading: false
        });
      }
    });
  },

  updateStoredProfile(role, profile) {
    const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
    roleProfiles[role] = profile;
    wx.setStorageSync(STORAGE_KEY, roleProfiles);
  },

  selectTarget(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({ selectedTargetId: id });

    wx.showLoading({
      title: '进入评分页'
    });

    wx.cloud.callFunction({
      name: 'getScoreFormData',
      data: {
        targetId: id
      },
      success: (res) => {
        const result = res.result || {};
        if (result.status !== 'success') {
          wx.showToast({
            title: result.message || '无法进入评分页',
            icon: 'none'
          });
          return;
        }

        wx.navigateTo({
          url: `/pages/score/score?targetId=${encodeURIComponent(id)}`
        });
      },
      fail: () => {
        wx.showToast({
          title: `${name} 评分页加载失败`,
          icon: 'none'
        });
      },
      complete: () => {
        wx.hideLoading();
      }
    });
  },

  goLogin() {
    wx.redirectTo({
      url: '/pages/login/login'
    });
  },

  goAdmin() {
    wx.navigateTo({
      url: '/pages/admin/admin'
    });
  },

  openUnbindDialog() {
    if (!this.data.activeRole || this.data.unbindLoading) {
      return;
    }

    this.setData({
      showUnbindDialog: true
    });
  },

  closeUnbindDialog() {
    if (this.data.unbindLoading) {
      return;
    }

    this.setData({
      showUnbindDialog: false
    });
  },

  confirmUnbind() {
    if (!this.data.activeRole || this.data.unbindLoading) {
      return;
    }

    this.setData({
      unbindLoading: true
    });

    wx.cloud.callFunction({
      name: 'unbindRole',
      data: {
        role: this.data.activeRole
      },
      success: (res) => {
        const result = res.result || {};

        if (result.status !== 'unbind_success' && result.status !== 'already_unbound') {
          wx.showToast({
            title: result.message || '解绑失败',
            icon: 'none'
          });
          return;
        }

        const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
        delete roleProfiles[this.data.activeRole];
        wx.setStorageSync(STORAGE_KEY, roleProfiles);

        const roleList = Object.keys(roleProfiles);
        if (roleList.length) {
          wx.setStorageSync(ACTIVE_ROLE_KEY, roleList[0]);
        } else {
          wx.removeStorageSync(ACTIVE_ROLE_KEY);
        }

        this.setData({
          showUnbindDialog: false
        });

        wx.showToast({
          title: '解绑成功',
          icon: 'success'
        });

        wx.redirectTo({
          url: '/pages/login/login'
        });
      },
      fail: () => {
        wx.showToast({
          title: '解绑失败',
          icon: 'none'
        });
      },
      complete: () => {
        this.setData({
          unbindLoading: false
        });
      }
    });
  }
});
