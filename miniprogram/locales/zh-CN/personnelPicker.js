'use strict';

module.exports = Object.freeze({
  choose: '选择',
  cancelSelection: '取消',
  close: '关闭',
  confirm: '确认',
  retry: '重试',
  selectedTitle: '已选岗位',
  selectedPersonTitle: '已选人员',
  expandSelected: '展开',
  collapseSelected: '收起',
  candidateTitle: '可选岗位',
  candidatePersonTitle: '可选人员',
  department: '部门',
  identity: '身份类别',
  workGroup: '职能组',
  all: '全部',
  searchPlaceholder: '搜索姓名或岗位',
  loading: '正在加载候选人员…',
  empty: '暂无可选人员',
  noMatch: '没有符合筛选条件的人员',
  noSelection: '暂未选择，可直接确认清空',
  unnamed: '未命名人员',
  assignmentUnavailable: '岗位信息暂不可用',
  selectedCount: function(count) {
    return '已选 ' + Number(count || 0) + ' 项';
  }
});
