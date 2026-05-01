function isStepAligned(value, startValue, stepValue) {
  if (!Number.isFinite(stepValue) || stepValue <= 0) {
    return true;
  }

  const diff = (value - startValue) / stepValue;
  return Math.abs(diff - Math.round(diff)) < 1e-8;
}

function alignScoreValue(v) {
  return Math.round(v * 1000) / 1000;
}

function getQuickScores(minValue, maxValue, startValue, stepValue) {
  var min = Number(minValue);
  var max = Number(maxValue);
  var start = Number(startValue);
  var step = Number(stepValue);

  if (!Number.isFinite(start) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || start > max) {
    return [];
  }

  var allScores = [];
  for (var v = start; v <= max + 1e-8; v += step) {
    var aligned = alignScoreValue(v);
    if (aligned >= min && aligned <= max) {
      allScores.push(aligned);
    }
    if (allScores.length >= 500) break;
  }

  var total = allScores.length;
  if (total === 0) return [];
  if (total <= 25) return allScores.map(String);

  // More than 25: prioritize integers, then fill remaining slots with decimals
  var intScores = [];
  var decScores = [];
  for (var i = 0; i < allScores.length; i++) {
    if (Math.abs(allScores[i] - Math.round(allScores[i])) < 1e-8) {
      intScores.push(allScores[i]);
    } else {
      decScores.push(allScores[i]);
    }
  }

  var result = [];
  var seen = {};
  function add(val) {
    var key = String(val);
    if (!seen[key]) {
      seen[key] = true;
      result.push(val);
    }
  }

  // Add all integers first (up to 25)
  for (var i = 0; i < intScores.length && result.length < 25; i++) {
    add(intScores[i]);
  }

  // Fill remaining slots with evenly distributed decimals
  var remaining = 25 - result.length;
  if (remaining > 0 && decScores.length > 0) {
    if (decScores.length <= remaining) {
      for (var i = 0; i < decScores.length; i++) {
        add(decScores[i]);
      }
    } else {
      for (var i = 0; i < remaining; i++) {
        var idx = Math.round((i / (remaining - 1)) * (decScores.length - 1));
        if (idx >= 0 && idx < decScores.length) {
          add(decScores[idx]);
        }
      }
    }
  }

  result.sort(function (a, b) { return a - b; });
  return result.slice(0, 25).map(String);
}

function validateQuestion(question) {
  question = question || {};
  var rawScore = String(question.score == null ? '' : question.score).trim();
  if (!rawScore) {
    return { ok: false, errorText: '请填写分值' };
  }

  var score = Number(rawScore);
  if (Number.isNaN(score)) {
    return { ok: false, errorText: '请输入有效数字' };
  }

  if (score < Number(question.startValue)) {
    return { ok: false, errorText: '低于起评分' };
  }

  if (score < Number(question.minValue) || score > Number(question.maxValue)) {
    return { ok: false, errorText: '超出评分范围' };
  }

  if (!isStepAligned(score, Number(question.startValue), Number(question.stepValue))) {
    return { ok: false, errorText: '不符合步进值' };
  }

  return { ok: true, errorText: '' };
}

function normalizeQuestion(item) {
  item = item || {};
  return {
    id: item.id,
    index: Number(item.questionIndex),
    templateId: item.templateId,
    templateName: item.templateName,
    templateWeight: Number(item.templateWeight),
    templateSortOrder: Number(item.templateSortOrder),
    showTemplateHeader: !!item.showTemplateHeader,
    question: item.question,
    scoreLabel: item.scoreLabel,
    minValue: Number(item.minValue),
    startValue: Number(item.startValue),
    maxValue: Number(item.maxValue),
    stepValue: Number(item.stepValue),
    score: item.score || '',
    quickScores: getQuickScores(item.minValue, item.maxValue, item.startValue, item.stepValue),
    errorText: '',
    touched: false
  };
}

function computeSummaries(questionList) {
  var templateMap = {};
  var templateOrder = [];
  for (var i = 0; i < questionList.length; i++) {
    var q = questionList[i];
    var tid = q.templateId;
    if (!templateMap[tid]) {
      templateMap[tid] = {
        templateId: tid,
        templateName: q.templateName,
        templateSortOrder: q.templateSortOrder,
        totalScore: 0,
        totalMax: 0,
        lastIndex: -1
      };
      templateOrder.push(tid);
    }
    var s = Number(q.score);
    if (!Number.isNaN(s) && String(q.score).trim() !== '') {
      templateMap[tid].totalScore += alignScoreValue(s);
    }
    templateMap[tid].totalMax += q.maxValue;
    templateMap[tid].lastIndex = i;
  }

  var newList = [];
  for (var i = 0; i < questionList.length; i++) {
    var q = questionList[i];
    var newQ = {};
    var keys = Object.keys(q);
    for (var k = 0; k < keys.length; k++) {
      newQ[keys[k]] = q[keys[k]];
    }
    newQ.showTemplateFooter = false;
    newQ.templateFooterScore = 0;
    newQ.templateFooterMax = 0;
    newList.push(newQ);
  }

  var templateSummaries = [];
  var pageTotalScore = 0;
  var pageTotalMax = 0;

  for (var t = 0; t < templateOrder.length; t++) {
    var info = templateMap[templateOrder[t]];
    if (info.lastIndex >= 0) {
      newList[info.lastIndex].showTemplateFooter = true;
      newList[info.lastIndex].templateFooterScore = info.totalScore;
      newList[info.lastIndex].templateFooterMax = info.totalMax;
    }
    templateSummaries.push({
      templateId: info.templateId,
      templateName: info.templateName,
      templateSortOrder: info.templateSortOrder,
      totalScore: info.totalScore,
      totalMax: info.totalMax
    });
    pageTotalScore += info.totalScore;
    pageTotalMax += info.totalMax;
  }

  return {
    questionList: newList,
    templateSummaries: templateSummaries,
    pageTotalScore: alignScoreValue(pageTotalScore),
    pageTotalMax: alignScoreValue(pageTotalMax)
  };
}

Page({
  data: {
    loading: true,
    loadFailed: false,
    scorer: null,
    target: null,
    currentActivity: null,
    currentActivityText: '暂无评分活动',
    questionList: [],
    currentQuestionIndex: 0,
    currentQuestion: null,
    quickScoreRows: [],
    keyboardCollapsed: false,
    keyboardMode: 'quick',
    submitting: false,
    hasExistingRecord: false,
    existingRecordText: '',
    templateSummaries: [],
    pageTotalScore: 0,
    pageTotalMax: 0,
    physicalInputValue: '',
    physicalInputFocus: false,
    physicalKeyActive: ''
  },

  syncCurrentQuestion: function () {
    var idx = this.data.currentQuestionIndex;
    var list = this.data.questionList;
    var q = (list && idx >= 0 && list[idx]) || null;
    var rows = [];
    if (q) {
      var scores = q.quickScores || [];
      var total = scores.length;
      if (total > 0) {
        var maxPerRow = 5;
        var rowCount = Math.ceil(total / maxPerRow);
        var baseSize = Math.floor(total / rowCount);
        var remainder = total % rowCount;
        var pos = 0;
        for (var r = 0; r < rowCount; r++) {
          var size = baseSize + (r < remainder ? 1 : 0);
          rows.push(scores.slice(pos, pos + size));
          pos += size;
        }
      }
    }
    var updates = {
      currentQuestion: q,
      quickScoreRows: rows,
      keyboardCollapsed: q ? false : this.data.keyboardCollapsed
    };
    if (this._physicalKeyboardEnabled) {
      updates.physicalInputFocus = !updates.keyboardCollapsed && !!q;
      if (q) {
        var syncedScore = String(q.score || '').trim();
        this._physicalBuffer = syncedScore;
        updates.physicalInputValue = syncedScore;
      }
    }
    if (rows.length === 0 && this.data.keyboardMode === 'quick') {
      updates.keyboardMode = 'numpad';
    }
    this.setData(updates);
  },

  collapseKeyboard: function () {
    this.setData({
      keyboardCollapsed: true,
      currentQuestion: null,
      physicalInputFocus: false
    });
  },

  expandKeyboard: function () {
    if (this.data.keyboardCollapsed && this.data.questionList.length > 0) {
      var idx = this.data.currentQuestionIndex;
      if (idx < 0 || idx >= this.data.questionList.length) {
        idx = 0;
      }
      var updates = {
        currentQuestionIndex: idx,
        keyboardCollapsed: false,
        keyboardMode: 'quick'
      };
      if (this._physicalKeyboardEnabled) {
        updates.physicalInputFocus = true;
      }
      this.setData(updates);
      this.syncCurrentQuestion();
    }
  },

  toggleKeyboardMode: function () {
    var nextMode = this.data.keyboardMode === 'numpad' ? 'quick' : 'numpad';
    this.setData({ keyboardMode: nextMode });
  },

  onLoad: function (options) {
    var sysInfo = wx.getSystemInfoSync();
    this._physicalKeyboardEnabled = sysInfo.platform === 'devtools' || sysInfo.platform === 'mac' || sysInfo.platform === 'windows';
    this._physicalBuffer = '';
    this._shiftDown = false;
    this._keydownSupported = false;
    this.targetId = String((options && options.targetId) || '').trim();
    this.loadScoreForm();
  },

  onReady: function () {
    if (this._physicalKeyboardEnabled) {
      this.setData({ physicalInputFocus: true });
    }
  },

  _ensureInputFocus: function () {
    if (!this._physicalKeyboardEnabled) return;
    if (this.data.keyboardCollapsed) return;
    this.setData({ physicalInputFocus: true });
  },

  loadScoreForm: function () {
    var self = this;
    if (!self.targetId) {
      wx.showToast({ title: '缺少被评分人信息', icon: 'none' });
      self.redirectHome();
      return;
    }

    self.setData({ loading: true, loadFailed: false });

    wx.cloud.callFunction({
      name: 'getScoreFormData',
      data: { targetId: self.targetId },
      success: function (res) {
        var result = res.result || {};
        if (result.status !== 'success') {
          wx.showToast({ title: result.message || '评分页加载失败', icon: 'none' });
          self.setData({ loading: false, loadFailed: true });
          setTimeout(function () { self.redirectHome(); }, 1200);
          return;
        }

        var rawQuestionList = (result.templateBundle.questions || []).map(function (item) {
          return normalizeQuestion(item);
        });

        self.activityId = result.currentActivity ? result.currentActivity.id : '';
        self.activityName = result.currentActivity ? result.currentActivity.name : '';
        self.templateConfigSignature = result.rule ? result.rule.templateConfigSignature : '';

        var hasExistingRecord = !!result.existingRecord;
        var existingRecordText = hasExistingRecord ? '已自动加载上次评分，可以直接修改后重新提交' : '';

        var summaries = computeSummaries(rawQuestionList);
        var questionList = summaries.questionList;

        var initialIndex = 0;
        if (questionList.length) {
          var firstEmpty = -1;
          for (var i = 0; i < questionList.length; i++) {
            if (!questionList[i].score || String(questionList[i].score).trim() === '') {
              firstEmpty = i;
              break;
            }
          }
          initialIndex = firstEmpty >= 0 ? firstEmpty : 0;
        }

        self.setData({
          scorer: result.scorer,
          target: result.target,
          currentActivity: result.currentActivity || null,
          currentActivityText: result.currentActivity ? result.currentActivity.name : '暂无评分活动',
          questionList: questionList,
          currentQuestionIndex: initialIndex,
          hasExistingRecord: hasExistingRecord,
          existingRecordText: existingRecordText,
          templateSummaries: summaries.templateSummaries,
          pageTotalScore: summaries.pageTotalScore,
          pageTotalMax: summaries.pageTotalMax,
          loading: false,
          loadFailed: false
        });
        self.syncCurrentQuestion();
        setTimeout(function () {
          self._ensureInputFocus();
          self.scrollToQuestion(initialIndex);
        }, 350);
      },
      fail: function () {
        wx.showToast({ title: '评分页加载失败', icon: 'none' });
        self.setData({ loading: false, loadFailed: true });
      }
    });
  },

  updateQuestion: function (index, nextValues) {
    var questions = this.data.questionList.slice();
    if (!questions[index]) return;

    var nextQuestion = {};
    var keys = Object.keys(questions[index]);
    for (var k = 0; k < keys.length; k++) {
      nextQuestion[keys[k]] = questions[index][keys[k]];
    }
    var nvKeys = Object.keys(nextValues || {});
    for (var j = 0; j < nvKeys.length; j++) {
      nextQuestion[nvKeys[j]] = nextValues[nvKeys[j]];
    }

    var validation = validateQuestion(nextQuestion);
    nextQuestion.errorText = validation.errorText;
    questions[index] = nextQuestion;

    var summaries = computeSummaries(questions);
    var data = {
      questionList: summaries.questionList,
      templateSummaries: summaries.templateSummaries,
      pageTotalScore: summaries.pageTotalScore,
      pageTotalMax: summaries.pageTotalMax
    };
    if (index === this.data.currentQuestionIndex) {
      data.currentQuestion = summaries.questionList[index];
    }
    this.setData(data);
  },

  focusQuestion: function (e) {
    var index = Number(e.currentTarget.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    this.setData({ currentQuestionIndex: index, keyboardCollapsed: false });
    this.syncCurrentQuestion();
    this.scrollToQuestion(index);
  },

  onKeyboardTap: function (e) {
    var key = String(e.currentTarget.dataset.key || '');
    if (!key) return;

    var index = this.data.currentQuestionIndex;
    var question = this.data.questionList[index];
    if (!question) return;

    var current = String(question.score == null ? '' : question.score).trim();

    if (key === '.') {
      if (current === '' || current === '-') {
        current = '0.';
      } else if (current.indexOf('.') === -1) {
        current = current + '.';
      }
    } else if (key === '-') {
      if (current === '') {
        current = '-';
      } else if (current === '-') {
        current = '';
      } else if (current.charAt(0) === '-') {
        current = current.substring(1);
      } else {
        current = '-' + current;
      }
    } else {
      if (current === '0') {
        current = key;
      } else {
        current = current + key;
      }
    }

    this.flashKey(key);
    this._physicalBuffer = current;
    this.updateQuestion(index, { score: current, touched: true });
  },

  onKeyboardBackspace: function () {
    var index = this.data.currentQuestionIndex;
    var question = this.data.questionList[index];
    if (!question) return;

    var current = String(question.score == null ? '' : question.score).trim();
    if (current.length > 0) {
      current = current.substring(0, current.length - 1);
    }
    this.flashKey('backspace');
    this._physicalBuffer = current;
    this.updateQuestion(index, { score: current, touched: true });
  },

  flashKey: function (key) {
    var self = this;
    if (self._clearKeyTimer) clearTimeout(self._clearKeyTimer);
    self.setData({ physicalKeyActive: key });
    self._clearKeyTimer = setTimeout(function () {
      self.setData({ physicalKeyActive: '' });
      self._clearKeyTimer = null;
    }, 160);
  },

  processPhysicalChar: function (ch) {
    var index = this.data.currentQuestionIndex;
    var question = this.data.questionList[index];
    if (!question) return;

    var current = String(question.score == null ? '' : question.score).trim();

    if (ch === '.') {
      if (current === '' || current === '-') {
        current = '0.';
      } else if (current.indexOf('.') === -1) {
        current = current + '.';
      }
    } else if (ch === '-') {
      if (current === '') {
        current = '-';
      } else if (current === '-') {
        current = '';
      } else if (current.charAt(0) === '-') {
        current = current.substring(1);
      } else {
        current = '-' + current;
      }
    } else if (/^[0-9]$/.test(ch)) {
      if (current === '0') {
        current = ch;
      } else {
        current = current + ch;
      }
    }

    this.flashKey(ch);
    this.updateQuestion(index, { score: current, touched: true });
  },

  onPhysicalInput: function (e) {
    if (!this._physicalKeyboardEnabled) return;
    if (this.data.keyboardCollapsed) return;

    var newValue = e.detail.value || '';
    var oldValue = this._physicalBuffer || '';

    if (newValue === oldValue) return;

    var minLen = Math.min(oldValue.length, newValue.length);
    var splitPos = 0;
    while (splitPos < minLen && oldValue[splitPos] === newValue[splitPos]) {
      splitPos++;
    }

    var removeCount = oldValue.length - splitPos;

    for (var i = 0; i < removeCount; i++) {
      this.onKeyboardBackspace();
    }

    for (var i = splitPos; i < newValue.length; i++) {
      this.processPhysicalChar(newValue[i]);
    }

    this._physicalBuffer = newValue;

    if (this._physicalBuffer.length > 15) {
      var self = this;
      var currentScore = String((self.data.questionList[self.data.currentQuestionIndex] || {}).score || '').trim();
      this._physicalBuffer = currentScore;
      self.setData({ physicalInputValue: currentScore });
    }
  },

  onPhysicalInputBlur: function () {
    if (!this._physicalKeyboardEnabled) return;
    if (this.data.keyboardCollapsed) return;
    var self = this;
    wx.nextTick(function () {
      self._ensureInputFocus();
    });
  },

  onPhysicalKeyDown: function (e) {
    if (!this._physicalKeyboardEnabled) return;
    if (this.data.keyboardCollapsed) return;
    this._keydownSupported = true;

    var detail = e.detail || {};
    var keyCode = detail.keyCode;
    var key = detail.key || '';
    var shiftHeld = detail.shiftKey || this._shiftDown;

    // Track Shift via keydown (may not fire on all platforms)
    if (keyCode === 16 || key === 'Shift') {
      this._shiftDown = true;
      return;
    }

    // --- Arrow keys ---
    // Arrow Up → previous
    if (keyCode === 38 || key === 'ArrowUp') {
      this.flashKey('prev');
      this.goToPrevious();
      return;
    }
    // Arrow Down → next
    if (keyCode === 40 || key === 'ArrowDown') {
      this.flashKey('next');
      this.goToNext();
      return;
    }

    // --- Enter key ---
    if (keyCode === 13 || key === 'Enter') {
      if (shiftHeld) {
        this.flashKey('prev');
        this.goToPrevious();
      } else {
        var idx = this.data.currentQuestionIndex;
        var total = this.data.questionList.length;
        if (idx >= total - 1) {
          this.flashKey('submit');
          this.submitScore();
        } else {
          this.flashKey('next');
          this.goToNext();
        }
      }
    }
  },

  onPhysicalKeyUp: function (e) {
    var detail = e.detail || {};
    if (detail.keyCode === 16 || detail.key === 'Shift') {
      this._shiftDown = false;
    }
  },

  onPhysicalConfirm: function () {
    if (!this._physicalKeyboardEnabled) return;
    if (this._keydownSupported) return;
    var idx = this.data.currentQuestionIndex;
    var total = this.data.questionList.length;
    if (idx >= total - 1) {
      this.flashKey('submit');
      this.submitScore();
    } else {
      this.flashKey('next');
      this.goToNext();
    }
  },

  onQuickScoreTap: function (e) {
    var value = String(e.currentTarget.dataset.value || '');
    if (!value) return;

    var index = this.data.currentQuestionIndex;
    this._physicalBuffer = value;
    this.updateQuestion(index, { score: value, touched: true });
    this.goToNext();
  },

  goToPrevious: function () {
    var index = this.data.currentQuestionIndex;
    if (index <= 0) return;
    var newIndex = index - 1;
    this.setData({ currentQuestionIndex: newIndex, keyboardCollapsed: false });
    this.syncCurrentQuestion();
    this.scrollToQuestion(newIndex);
  },

  goToNext: function () {
    var index = this.data.currentQuestionIndex;
    var total = this.data.questionList.length;
    if (index >= total - 1) {
      return;
    }
    var newIndex = index + 1;
    this.setData({ currentQuestionIndex: newIndex, keyboardCollapsed: false });
    this.syncCurrentQuestion();
    this.scrollToQuestion(newIndex);
  },

  validateAnswers: function () {
    var nextQuestions = this.data.questionList.slice();
    var answers = [];
    var hasError = false;
    var firstMessage = '';
    var firstInvalidIndex = -1;

    for (var i = 0; i < nextQuestions.length; i++) {
      var item = nextQuestions[i];
      var validation = validateQuestion(item);
      nextQuestions[i] = {
        id: item.id,
        index: item.index,
        templateId: item.templateId,
        templateName: item.templateName,
        templateWeight: item.templateWeight,
        templateSortOrder: item.templateSortOrder,
        showTemplateHeader: item.showTemplateHeader,
        showTemplateFooter: item.showTemplateFooter,
        templateFooterScore: item.templateFooterScore,
        templateFooterMax: item.templateFooterMax,
        question: item.question,
        scoreLabel: item.scoreLabel,
        minValue: item.minValue,
        startValue: item.startValue,
        maxValue: item.maxValue,
        stepValue: item.stepValue,
        score: item.score,
        quickScores: item.quickScores,
        errorText: validation.errorText,
        touched: true
      };

      if (!validation.ok) {
        hasError = true;
        if (firstInvalidIndex === -1) firstInvalidIndex = i;
        if (!firstMessage) firstMessage = '第 ' + (i + 1) + ' 题' + validation.errorText;
        continue;
      }

      answers.push({ questionIndex: i, score: Number(item.score) });
    }

    this.setData({ questionList: nextQuestions });

    if (hasError) {
      return { ok: false, message: firstMessage || '请先修正不符合要求的题目', firstInvalidIndex: firstInvalidIndex };
    }
    return { ok: true, answers: answers };
  },

  submitScore: function () {
    var self = this;
    var validation = self.validateAnswers();
    if (!validation.ok) {
      if (Number.isInteger(validation.firstInvalidIndex) && validation.firstInvalidIndex >= 0) {
        self.setData({ currentQuestionIndex: validation.firstInvalidIndex, keyboardCollapsed: false });
        self.syncCurrentQuestion();
        self.scrollToQuestion(validation.firstInvalidIndex);
      }
      wx.showToast({ title: validation.message, icon: 'none' });
      return;
    }

    self.setData({ submitting: true });

    var scorer = self.data.scorer || {};
    wx.cloud.callFunction({
      name: 'submitScoreRecord',
      data: {
        scorerId: scorer.id || '',
        targetId: self.targetId,
        activityId: self.activityId,
        activityName: self.activityName,
        templateConfigSignature: self.templateConfigSignature,
        answers: validation.answers
      },
      success: function (res) {
        var result = res.result || {};
        if (result.status !== 'success') {
          wx.showToast({ title: result.message || '提交评分失败', icon: 'none' });
          self.setData({ submitting: false });
          return;
        }
        wx.showToast({ title: '提交成功', icon: 'success' });
        setTimeout(function () {
          wx.navigateBack({ fail: function () { self.redirectHome(); } });
        }, 1200);
      },
      fail: function () {
        setTimeout(function () {
          wx.cloud.callFunction({
            name: 'getScoreFormData',
            data: { targetId: self.targetId },
            success: function (checkRes) {
              var checkResult = checkRes.result || {};
              if (checkResult.status === 'success' && checkResult.existingRecord) {
                wx.showToast({ title: '提交成功', icon: 'success' });
                setTimeout(function () {
                  wx.navigateBack({ fail: function () { self.redirectHome(); } });
                }, 1200);
                return;
              }
              wx.showToast({ title: '提交评分失败', icon: 'none' });
            },
            fail: function () {
              wx.showToast({ title: '提交评分失败', icon: 'none' });
            }
          });
        }, 500);
        self.setData({ submitting: false });
      }
    });
  },

  redirectHome: function () {
    wx.redirectTo({ url: '/pages/home/home' });
  },

  getKeyboardHeightRpx: function () {
    if (this.data.keyboardCollapsed) return 88;
    if (this.data.keyboardMode === 'numpad') return 594;
    // Quick mode: nav(80) + action(80) + rows + safe-area(34)
    var rowCount = this.data.quickScoreRows.length;
    var quickContent = Math.min(rowCount * 94 + 4, 420);
    return 160 + quickContent + 34;
  },

  scrollToQuestion: function (index) {
    var self = this;
    var selector = '#question-' + index;
    wx.createSelectorQuery()
      .select(selector)
      .boundingClientRect()
      .selectViewport()
      .scrollOffset()
      .exec(function (res) {
        var rect = res[0];
        var scrollInfo = res[1];
        if (!rect || !scrollInfo) {
          wx.pageScrollTo({
            selector: selector,
            duration: 280,
            offsetTop: 200,
            fail: function () {}
          });
          return;
        }

        var windowHeight = wx.getSystemInfoSync().windowHeight;
        var windowWidth = wx.getSystemInfoSync().windowWidth;
        var keyboardRpx = self.getKeyboardHeightRpx();
        var keyboardPx = (windowWidth / 750) * keyboardRpx;
        var visibleHeight = windowHeight - keyboardPx;
        var targetTop = (visibleHeight - rect.height) / 2;
        if (targetTop < 0) targetTop = 0;

        var newScrollTop = Math.max(0, scrollInfo.scrollTop + rect.top - targetTop);
        wx.pageScrollTo({
          scrollTop: newScrollTop,
          duration: 280,
          fail: function () {}
        });
      });
  }
});
