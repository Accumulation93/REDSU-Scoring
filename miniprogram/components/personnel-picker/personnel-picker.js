'use strict';

const localeCopy = require('../../locales/zh-CN/personnelPicker');
const model = require('./personnelPickerModel');

Component({
  options: {
    multipleSlots: true,
    styleIsolation: 'apply-shared'
  },

  properties: {
    visible: { type: Boolean, value: false, observer: function(value) { this._onVisibleChange(value); } },
    title: { type: String, value: '' },
    options: { type: Array, value: [], observer: function() { this._onOptionsChange(); } },
    value: { type: Array, value: [], observer: function() { this._onValueChange(); } },
    selectionLevel: { type: String, value: 'assignment' },
    multiple: { type: Boolean, value: true },
    loading: { type: Boolean, value: false },
    errorText: { type: String, value: '' },
    contextText: { type: String, value: '' },
    confirmLoading: { type: Boolean, value: false }
  },

  data: {
    localeCopy,
    normalizedOptions: [],
    filteredOptions: [],
    selectedItems: [],
    selectedExpanded: false,
    draftKeys: [],
    departmentOptions: [],
    identityOptions: [],
    workGroupOptions: [],
    departmentIndex: 0,
    identityIndex: 0,
    workGroupIndex: 0,
    department: '',
    identity: '',
    workGroup: '',
    keyword: '',
    selectedHeading: '',
    candidateHeading: '',
    selectedCountText: ''
  },

  methods: {
    _onVisibleChange: function(visible) {
      if (visible) this._resetDraft();
    },

    _onOptionsChange: function() {
      if (this.data.visible) this._refreshOptions(this.data.draftKeys);
    },

    _onValueChange: function() {
      if (this.data.visible) this._resetDraft();
    },

    _resetDraft: function() {
      const keys = model.selectedKeys(this.properties.value, this.properties.selectionLevel);
      this.setData({
        departmentIndex: 0,
        identityIndex: 0,
        workGroupIndex: 0,
        department: '',
        identity: '',
        workGroup: '',
        keyword: '',
        selectedExpanded: false,
        draftKeys: keys
      }, function() {
        this._refreshOptions(keys);
      });
    },

    _refreshOptions: function(keys) {
      const normalized = model.normalizeOptions(this.properties.options, this.properties.selectionLevel);
      const allLabel = localeCopy.all;
      const departmentOptions = [allLabel].concat(model.optionNames(normalized, 'departmentName'));
      const identityOptions = [allLabel].concat(model.optionNames(normalized, 'identityCategoryName'));
      const workGroupOptions = [allLabel].concat(model.optionNames(normalized, 'workGroupName'));
      this.setData({
        normalizedOptions: normalized,
        departmentOptions,
        identityOptions,
        workGroupOptions,
        selectedHeading: this.properties.selectionLevel === 'person' ? localeCopy.selectedPersonTitle : localeCopy.selectedTitle,
        candidateHeading: this.properties.selectionLevel === 'person' ? localeCopy.candidatePersonTitle : localeCopy.candidateTitle
      }, function() {
        this._applyView(keys || this.data.draftKeys);
      });
    },

    _applyView: function(keys) {
      const selectedSet = new Set(keys || []);
      const decorated = this.data.normalizedOptions.map(function(item) {
        return Object.assign({}, item, {
          _selected: selectedSet.has(item.selectionKey),
          _displayName: item.name || localeCopy.unnamed,
          _assignmentText: item.assignmentLabel || localeCopy.assignmentUnavailable
        });
      });
      const filters = {
        department: this.data.department,
        identity: this.data.identity,
        workGroup: this.data.workGroup,
        keyword: this.data.keyword
      };
      this.setData({
        normalizedOptions: decorated,
        filteredOptions: model.filterOptions(decorated, filters),
        selectedItems: decorated.filter(function(item) { return item._selected; }),
        draftKeys: keys || [],
        selectedCountText: localeCopy.selectedCount((keys || []).length)
      });
    },

    toggleOption: function(event) {
      const key = String(event.currentTarget.dataset.key || '');
      if (!key) return;
      const keys = model.toggleSelection(this.data.draftKeys, key, this.properties.multiple);
      this._applyView(keys);
    },

    toggleSelectedExpanded: function() {
      this.setData({ selectedExpanded: !this.data.selectedExpanded });
    },

    onDepartmentChange: function(event) {
      const index = Number(event.detail.value) || 0;
      this.setData({ departmentIndex: index, department: index ? this.data.departmentOptions[index] : '' }, this._applyView.bind(this, this.data.draftKeys));
    },

    onIdentityChange: function(event) {
      const index = Number(event.detail.value) || 0;
      this.setData({ identityIndex: index, identity: index ? this.data.identityOptions[index] : '' }, this._applyView.bind(this, this.data.draftKeys));
    },

    onWorkGroupChange: function(event) {
      const index = Number(event.detail.value) || 0;
      this.setData({ workGroupIndex: index, workGroup: index ? this.data.workGroupOptions[index] : '' }, this._applyView.bind(this, this.data.draftKeys));
    },

    onKeywordInput: function(event) {
      this.setData({ keyword: event.detail.value || '' }, this._applyView.bind(this, this.data.draftKeys));
    },

    confirmSelection: function() {
      this.triggerEvent('confirm', {
        keys: this.data.draftKeys.slice(),
        items: this.data.selectedItems.map(function(item) {
          const copy = Object.assign({}, item);
          delete copy._selected;
          delete copy._displayName;
          delete copy._assignmentText;
          return copy;
        })
      });
    },

    cancelSelection: function() {
      this.triggerEvent('cancel');
    },

    retry: function() {
      this.triggerEvent('retry');
    },

    noop: function() {}
  }
});
