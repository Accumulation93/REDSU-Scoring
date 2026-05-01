const STORAGE_KEY = 'roleProfiles';
const ACTIVE_ROLE_KEY = 'activeRole';
const LEADER_IDENTITIES = ['部门主要负责人', '部门负责人'];

function getDisplayIdentity(user, activeRole) {
  if (!user) {
    return '未登录';
  }

  if (activeRole === 'admin') {
    return user.adminLevel === 'root_admin' ? '至高权限管理员' : (user.adminLevel === 'super_admin' ? '超级管理员' : '普通管理员');
  }

  return user.identity || '未设置身份';
}

function shouldShowWorkGroup(user) {
  if (!user || !user.workGroup) {
    return false;
  }

  return LEADER_IDENTITIES.indexOf(user.identity) === -1;
}

Page({
  data: {
    user: null,
    activeRole: '',
    hasUser: false,
    showWorkGroup: false,
    identityText: '未登录',
    currentActivity: null,
    currentActivityText: '暂无评分活动'
  },

  onShow() {
    this.loadUserProfile();
    this.loadCurrentActivity();
  },

  loadUserProfile() {
    const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
    const activeRole = wx.getStorageSync(ACTIVE_ROLE_KEY) || '';
    const user = roleProfiles[activeRole] || null;

    this.setData({
      user,
      activeRole,
      hasUser: !!user,
      showWorkGroup: shouldShowWorkGroup(user),
      identityText: getDisplayIdentity(user, activeRole)
    });
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

  goHome() {
    wx.navigateBack({
      fail: () => {
        wx.redirectTo({
          url: '/pages/home/home'
        });
      }
    });
  },

  goLogin() {
    wx.redirectTo({
      url: '/pages/login/login'
    });
  },

  onUnbind() {
    if (!this.data.activeRole) {
      return;
    }

    wx.showModal({
      title: '确认解绑',
      content: '解绑后只会移除当前身份，不会影响另一种身份。',
      success: (modalRes) => {
        if (!modalRes.confirm) {
          return;
        }

        wx.showLoading({
          title: '解绑中'
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
                title: '解绑失败',
                icon: 'error'
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
              icon: 'error'
            });
          },
          complete: () => {
            wx.hideLoading();
          }
        });
      }
    });
  }
});
