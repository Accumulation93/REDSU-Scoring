function isStepAligned(value, startValue, stepValue) {
  if (!Number.isFinite(stepValue) || stepValue <= 0) {
    return true;
  }

  const diff = (value - startValue) / stepValue;
  return Math.abs(diff - Math.round(diff)) < 1e-8;
}

function buildScoreOptions(minValue, maxValue, startValue, stepValue) {
  const start = Number(startValue);
  const max = Number(maxValue);
  const step = Number(stepValue);
  const list = [];

  if (!Number.isFinite(start) || !Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || start > max) {
    return list;
  }

  for (let value = start; value <= max + 1e-8; value += step) {
    const normalized = Math.round(value * 1000) / 1000;
    list.push(String(normalized));
    if (list.length >= 200) {
      break;
    }
  }

  if (Number(minValue) === 0 && !list.length) {
    list.push('0');
  }

  return list;
}

function validateQuestion(question = {}) {
  const rawScore = String(question.score == null ? '' : question.score).trim();
  if (!rawScore) {
    return {
      ok: false,
      errorText: '请填写分值'
    };
  }

  const score = Number(rawScore);
  if (Number.isNaN(score)) {
    return {
      ok: false,
      errorText: '请输入有效数字'
    };
  }

  if (score < Number(question.startValue)) {
    return {
      ok: false,
      errorText: '低于起评分'
    };
  }

  if (score < Number(question.minValue) || score > Number(question.maxValue)) {
    return {
      ok: false,
      errorText: '超出评分范围'
    };
  }

  if (!isStepAligned(score, Number(question.startValue), Number(question.stepValue))) {
    return {
      ok: false,
      errorText: '不符合步进值'
    };
  }

  return {
    ok: true,
    errorText: ''
  };
}

function normalizeQuestion(item = {}) {
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
    scoreOptions: buildScoreOptions(item.minValue, item.maxValue, item.startValue, item.stepValue),
    errorText: '',
    touched: false
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
    submitting: false,
    hasExistingRecord: false,
    existingRecordText: ''
  },

  onLoad(options) {
    this.targetId = String((options && options.targetId) || '').trim();
    this.loadScoreForm();
  },

  loadScoreForm() {
    if (!this.targetId) {
      wx.showToast({
        title: '缺少被评分人信息',
        icon: 'none'
      });
      this.redirectHome();
      return;
    }

    this.setData({
      loading: true,
      loadFailed: false
    });

    wx.cloud.callFunction({
      name: 'getScoreFormData',
      data: {
        targetId: this.targetId
      },
      success: (res) => {
        const result = res.result || {};
        if (result.status !== 'success') {
          wx.showToast({
            title: result.message || '评分页加载失败',
            icon: 'none'
          });
          this.setData({
            loadFailed: true
          });
          setTimeout(() => this.redirectHome(), 1200);
          return;
        }

        const questionList = (result.templateBundle.questions || []).map((item) => normalizeQuestion(item));

        this.activityId = result.currentActivity ? result.currentActivity.id : '';
        this.activityName = result.currentActivity ? result.currentActivity.name : '';
        this.templateConfigSignature = result.rule ? result.rule.templateConfigSignature : '';

        const hasExistingRecord = !!result.existingRecord;
        const existingRecordText = hasExistingRecord
          ? '已自动加载上次评分，可以直接修改后重新提交'
          : '';

        this.setData({
          scorer: result.scorer,
          target: result.target,
          currentActivity: result.currentActivity || null,
          currentActivityText: result.currentActivity ? result.currentActivity.name : '暂无评分活动',
          questionList,
          hasExistingRecord,
          existingRecordText,
          loading: false,
          loadFailed: false
        });
      },
      fail: () => {
        wx.showToast({
          title: '评分页加载失败',
          icon: 'none'
        });
        this.setData({
          loading: false,
          loadFailed: true
        });
      }
    });
  },

  updateQuestion(index, nextValues = {}) {
    const questions = [...this.data.questionList];
    if (!questions[index]) {
      return;
    }

    const nextQuestion = {
      ...questions[index],
      ...nextValues
    };
    const validation = validateQuestion(nextQuestion);

    questions[index] = {
      ...nextQuestion,
      errorText: validation.errorText
    };

    this.setData({
      questionList: questions
    });
  },

  onScoreInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    this.updateQuestion(index, {
      score: String(e.detail.value || '').trim(),
      touched: true
    });
  },

  onScoreOptionChange(e) {
    const index = Number(e.currentTarget.dataset.index);
    const optionIndex = Number(e.detail.value);
    const question = this.data.questionList[index];
    if (!question) {
      return;
    }

    const optionValue = (question.scoreOptions || [])[optionIndex];
    if (optionValue == null) {
      return;
    }

    this.updateQuestion(index, {
      score: optionValue,
      touched: true
    });
  },

  validateAnswers() {
    const nextQuestions = [...this.data.questionList];
    const answers = [];
    let hasError = false;
    let firstMessage = '';
    let firstInvalidIndex = -1;

    for (let i = 0; i < nextQuestions.length; i += 1) {
      const item = nextQuestions[i];
      const validation = validateQuestion(item);
      nextQuestions[i] = {
        ...item,
        touched: true,
        errorText: validation.errorText
      };

      if (!validation.ok) {
        hasError = true;
        if (firstInvalidIndex === -1) {
          firstInvalidIndex = i;
        }
        if (!firstMessage) {
          firstMessage = `第 ${i + 1} 题${validation.errorText}`;
        }
        continue;
      }

      answers.push({
        questionIndex: i,
        score: Number(item.score)
      });
    }

    this.setData({
      questionList: nextQuestions
    });

    if (hasError) {
      return {
        ok: false,
        message: firstMessage || '请先修正不符合要求的题目',
        firstInvalidIndex
      };
    }

    return {
      ok: true,
      answers
    };
  },

  submitScore() {
    const validation = this.validateAnswers();
    if (!validation.ok) {
      if (Number.isInteger(validation.firstInvalidIndex) && validation.firstInvalidIndex >= 0) {
        this.scrollToQuestion(validation.firstInvalidIndex);
      }
      wx.showToast({
        title: validation.message,
        icon: 'none'
      });
      return;
    }

    this.setData({
      submitting: true
    });

    wx.cloud.callFunction({
      name: 'submitScoreRecord',
      data: {
        targetId: this.targetId,
        activityId: this.activityId,
        activityName: this.activityName,
        templateConfigSignature: this.templateConfigSignature,
        answers: validation.answers
      },
      success: (res) => {
        const result = res.result || {};
        if (result.status !== 'success') {
          wx.showToast({
            title: result.message || '提交评分失败',
            icon: 'none'
          });
          return;
        }

        wx.showToast({
          title: `提交成功，总分 ${result.totalScore}`,
          icon: 'success'
        });

        setTimeout(() => {
          wx.navigateBack({
            fail: () => this.redirectHome()
          });
        }, 1200);
      },
      fail: () => {
        wx.showToast({
          title: '提交评分失败',
          icon: 'none'
        });
      },
      complete: () => {
        this.setData({
          submitting: false
        });
      }
    });
  },

  redirectHome() {
    wx.redirectTo({
      url: '/pages/home/home'
    });
  },

  scrollToQuestion(index) {
    const selector = `#question-${index}`;
    wx.pageScrollTo({
      selector,
      duration: 280,
      offsetTop: 96,
      fail: () => {}
    });
  }
});
