const STORAGE_KEY = 'roleProfiles';
const ACTIVE_ROLE_KEY = 'activeRole';
const LEADER_IDENTITIES = ['部门主要负责人', '部门负责人'];
const USER_TABS = [
  { key: 'scoring', label: '考核评分' },
  { key: 'profile', label: '人事信息' }
];

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
    return user.adminLevel === 'root_admin' ? '至高权限管理员' : (user.adminLevel === 'super_admin' ? '超级管理员' : '普通管理员');
  }

  return user.identity || '未设置身份';
}

function emptyHrProfileState() {
  return {
    loading: false,
    saving: false,
    loaded: false,
    template: null,
    pendingValues: {},
    auditStatus: 'none',
    statusText: '尚未提交扩展资料',
    rejectionReason: ''
  };
}

function showShortToast(title, icon = 'none') {
  wx.showToast({
    title,
    icon
  });
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  const [year, month, day] = value.split('-').map((item) => Number(item));
  return date.getFullYear() === year
    && date.getMonth() + 1 === month
    && date.getDate() === day;
}

function getNumericLength(value) {
  return String(value || '').replace(/^[+-]/, '').replace('.', '').length;
}

function getProfileFieldTypeLabel(type) {
  if (type === 'number') {
    return '数字字段';
  }
  if (type === 'sequence') {
    return '序列选择';
  }
  if (type === 'date') {
    return '日期字段';
  }
  if (type === 'phone') {
    return '手机号字段';
  }
  if (type === 'email') {
    return '邮箱字段';
  }
  return '文本字段';
}

function buildFieldHint(field = {}) {
  if (field.type === 'text' && (field.minLength != null || field.maxLength != null)) {
    const parts = [];
    if (field.minLength != null) {
      parts.push(`最短 ${field.minLength}`);
    }
    if (field.maxLength != null) {
      parts.push(`最长 ${field.maxLength}`);
    }
    return `长度限制：${parts.join('，')}`;
  }

  if (field.type === 'number') {
    const decimalText = field.allowDecimal === false ? '仅整数' : '允许小数';
    if (field.numberRule === 'length_range' && (field.minDigits != null || field.maxDigits != null)) {
      const parts = [];
      if (field.minDigits != null) {
        parts.push(`最短 ${field.minDigits}`);
      }
      if (field.maxDigits != null) {
        parts.push(`最长 ${field.maxDigits}`);
      }
      return `数字长度：${parts.join('，')}，${decimalText}`;
    }
    if (field.minValue != null || field.maxValue != null) {
      const parts = [];
      if (field.minValue != null) {
        parts.push(`最小 ${field.minValue}`);
      }
      if (field.maxValue != null) {
        parts.push(`最大 ${field.maxValue}`);
      }
      return `数值范围：${parts.join('，')}，${decimalText}`;
    }
    return decimalText;
  }

  if (field.type === 'date') {
    return '格式：YYYY-MM-DD';
  }

  if (field.type === 'phone') {
    return '请输入 11 位手机号';
  }

  if (field.type === 'email') {
    return '示例：name@example.com';
  }

  return '';
}

function normalizeDisplayField(field = {}, valueMap = {}) {
  const id = field.id || '';
  return {
    ...field,
    value: valueMap[id] || '',
    typeLabel: getProfileFieldTypeLabel(field.type),
    hintText: buildFieldHint(field)
  };
}

function validateProfileField(field = {}, rawValue) {
  const value = rawValue == null ? '' : String(rawValue).trim();

  if (field.required && !value) {
    return `${field.label}不能为空`;
  }

  if (!value) {
    return '';
  }

  if (field.type === 'text') {
    if (field.minLength != null && value.length < field.minLength) {
      return `${field.label}长度不能少于 ${field.minLength}`;
    }
    if (field.maxLength != null && value.length > field.maxLength) {
      return `${field.label}长度不能超过 ${field.maxLength}`;
    }
  }

  if (field.type === 'number') {
    if (field.allowDecimal === false && !/^[+-]?\d+$/.test(value)) {
      return `${field.label}必须是整数`;
    }
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return `${field.label}必须是数字`;
    }
    if (field.numberRule === 'length_range') {
      const numericLength = getNumericLength(value);
      if (field.minDigits != null && numericLength < field.minDigits) {
        return `${field.label}长度不能少于 ${field.minDigits}`;
      }
      if (field.maxDigits != null && numericLength > field.maxDigits) {
        return `${field.label}长度不能超过 ${field.maxDigits}`;
      }
    } else {
      if (field.minValue != null && numberValue < field.minValue) {
        return `${field.label}不能小于 ${field.minValue}`;
      }
      if (field.maxValue != null && numberValue > field.maxValue) {
        return `${field.label}不能大于 ${field.maxValue}`;
      }
    }
  }

  if (field.type === 'sequence' && Array.isArray(field.options) && field.options.length && field.options.indexOf(value) === -1) {
    return `${field.label}必须从预设选项中选择`;
  }

  if (field.type === 'date' && !isValidDateString(value)) {
    return `${field.label}必须是有效日期`;
  }

  if (field.type === 'phone' && !/^1[3-9]\d{9}$/.test(value)) {
    return `${field.label}必须是有效手机号`;
  }

  if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return `${field.label}必须是有效邮箱`;
  }

  return '';
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
    unbindLoading: false,
    userTabs: USER_TABS,
    activeTab: USER_TABS[0].key,
    hrProfile: emptyHrProfileState()
  },

  onShow() {
    this.refreshCurrentUser();
    this.refreshUserFromCloud();
    this.loadCurrentActivity();
  },

  refreshUserFromCloud() {
    const activeRole = wx.getStorageSync(ACTIVE_ROLE_KEY) || '';
  
    if (activeRole !== 'user') {
      return;
    }
  
    wx.cloud.callFunction({
      name: 'userLogin',
      success: (res) => {
        const result = res.result || {};
  
        if (result.status !== 'login_success' || !result.user) {
          const roleProfiles = wx.getStorageSync(STORAGE_KEY) || {};
          delete roleProfiles.user;
          wx.setStorageSync(STORAGE_KEY, roleProfiles);
  
          if (activeRole === 'user') {
            const roleList = Object.keys(roleProfiles);
            if (roleList.length) {
              wx.setStorageSync(ACTIVE_ROLE_KEY, roleList[0]);
            } else {
              wx.removeStorageSync(ACTIVE_ROLE_KEY);
            }
          }
  
          this.refreshCurrentUser();
          return;
        }
  
        this.updateStoredProfile('user', result.user);
  
        if (this.data.activeRole === 'user') {
          this.setData({
            user: result.user,
            hasUser: true,
            showWorkGroup: shouldShowWorkGroup(result.user),
            heroName: result.user.name || '欢迎使用',
            heroIdentity: getDisplayIdentity(result.user, 'user'),
            heroSubtitle: '当前已进入对应身份首页'
          });
  
          this.fetchRateTargets('user');
          this.loadUserHrProfile();
        }
      }
    });
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
      targetsLoading: false,
      activeTab: isAdminRole ? 'scoring' : this.data.activeTab,
      hrProfile: emptyHrProfileState()
    });

    if (currentUser && activeRole === 'user') {
      // 用户信息现在以 checkLogin 云端合并结果为准，
      // 不再用本地缓存直接加载被评分人，避免旧缓存缺字段导致误报。
    }
  },

  switchUserTab(e) {
    const tab = String(e.currentTarget.dataset.tab || '');
    if (!tab || tab === this.data.activeTab) {
      return;
    }

    this.setData({
      activeTab: tab
    });

    if (tab === 'profile' && this.data.activeRole === 'user' && !this.data.hrProfile.loaded) {
      this.loadUserHrProfile();
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

  loadUserHrProfile() {
    if (this.data.activeRole !== 'user' || !this.data.hasUser) {
      return;
    }

    this.setData({
      'hrProfile.loading': true
    });

    wx.cloud.callFunction({
      name: 'getUserHrProfile',
      success: (res) => {
        const result = res.result || {};
        if (result.status !== 'success') {
          this.setData({
            hrProfile: {
              ...emptyHrProfileState(),
              loaded: true
            }
          });
          wx.showToast({
            title: result.message || '加载人事信息失败',
            icon: 'none'
          });
          return;
        }

        const template = result.template || null;
        const baseValues = result.values || {};
        const pendingValues = result.pendingValues || {};
        const formValues = result.auditStatus === 'pending'
          ? { ...baseValues, ...pendingValues }
          : { ...baseValues };
        const nextTemplate = template ? {
          ...template,
          fields: (template.fields || []).map((field) => normalizeDisplayField(field, formValues))
        } : null;

        this.setData({
          hrProfile: {
            loading: false,
            saving: false,
            loaded: true,
            template: nextTemplate,
            pendingValues,
            auditStatus: result.auditStatus || 'none',
            statusText: result.statusText || '尚未提交扩展资料',
            rejectionReason: result.rejectionReason || ''
          }
        });
      },
      fail: () => {
        this.setData({
          hrProfile: {
            ...emptyHrProfileState(),
            loaded: true
          }
        });
        wx.showToast({
          title: '加载人事信息失败',
          icon: 'none'
        });
      }
    });
  },

  onHrProfileInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const fields = [...((this.data.hrProfile.template && this.data.hrProfile.template.fields) || [])];
    if (!fields[index]) {
      return;
    }

    fields[index] = {
      ...fields[index],
      value: String(e.detail.value || '')
    };

    this.setData({
      'hrProfile.template.fields': fields
    });
  },

  onHrProfileOptionChange(e) {
    const fieldIndex = Number(e.currentTarget.dataset.index);
    const optionIndex = Number(e.detail.value);
    const fields = [...((this.data.hrProfile.template && this.data.hrProfile.template.fields) || [])];
    const field = fields[fieldIndex];
    const nextValue = field && Array.isArray(field.options) ? field.options[optionIndex] : '';
    if (!field || !nextValue) {
      return;
    }

    fields[fieldIndex] = {
      ...field,
      value: nextValue
    };

    this.setData({
      'hrProfile.template.fields': fields
    });
  },

  onHrProfileDateChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const fields = [...((this.data.hrProfile.template && this.data.hrProfile.template.fields) || [])];
    if (!fields[index]) {
      return;
    }

    fields[index] = {
      ...fields[index],
      value: String(e.detail.value || '')
    };

    this.setData({
      'hrProfile.template.fields': fields
    });
  },

  submitHrProfile() {
    const hrProfile = this.data.hrProfile || emptyHrProfileState();
    const template = hrProfile.template;
    if (!template || !Array.isArray(template.fields) || !template.fields.length) {
      wx.showToast({
        title: '管理员尚未配置人事信息模板',
        icon: 'none'
      });
      return;
    }

    if (template.editMode === 'readonly') {
      wx.showToast({
        title: '当前不允许自行修改，请联系管理员',
        icon: 'none'
      });
      return;
    }

    const values = {};
    for (let i = 0; i < template.fields.length; i += 1) {
      const field = template.fields[i];
      values[field.id] = field.value == null ? '' : String(field.value).trim();
      const errorMessage = validateProfileField(field, values[field.id]);
      if (errorMessage) {
        wx.showToast({
          title: errorMessage,
          icon: 'none'
        });
        return;
      }
    }

    this.setData({
      'hrProfile.saving': true
    });

    wx.cloud.callFunction({
      name: 'submitUserHrProfile',
      data: {
        values
      },
      success: (res) => {
        const result = res.result || {};
        if (result.status !== 'success') {
          showShortToast('更新失败');
          return;
        }

        showShortToast('已更新', 'success');
        this.loadUserHrProfile();
      },
      fail: () => {
        showShortToast('更新失败');
      },
      complete: () => {
        this.setData({
          'hrProfile.saving': false
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
